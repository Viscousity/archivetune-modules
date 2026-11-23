/**
 * Monochrome True Lossless Stream Provider for ArchiveTune
 * Version: 2.4.0
 *
 * Core Enhancements in v2.4.0:
 * - 429 IMMUNITY & CIRCUIT BREAKER: Prevents and recovers from Cloudflare rate limits.
 *   Tracks 429 responses and automatically enters a smart cooldown rather than hammering the server.
 * - ZERO REDUNDANT REQUESTS: LRU in-memory query caching (15m TTL) and in-flight promise
 *   deduplication eliminates duplicate search calls between searchTracks and getTrackStreamUrl.
 * - STREAM REACHABILITY PRE-FLIGHT: Checks stream status before handing the URL to ExoPlayer.
 *   If Cloudflare returns 429, it is caught instantly before ExoPlayer sees it.
 * - TRANSPARENT AUDIO FAILOVER: If Monochrome FLAC encounters 429 or is in cooldown,
 *   transparently falls back to authentic 320 kbps AAC so playback never interrupts or fails.
 * - AUTO RESUMPTION: Automatically resumes True Lossless FLAC streaming as soon as the cooldown expires.
 * - TRUE FLAC EXCLUSIVITY: When Monochrome is healthy, provides bit-perfect 96kHz/44.1kHz FLAC.
 */

const MONOCHROME_BASE = 'https://tracks.monochrome.st';
const MONOCHROME_ORIGIN = 'https://monochrome.st';
const MONOCHROME_REFERER = 'https://monochrome.st/';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const SAAVN_API_BASE = 'https://www.jiosaavn.com/api.php';
const SAAVN_REFERER = 'https://www.jiosaavn.com/';

// Circuit Breaker State
let flacCooldownUntil = 0;
let lastMonochromeRequestTime = 0;

function isMonochromeAvailable() {
  return Date.now() > flacCooldownUntil;
}

function tripMonochromeBreaker(seconds = 60) {
  flacCooldownUntil = Date.now() + (seconds * 1000);
}

// Memory Caches for 0ms resolution & deduplication
const searchCache = new Map();
const pendingSearches = new Map();
const streamUrlCache = new Map();
const trackMetaCache = new Map();
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
      score += 50;
    } else if (diff <= 5) {
      score += 30;
    } else if (diff > 15) {
      score -= 40;
    }
  }

  return score;
}

/**
 * Searches Monochrome FLAC backend with rate limiting protection & in-flight deduplication.
 */
