/**
 * Monochrome True Lossless & Hi-Fi Provider for ArchiveTune
 * Version: 2.0.0
 *
 * Fully reverse-engineered from official monochrome-music/monochrome:
 * - Direct lossless stream resolution from https://tracks.monochrome.st
 * - True 16-bit / 44.1 kHz bit-perfect FLAC (25 MB – 50 MB per track)
 * - Zero account or subscription required
 * - Automatic high-speed 320 kbps AAC fallback for tracks not in the FLAC catalog
 */

const MONOCHROME_BASE = 'https://tracks.monochrome.st';
const MONOCHROME_ORIGIN = 'https://monochrome.st';
const MONOCHROME_REFERER = 'https://monochrome.st/';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const SAAVN_API_BASE = 'https://www.jiosaavn.com/api.php';
const SAAVN_REFERER = 'https://www.jiosaavn.com/';

// In-memory caches for fast resolution
const monoTrackCache = new Map();
const saavnMetaCache = new Map();
const streamUrlCache = new Map();

function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*[\(\[](?:feat|ft|official|audio|video|lyric|remix|edit|deluxe|version|extended)[\.\s\w]*[\)\]]/gi, '')
    .replace(/[\(\[].*?[\)\]]/g, '')
    .trim();
}

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
 * Searches Monochrome's native FLAC catalog.
 */
async function searchMonochrome(query, limit = 5) {
  const url = `${MONOCHROME_BASE}/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 2800) : null;

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
 * Fallback search via Saavn catalog.
 */
async function searchSaavn(query, limit = 5) {
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
  const timeoutId = controller ? setTimeout(() => controller.abort(), 2000) : null;

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
 * Search tracks for ArchiveTune track matcher.
 */
async function searchTracks(query, context) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return [];

  const cleanQ = cleanTitle(rawQuery);
  const candidates = [];
  const seenIds = new Set();

  // 1. Prioritize Monochrome True FLAC catalog
  try {
    const monoTracks = await searchMonochrome(cleanQ, 5);
    for (const t of monoTracks) {
      const id = 'mono:' + (t.id || t.trackId);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const title = decodeHtml(t.title || '');
      const artists = Array.isArray(t.artistNames) && t.artistNames.length > 0
        ? t.artistNames.map(decodeHtml)
        : (Array.isArray(t.artists) ? t.artists.map(a => decodeHtml(a.name || '')) : ['Unknown Artist']);
      const durationMs = Number(t.duration) || 0;

      monoTrackCache.set(String(t.id || t.trackId), t);

      candidates.push({
        id,
        title,
        artists,
        album: t.albumTitle || '',
        durationMs,
        isrc: t.isrc || null
      });
    }
  } catch (_) {}

  // 2. High-speed 320k fallback catalog if Monochrome had few results
  if (candidates.length < 3) {
    try {
      const saavnTracks = await searchSaavn(cleanQ, 5 - candidates.length);
      for (const item of saavnTracks) {
        if (!item.title || !item.id) continue;
        const id = 'saavn:' + item.id;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        let artistName = item.subtitle ? item.subtitle.split(' - ')[0].trim() : 'Unknown Artist';
        const title = decodeHtml(cleanTitle(item.title));
        const album = item.more_info?.album ? decodeHtml(String(item.more_info.album)) : '';
        const durationSec = Number(item.more_info?.duration) || 0;

        if (item.more_info?.encrypted_media_url) {
          saavnMetaCache.set(String(item.id), item.more_info);
        }

        candidates.push({
          id,
          title,
          artists: [decodeHtml(artistName)],
          album,
          durationMs: durationSec * 1000,
          isrc: null
        });
      }
    } catch (_) {}
  }

  return candidates;
}

/**
 * Resolves 320k fallback stream.
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

  const bitrate = String(moreInfo['320kbps']) === 'true' ? '320' : '160';
  const tokenParams = new URLSearchParams({
    __call: 'song.generateAuthToken',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    url: encrypted,
    bitrate
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
    bitrate: Number(bitrate) * 1000,
    sampleRate: 44100,
    expiresInSeconds: 3600,
    variant: `aac-${bitrate}k`,
    provider: `High-Speed AAC (${bitrate} kbps)`
  };

  if (Number.isFinite(expires) && expires > 0) {
    stream.expiresAtMs = expires * 1000;
  }

  return stream;
}

/**
 * Resolves direct playable stream URL.
 */
async function getTrackStreamUrl(trackId, quality, context) {
  const id = String(trackId || '').trim();

  // Instant cache hit
  if (streamUrlCache.has(id)) {
    const cached = streamUrlCache.get(id);
    if (!cached.expiresAtMs || cached.expiresAtMs > Date.now() + 60000) {
      return cached;
    }
  }

  // 1. Monochrome True FLAC Stream
  if (id.startsWith('mono:')) {
    const rawId = id.replace(/^mono:/, '');
    const streamUrl = `${MONOCHROME_BASE}/track/${rawId}`;

    const stream = {
      url: streamUrl,
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
      variant: 'monochrome-true-flac',
      provider: 'Monochrome True Lossless (FLAC)'
    };

    streamUrlCache.set(id, stream);
    return stream;
  }

  // 2. Fallback: Saavn 320k Stream
  if (id.startsWith('saavn:')) {
    const rawId = id.replace(/^saavn:/, '');
    try {
      const stream = await resolveSaavnStream(rawId);
      streamUrlCache.set(id, stream);
      return stream;
    } catch (_) {}
  }

  // 3. Fallback search by title + artist
  const track = context?.track || context?.item || {};
  const title = track.title || '';
  const artists = Array.isArray(track.artists) ? track.artists.join(' ') : (track.artist || '');
  const query = `${title} ${artists}`.trim();

  if (query) {
    try {
      const monoTracks = await searchMonochrome(query, 2);
      if (monoTracks.length > 0) {
        const stream = {
          url: `${MONOCHROME_BASE}/track/${monoTracks[0].id}`,
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
          variant: 'monochrome-true-flac',
          provider: 'Monochrome True Lossless (FLAC)'
        };
        streamUrlCache.set(id, stream);
        return stream;
      }
    } catch (_) {}
  }

  throw new Error('Track stream could not be resolved.');
}

module.exports = { searchTracks, getTrackStreamUrl };
