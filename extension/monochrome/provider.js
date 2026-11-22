/**
 * Monochrome Audio Provider for ArchiveTune
 * Version: 1.0.3
 *
 * Provides accurate, honest metadata reporting:
 * - 320 kbps AAC progressive streams report audio/mp4, mp4a.40.2, 320 kbps, 44.1 kHz.
 * - Custom resolver FLAC streams report audio/flac, flac, true sample rate.
 */

const SAAVN_API_BASE = 'https://www.jiosaavn.com/api.php';
const SAAVN_REFERER = 'https://www.jiosaavn.com/';

// In-memory cache for low-latency repeats
const metadataCache = new Map();
const streamCache = new Map();

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

function setting(context, key, defaultValue) {
  try {
    const s = context?.settings || context?.module?.settings;
    if (s && s[key] !== undefined && s[key] !== null && s[key] !== '') {
      return s[key];
    }
  } catch (_) {}
  return defaultValue;
}

async function callSaavn(action, params = {}, timeoutMs = 2500) {
  const query = new URLSearchParams({
    __call: action,
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    ...params
  });

  const url = `${SAAVN_API_BASE}?${query.toString()}`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      signal: controller?.signal,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': SAAVN_REFERER,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function searchTracks(query, context) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return [];

  const cleanQuery = cleanTitle(rawQuery);
  const candidates = [];
  const seen = new Set();
  const searchLimit = 5;

  try {
    const data = await callSaavn('search.getResults', { q: cleanQuery, n: String(searchLimit), p: '1' }, 2000);
    if (data && Array.isArray(data.results)) {
      for (const item of data.results) {
        if (!item.title || !item.id) continue;
        const id = 'saavn:' + item.id;
        if (seen.has(id)) continue;
        seen.add(id);

        let artistName = item.subtitle ? item.subtitle.split(' - ')[0].trim() : 'Unknown Artist';
        const title = decodeHtml(cleanTitle(item.title));
        const album = item.more_info?.album ? decodeHtml(String(item.more_info.album)) : '';
        const durationSec = Number(item.more_info?.duration) || 0;

        if (item.more_info?.encrypted_media_url) {
          metadataCache.set(String(item.id), item.more_info);
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
    }
  } catch (_) {}

  return candidates.slice(0, searchLimit);
}

async function getStreamFromSaavnId(sid, quality) {
  let moreInfo = metadataCache.get(sid);

  if (!moreInfo || !moreInfo.encrypted_media_url) {
    const details = await callSaavn('song.getDetails', { pids: sid }, 2000);
    const song = (details?.songs && details.songs[0]) || details?.[sid];
    moreInfo = song?.more_info;
    if (moreInfo) {
      metadataCache.set(sid, moreInfo);
    }
  }

  const encrypted = moreInfo?.encrypted_media_url;
  if (!encrypted) throw new Error('No stream token found for track ' + sid);

  const q = String(quality || 'HIGH_320').toUpperCase();
  const targetBitrate = (q === 'LOW' || q === '96') ? '96' : '320';
  const bitrate = (targetBitrate === '320' && String(moreInfo['320kbps']) !== 'true') ? '96' : targetBitrate;

  const tokenData = await callSaavn('song.generateAuthToken', { url: encrypted, bitrate }, 2000);
  const streamUrl = tokenData?.status === 'success' && tokenData?.auth_url ? tokenData.auth_url : '';
  if (!streamUrl || !/^https?:\/\//.test(streamUrl)) {
    throw new Error('Failed to obtain stream CDN link');
  }

  const expires = Number(streamUrl.match(/[?&]Expires=(\d+)/)?.[1]);
  const numBitrate = Number(bitrate) * 1000;

  // Accurate metadata: this stream is 320 kbps AAC in an MP4 container
  const stream = {
    url: streamUrl,
    headers: { 'Referer': SAAVN_REFERER },
    mimeType: 'audio/mp4',
    codecs: 'mp4a.40.2',
    bitrate: numBitrate,
    sampleRate: 44100,
    expiresInSeconds: 3600,
    variant: `aac-${bitrate}k`,
    provider: `Monochrome CDN (${bitrate} kbps AAC)`
  };

  if (Number.isFinite(expires) && expires > 0) {
    stream.expiresAtMs = expires * 1000;
  }

  return stream;
}

async function getTrackStreamUrl(trackId, quality, context) {
  const q = String(quality || 'HIGH_320').toUpperCase();
  const id = String(trackId || '').trim();
  const cacheKey = `${id}:${q}`;

  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    if (!cached.expiresAtMs || cached.expiresAtMs > Date.now() + 60000) {
      return cached;
    }
  }

  const track = context?.track || context?.item || {};
  const title = track.title || '';
  const artists = Array.isArray(track.artists) ? track.artists.join(' ') : (track.artist || '');

  // 1. Custom Resolver Endpoint (e.g. user self-hosted FLAC proxy)
  const customResolver = setting(context, 'customResolver', '');
  if (customResolver && /^https?:\/\//i.test(customResolver)) {
    try {
      const cleanBase = customResolver.replace(/\/+$/, '');
      const reqUrl = `${cleanBase}/api/stream?id=${encodeURIComponent(id)}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artists)}&quality=${encodeURIComponent(q)}`;
      const res = await fetch(reqUrl, {
        headers: {
          'Accept': 'application/json, audio/flac, */*',
          'User-Agent': 'Monochrome-ArchiveTune/1.0'
        }
      });
      if (res.ok) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('json')) {
          const data = await res.json();
          if (data && data.url) {
            const isFlac = (data.mimeType || '').includes('flac') || (data.codecs || '').includes('flac');
            const stream = {
              url: data.url,
              mimeType: data.mimeType || (isFlac ? 'audio/flac' : 'audio/mp4'),
              codecs: data.codecs || (isFlac ? 'flac' : 'mp4a.40.2'),
              bitrate: data.bitrate || (isFlac ? 1411200 : 320000),
              sampleRate: data.sampleRate || 44100,
              expiresInSeconds: data.expiresInSeconds || 3600,
              variant: data.variant || (isFlac ? 'custom-flac' : 'custom-stream'),
              provider: data.provider || 'Custom Lossless Resolver'
            };
            streamCache.set(cacheKey, stream);
            return stream;
          }
        }
      }
    } catch (_) {}
  }

  // 2. Direct high-speed resolution via Saavn ID
  if (id.startsWith('saavn:')) {
    const rawId = id.replace(/^saavn:/, '');
    try {
      const stream = await getStreamFromSaavnId(rawId, q);
      streamCache.set(cacheKey, stream);
      return stream;
    } catch (_) {}
  }

  // 3. Search resolution by title & artist
  const query = `${title} ${artists}`.trim();
  if (query) {
    try {
      const searchData = await callSaavn('search.getResults', { q: query, n: '3', p: '1' }, 1800);
      const results = searchData?.results || [];
      if (results.length > 0) {
        const stream = await getStreamFromSaavnId(results[0].id, q);
        streamCache.set(cacheKey, stream);
        return stream;
      }
    } catch (_) {}
  }

  // Fallback: title only
  if (title) {
    try {
      const searchData = await callSaavn('search.getResults', { q: title, n: '3', p: '1' }, 1800);
      const results = searchData?.results || [];
      if (results.length > 0) {
        const stream = await getStreamFromSaavnId(results[0].id, q);
        streamCache.set(cacheKey, stream);
        return stream;
      }
    } catch (_) {}
  }

  throw new Error('Audio stream could not be resolved for this track.');
}

module.exports = { searchTracks, getTrackStreamUrl };