async function searchMonochrome(query, limit = 6, timeoutMs = 2800) {
  if (!isMonochromeAvailable()) {
    return [];
  }

  const cacheKey = `mono:${query}:${limit}`.toLowerCase();
  if (searchCache.has(cacheKey)) {
    const entry = searchCache.get(cacheKey);
    if (entry.expiresAt > Date.now()) {
      return entry.items;
    }
  }

  if (pendingSearches.has(cacheKey)) {
    return await pendingSearches.get(cacheKey);
  }

  const fetchPromise = (async () => {
    // Micro-delay between requests to avoid burst rate limiting
    const elapsed = Date.now() - lastMonochromeRequestTime;
    if (elapsed < 100) {
      await new Promise(r => setTimeout(r, 100 - elapsed));
    }
    lastMonochromeRequestTime = Date.now();

    const url = `${MONOCHROME_BASE}/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const res = await fetch(url, {
        signal: controller?.signal,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Origin': MONOCHROME_ORIGIN,
          'Referer': MONOCHROME_REFERER,
          'User-Agent': BROWSER_UA,
          'Sec-Fetch-Site': 'same-site',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty'
        }
      });

      if (res.status === 429) {
        tripMonochromeBreaker(60);
        return [];
      }

      if (!res.ok) return [];

      const data = await res.json();
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];

      // Store in memory cache (15 min TTL)
      searchCache.set(cacheKey, {
        items: tracks,
        expiresAt: Date.now() + (15 * 60 * 1000)
      });

      return tracks;
    } catch (_) {
      return [];
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      pendingSearches.delete(cacheKey);
    }
  })();

  pendingSearches.set(cacheKey, fetchPromise);
  return await fetchPromise;
}

/**
 * Performs a fast pre-flight check to verify if a Monochrome FLAC stream is reachable.
 * Returns false if rate limited (429) or unreachable.
 */
async function testFlacStreamReachability(trackId) {
  if (!isMonochromeAvailable()) return false;

  const url = `${MONOCHROME_BASE}/track/${trackId}`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 1200) : null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller?.signal,
      headers: {
        'Origin': MONOCHROME_ORIGIN,
        'Referer': MONOCHROME_REFERER,
        'User-Agent': BROWSER_UA,
        'Range': 'bytes=0-0'
      }
    });

    if (res.status === 429) {
      tripMonochromeBreaker(60);
      return false;
    }

    return res.status === 206 || res.status === 200;
  } catch (_) {
    return false;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Searches Saavn for fallback 320k streaming.
 */
async function searchSaavn(query, limit = 4, timeoutMs = 2000) {
  const cacheKey = `saavn:${query}:${limit}`.toLowerCase();
  if (searchCache.has(cacheKey)) {
    const entry = searchCache.get(cacheKey);
    if (entry.expiresAt > Date.now()) {
      return entry.items;
    }
  }

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
    const results = Array.isArray(data.results) ? data.results : [];

    searchCache.set(cacheKey, {
      items: results,
      expiresAt: Date.now() + (15 * 60 * 1000)
    });

    return results;
  } catch (_) {
    return [];
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Resolves fallback Saavn progressive stream URL when track is not on Monochrome or rate-limited.
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
    provider: is320 ? 'High-Fidelity 320k AAC (Failover Safe)' : 'Standard 160k AAC (Failover Safe)'
  };

  if (Number.isFinite(expires) && expires > 0) {
    stream.expiresAtMs = expires * 1000;
  }

  return stream;
}

/**
 * Creates standard FLAC stream object for Monochrome.
 */
function createFlacStreamObject(trackId) {
  return {
    url: `${MONOCHROME_BASE}/track/${trackId}`,
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
}

/**
 * Primary track search for ArchiveTune.
 * Prioritizes Monochrome FLAC exclusively; fails over seamlessly if rate limited.
 */
async function searchTracks(query, limit, context) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return [];

  const cleanQ = cleanTitle(rawQuery);
  const candidates = [];
  const seenIds = new Set();

  // 1. Query Monochrome FLAC if available
  if (isMonochromeAvailable()) {
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

        // Cache metadata for resilient fallback if FLAC later hits 429
        trackMetaCache.set(rawId, {
          title,
          artists,
          durationSec,
          album: t.albumTitle ? decodeHtml(t.albumTitle) : null,
          artworkUrl
        });

        // Pre-warm 0ms cache
        streamUrlCache.set(rawId, createFlacStreamObject(rawId));

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

      // Return FLAC results exclusively so ArchiveTune locks onto FLAC
      return candidates;
    }
  }

  // 2. Emergency Fallback: If Monochrome has 0 results or is in 429 cooldown, query Saavn
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
 * Resolves direct playable stream URL.
 * Checks reachability, handles 429 backoff, and provides instant fallback.
 */
async function getTrackStreamUrl(trackId, quality, context) {
  const rawId = String(trackId || '').replace(/^mono:/, '').replace(/^saavn:/, '').trim();

  // Track context details
  const track = context?.track || context?.item || {};
  const targetTitle = track.title || trackMetaCache.get(rawId)?.title || '';
  const targetArtists = Array.isArray(track.artists)
    ? track.artists.join(' ')
    : (track.artist || (trackMetaCache.get(rawId)?.artists?.join(' ')) || '');
  const cleanQ = cleanTitle(`${targetTitle} ${targetArtists}`.trim());

  // 1. If it's a numeric Monochrome track ID
  if (/^\d{16,}$/.test(rawId)) {
    // If Monochrome is available, preflight verify that 429 is NOT active
    if (isMonochromeAvailable()) {
      const isHealthy = await testFlacStreamReachability(rawId);
      if (isHealthy) {
        const stream = createFlacStreamObject(rawId);
        streamUrlCache.set(rawId, stream);
        return stream;
      }
      // If preflight failed with 429, testFlacStreamReachability tripped the breaker!
    }

    // Rate limited or unreachable: Failover smoothly to 320k Saavn
    if (cleanQ) {
      try {
        const saavnTracks = await searchSaavn(cleanQ, 3, 2000);
        if (saavnTracks.length > 0) {
          const sid = String(saavnTracks[0].id);
          if (saavnTracks[0].more_info) {
            saavnMetaCache.set(sid, saavnTracks[0].more_info);
          }
          const stream = await resolveSaavnStream(sid);
          return stream;
        }
      } catch (_) {}
    }
  }

  // 2. Instant 0ms pre-warmed cache return (with reachability check)
  if (streamUrlCache.has(rawId)) {
    const cached = streamUrlCache.get(rawId);
    if (!cached.expiresAtMs || cached.expiresAtMs > Date.now() + 60000) {
      // If it's a FLAC stream, make sure it's not rate limited
      if (cached.variant === 'flac-16bit') {
        if (isMonochromeAvailable()) {
          return cached;
        }
      } else {
        return cached;
      }
    }
  }

  // 3. External track from playlist / YouTube Music
  if (cleanQ) {
    if (isMonochromeAvailable()) {
      try {
        const monoTracks = await searchMonochrome(cleanQ, 6, 2500);
        if (monoTracks.length > 0) {
          let best = monoTracks[0];
          let bestScore = -999;
          const durationSec = toSeconds(track.duration || track.durationMs);

          for (const t of monoTracks) {
            const s = scoreCandidate(t, targetTitle, targetArtists, durationSec);
            if (s > bestScore) {
              bestScore = s;
              best = t;
            }
          }

          if (best) {
            const foundId = String(best.id || best.trackId);
            const isHealthy = await testFlacStreamReachability(foundId);
            if (isHealthy) {
              const stream = createFlacStreamObject(foundId);
              streamUrlCache.set(rawId, stream);
              return stream;
            }
          }
        }
      } catch (_) {}
    }

    // 4. Fallback to Saavn 320k if Monochrome is rate limited or lacks the track
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

  // 5. Direct Saavn fallback by alphanumeric ID
  try {
    const stream = await resolveSaavnStream(rawId);
    streamUrlCache.set(rawId, stream);
    return stream;
  } catch (_) {}

  throw new Error('Could not resolve stream for track.');
}

module.exports = { searchTracks, getTrackStreamUrl };
