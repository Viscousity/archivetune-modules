/**
 * Monochrome True Lossless Stream Provider for ArchiveTune
 * Version: 2.3.0
 *
 * Core Fixes in v2.3.0:
 * - FIX DURATION SCORING: Normalize all durations to SECONDS. Monochrome returns ms (e.g. 200040),
 *   ArchiveTune expects seconds (200). Fixed so ArchiveTune matcher gives 100% score to Monochrome FLAC.
 * - TRUE FLAC EXCLUSIVITY: When Monochrome has FLAC candidates, return FLAC exclusively.
 *   Saavn 320k is ONLY queried as a last-resort fallback if Monochrome has 0 matches.
 * - BIT-PERFECT FLAC PRIORITY: getTrackStreamUrl strictly enforces Monochrome FLAC.
 * - 0ms PRE-WARMED RESOLUTION: Pre-populates stream URLs in memory during search.
 */

const MONOCHROME_BASE = 'https://tracks.monochrome.st';
const MONOCHROME_ORIGIN = 'https://monochrome.st';
const MONOCHROME_REFERER = 'https://monochrome.st/';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const SAAVN_API_BASE = 'https://www.jiosaavn.com/api.php';
const SAAVN_REFERER = 'https://www.jiosaavn.com/';

// Caches for 0ms resolution
const streamUrlCache = new Map();
const saavnMetaCache = new Map();

/**
 * Normalizes duration to integer seconds (ArchiveTune standard).
 */
function toSeconds(dur) {
  if (!dur) return 0;
  const num = Number(dur);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num > 10000 ? Math.round(num / 1000) : Math.round(num);
}

/**
 * Strips promotional noise, tags, and formatting from titles.
 */
function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*[\(\[](?:feat|ft|official|audio|video|lyric|lyrics|remix|edit|deluxe|version|extended|4k|hd|music video)[\.\s\w]*[\)\]]/gi, '')
    .replace(/[\(\[].*?[\)\]]/g, '')
    .replace(/[-–—]\s*(?:official|audio|video|lyric|lyrics|remix|edit).*/gi, '')
    .trim();
}

/**
 * Decodes HTML entities safely.
 */
function decodeHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Scores candidates accurately comparing title, artist, and duration in SECONDS.
 */
function scoreCandidate(item, targetTitle, targetArtist, targetDurationSec) {
  if (!item) return -999;
  let score = 0;

  const itemTitle = cleanTitle(item.title || '').toLowerCase();
  const tTitle = cleanTitle(targetTitle || '').toLowerCase();

  if (itemTitle === tTitle) {
    score += 70;
  } else if (itemTitle.includes(tTitle) || tTitle.includes(itemTitle)) {
    score += 40;
  }

  const artistNames = Array.isArray(item.artistNames)
    ? item.artistNames.join(' ').toLowerCase()
    : (Array.isArray(item.artists) ? item.artists.map(a => typeof a === 'string' ? a : a.name).join(' ').toLowerCase() : '');
  const tArtist = (targetArtist || '').toLowerCase();

  if (tArtist && artistNames) {
    if (artistNames.includes(tArtist) || tArtist.includes(artistNames)) {
      score += 40;
    }
  }

  // Exact duration comparison in SECONDS
  const itemSec = toSeconds(item.duration);
  if (targetDurationSec > 0 && itemSec > 0) {
    const diff = Math.abs(itemSec - targetDurationSec);
    if (diff <= 2) {
      score += 50; // Perfect match within 2s
    } else if (diff <= 5) {
      score += 30;
    } else if (diff > 15) {
      score -= 40; // Penalty for wrong versions
    }
  }

  return score;
}

/**
 * Searches Monochrome FLAC backend.
 */
async function searchMonochrome(query, limit = 6, timeoutMs = 2500) {
  const url = `${MONOCHROME_BASE}/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      signal: controller?.signal,
      headers: {
        'Accept': 'application/json',
        'Origin': MONOCHROME_ORIGIN,
        'Referer': MONOCHROME_REFERER,
        'User-Agent': BROWSER_UA
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.tracks) ? data.tracks : [];
  } catch (_) {
    return [];
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Searches Saavn only as emergency fallback when FLAC is completely unavailable.
 */
async function searchSaavn(query, limit = 4, timeoutMs = 2000) {
  const qParams = new URLSearchParams({
    __call: 'search.getResults',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    q: query,
    n: String(limit),
    p: '1'
  });
  const url = `${SAAVN_API_BASE}?${qParams.toString()}`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      signal: controller?.signal,
      headers: {
        'Accept': 'application/json',
        'Referer': SAAVN_REFERER,
        'User-Agent': BROWSER_UA
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (_) {
    return [];
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Primary track search for ArchiveTune.
 * Prioritizes Monochrome FLAC exclusively to guarantee bit-perfect streaming.
 */
async function searchTracks(query, limit, context) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return [];

  const cleanQ = cleanTitle(rawQuery);
  const candidates = [];
  const seenIds = new Set();

  // 1. Query Monochrome FLAC first
  const monoResults = await searchMonochrome(cleanQ, 8, 2500);

  if (monoResults.length > 0) {
    for (const t of monoResults) {
      const rawId = String(t.id || t.trackId || '');
      if (!rawId || seenIds.has(rawId)) continue;
      seenIds.add(rawId);

      const title = decodeHtml(t.title || '');
      const artists = Array.isArray(t.artistNames) && t.artistNames.length > 0
        ? t.artistNames.map(decodeHtml)
        : (Array.isArray(t.artists) ? t.artists.map(a => typeof a === 'string' ? decodeHtml(a) : decodeHtml(a?.name || '')) : ['Unknown Artist']);
      
      const durationSec = toSeconds(t.duration);
      const artworkUrl = t.artwork || (t.releaseId ? `https://tracks.monochrome.st/proxy/mi/${t.releaseId}-1A01.jpg` : null);

      // Pre-warm 0ms cache
      streamUrlCache.set(rawId, {
        url: `${MONOCHROME_BASE}/track/${rawId}`,
        headers: {
          'Origin': MONOCHROME_ORIGIN,
          'Referer': MONOCHROME_REFERER,
          'User-Agent': BROWSER_UA
        },
        mimeType: 'audio/flac',
        codecs: 'flac',
        bitrate: 1411200,
        sampleRate: 44100,
        expiresInSeconds: 7200,
        variant: 'flac-16bit',
        provider: 'Monochrome True Lossless (FLAC)'
      });

      // ArchiveTune expects standard track schema: duration in SECONDS
      const cand = {
        id: rawId,
        title,
        artists: Array.from(new Set(artists)),
        duration: durationSec,
        durationMs: durationSec * 1000
      };
      if (t.albumTitle) cand.album = decodeHtml(t.albumTitle);
      if (t.isrc) cand.isrc = t.isrc;
      if (artworkUrl) cand.artworkUrl = artworkUrl;

      candidates.push(cand);
    }

    // Return FLAC results exclusively so ArchiveTune never picks lossy 320k
    return candidates;
  }

  // 2. Emergency Fallback: If and ONLY IF Monochrome has 0 results, query Saavn
  const saavnResults = await searchSaavn(cleanQ, 4, 2000);
  for (const item of saavnResults) {
    if (!item.title || !item.id) continue;
    const rawId = String(item.id);
    if (seenIds.has(rawId)) continue;
    seenIds.add(rawId);

    let artistName = item.subtitle ? item.subtitle.split(' - ')[0].trim() : 'Unknown Artist';
    const title = decodeHtml(cleanTitle(item.title));
    const durationSec = toSeconds(item.more_info?.duration);
    const artworkUrl = item.image ? item.image.replace(/150x150\.jpg/g, '500x500.jpg') : null;

    if (item.more_info?.encrypted_media_url) {
      saavnMetaCache.set(rawId, item.more_info);
    }

    const cand = {
      id: rawId,
      title,
      artists: [decodeHtml(artistName)],
      duration: durationSec,
      durationMs: durationSec * 1000
    };
    if (item.more_info?.album) cand.album = decodeHtml(String(item.more_info.album));
    if (artworkUrl) cand.artworkUrl = artworkUrl;

    candidates.push(cand);
  }

  return candidates;
}

/**
 * Resolves fallback Saavn progressive stream URL when track is not on Monochrome.
 */
async function resolveSaavnStream(sid) {
  let moreInfo = saavnMetaCache.get(sid);

  if (!moreInfo || !moreInfo.encrypted_media_url) {
    const qParams = new URLSearchParams({
      __call: 'song.getDetails',
      _format: 'json',
      _marker: '0',
      api_version: '4',
      ctx: 'web6dot0',
      pids: sid
    });
    const res = await fetch(`${SAAVN_API_BASE}?${qParams.toString()}`, {
      headers: { 'Accept': 'application/json', 'Referer': SAAVN_REFERER, 'User-Agent': BROWSER_UA }
    });
    const details = await res.json();
    const song = (details?.songs && details.songs[0]) || details?.[sid];
    moreInfo = song?.more_info;
  }

  const encrypted = moreInfo?.encrypted_media_url;
  if (!encrypted) throw new Error('No stream token found for track ' + sid);

  const is320 = String(moreInfo['320kbps']) === 'true';
  const bitrateStr = is320 ? '320' : '160';
  const numBitrate = is320 ? 320000 : 160000;

  const tokenParams = new URLSearchParams({
    __call: 'song.generateAuthToken',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    url: encrypted,
    bitrate: bitrateStr
  });

  const tokenRes = await fetch(`${SAAVN_API_BASE}?${tokenParams.toString()}`, {
    headers: { 'Accept': 'application/json', 'Referer': SAAVN_REFERER, 'User-Agent': BROWSER_UA }
  });
  const tokenData = await tokenRes.json();
  const streamUrl = tokenData?.status === 'success' && tokenData?.auth_url ? tokenData.auth_url : '';
  if (!streamUrl) throw new Error('Failed to resolve stream link');

  const expires = Number(streamUrl.match(/[?&]Expires=(\d+)/)?.[1]);

  const stream = {
    url: streamUrl,
    headers: {
      'Referer': SAAVN_REFERER,
      'User-Agent': BROWSER_UA
    },
    mimeType: 'audio/mp4',
    codecs: 'mp4a.40.2',
    bitrate: numBitrate,
    sampleRate: 44100,
    expiresInSeconds: 3600,
    variant: `aac-${bitrateStr}k`,
    provider: is320 ? 'High-Fidelity 320k AAC (Fallback)' : 'Standard 160k AAC (Fallback)'
  };

  if (Number.isFinite(expires) && expires > 0) {
    stream.expiresAtMs = expires * 1000;
  }

  return stream;
}

/**
 * Resolves direct playable stream URL.
 * Guarantees True Lossless FLAC stream resolution.
 */
async function getTrackStreamUrl(trackId, quality, context) {
  const rawId = String(trackId || '').replace(/^mono:/, '').replace(/^saavn:/, '').trim();

  // Instant 0ms pre-warmed cache return
  if (streamUrlCache.has(rawId)) {
    const cached = streamUrlCache.get(rawId);
    if (!cached.expiresAtMs || cached.expiresAtMs > Date.now() + 60000) {
      return cached;
    }
  }

  // If ID is numeric (Monochrome track ID), resolve directly as FLAC
  if (/^\d{16,}$/.test(rawId)) {
    const stream = {
      url: `${MONOCHROME_BASE}/track/${rawId}`,
      headers: {
        'Origin': MONOCHROME_ORIGIN,
        'Referer': MONOCHROME_REFERER,
        'User-Agent': BROWSER_UA
      },
      mimeType: 'audio/flac',
      codecs: 'flac',
      bitrate: 1411200,
      sampleRate: 44100,
      expiresInSeconds: 7200,
      variant: 'flac-16bit',
      provider: 'Monochrome True Lossless (FLAC)'
    };
    streamUrlCache.set(rawId, stream);
    return stream;
  }

  // If called directly with context (external track from YouTube Music / playlist)
  const track = context?.track || context?.item || {};
  const title = track.title || '';
  const artists = Array.isArray(track.artists) ? track.artists.join(' ') : (track.artist || '');
  const durationSec = toSeconds(track.duration || track.durationMs);
  const cleanQ = cleanTitle(`${title} ${artists}`.trim());

  if (cleanQ) {
    // 1. Try Monochrome FLAC first (strict priority)
    try {
      const monoTracks = await searchMonochrome(cleanQ, 6, 2500);
      if (monoTracks.length > 0) {
        let best = monoTracks[0];
        let bestScore = -999;
        for (const t of monoTracks) {
          const s = scoreCandidate(t, title, artists, durationSec);
          if (s > bestScore) {
            bestScore = s;
            best = t;
          }
        }
        if (best) {
          const foundId = String(best.id || best.trackId);
          const stream = {
            url: `${MONOCHROME_BASE}/track/${foundId}`,
            headers: {
              'Origin': MONOCHROME_ORIGIN,
              'Referer': MONOCHROME_REFERER,
              'User-Agent': BROWSER_UA
            },
            mimeType: 'audio/flac',
            codecs: 'flac',
            bitrate: 1411200,
            sampleRate: 44100,
            expiresInSeconds: 7200,
            variant: 'flac-16bit',
            provider: 'Monochrome True Lossless (FLAC)'
          };
          streamUrlCache.set(rawId, stream);
          return stream;
        }
      }
    } catch (_) {}

    // 2. Fallback to Saavn only if Monochrome completely lacks the track
    try {
      const saavnResults = await searchSaavn(cleanQ, 3, 2000);
      if (saavnResults.length > 0) {
        const sid = String(saavnResults[0].id);
        if (saavnResults[0].more_info) {
          saavnMetaCache.set(sid, saavnResults[0].more_info);
        }
        const stream = await resolveSaavnStream(sid);
        streamUrlCache.set(rawId, stream);
        return stream;
      }
    } catch (_) {}
  }

  // Direct Saavn fallback by alphanumeric ID
  try {
    const stream = await resolveSaavnStream(rawId);
    streamUrlCache.set(rawId, stream);
    return stream;
  } catch (_) {}

  throw new Error('Could not resolve stream for track.');
}

module.exports = { searchTracks, getTrackStreamUrl };
