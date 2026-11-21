/**
 * Monochrome Lossless & Hi-Fi Audio Provider for ArchiveTune
 * API Version 1 (QuickJS CommonJS)
 * Author: Viscousity
 */

const SAAVN_API = 'https://www.jiosaavn.com/api.php';
const SAAVN_REFERER = 'https://www.jiosaavn.com/';
const SAAVN_BASE_PARAMS = { _format: 'json', _marker: '0', api_version: '4', ctx: 'web6dot0' };
const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeHtml(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  }).replace(/\s+/g, ' ').trim();
}

function cleanTitle(str) {
  return String(str || '')
    .replace(/\s*\(From\s+"[^"]*"\)\s*$/i, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

function setting(context, key, fallback = '') {
  const value = context?.settings?.[key]?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

async function callSaavn(name, params) {
  try {
    const q = new URLSearchParams(Object.assign({ __call: name }, SAAVN_BASE_PARAMS, params));
    const response = await fetch(`${SAAVN_API}?${q.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'Referer': SAAVN_REFERER,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

/**
 * Searches upstream catalogs for candidate tracks.
 * Returns normalized candidates with accurate title, artist, and duration.
 */
async function searchTracks(query, limit, context) {
  const searchLimit = Math.max(1, Math.min(Number(limit) || 10, 25));
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const candidates = [];
  const seen = new Set();

  // 1. iTunes Search API (High precision catalog metadata & durations)
  try {
    const itunesUrl = 'https://itunes.apple.com/search?term=' + encodeURIComponent(cleanQuery) + '&entity=song&limit=' + searchLimit;
    const response = await fetch(itunesUrl, { headers: { 'Accept': 'application/json' } });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.results)) {
        for (const item of data.results) {
          if (!item.trackName || !item.trackId) continue;
          const id = 'itunes:' + item.trackId;
          if (seen.has(id)) continue;
          seen.add(id);

          const artists = [];
          if (item.artistName) artists.push(String(item.artistName).trim());

          candidates.push({
            id,
            title: String(item.trackName).trim(),
            artists: artists.length ? artists : ['Unknown Artist'],
            album: item.collectionName ? String(item.collectionName).trim() : '',
            durationMs: Number(item.trackTimeMillis) || 0,
            isrc: item.isrc ? String(item.isrc).trim() : null
          });
        }
      }
    }
  } catch (_) {}

  // 2. High-Fidelity Catalog Search
  try {
    const data = await callSaavn('search.getResults', { q: cleanQuery, n: String(searchLimit), p: '1' });
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
  const details = await callSaavn('song.getDetails', { pids: sid });
  if (!details) throw new Error('Details unavailable for song ' + sid);

  const song = (details.songs && details.songs[0]) || details[sid];
  const info = song?.more_info;
  const encrypted = info?.encrypted_media_url;
  if (!encrypted) throw new Error('No encrypted stream token for track ' + sid);

  const requestedQuality = String(quality || 'lossless').toLowerCase();
  const targetBitrate = (requestedQuality === 'low') ? '96' : '320';
  const bitrate = (targetBitrate === '320' && String(info['320kbps']) !== 'true') ? '96' : targetBitrate;

  const tokenData = await callSaavn('song.generateAuthToken', { url: encrypted, bitrate });
  const streamUrl = tokenData?.status === 'success' && tokenData?.auth_url ? tokenData.auth_url : '';
  if (!streamUrl || !/^https?:\/\//.test(streamUrl)) {
    throw new Error('Could not resolve streaming CDN link');
  }

  const expires = Number(streamUrl.match(/[?&]Expires=(\d+)/)?.[1]);
  const stream = {
    url: streamUrl,
    headers: { 'Referer': SAAVN_REFERER },
    mimeType: 'audio/mp4',
    codecs: 'mp4a.40.2',
    bitrate: Number(bitrate) * 1000,
    sampleRate: 44100,
    expiresInSeconds: 3600,
    variant: 'monochrome-' + bitrate + 'k',
    provider: 'Monochrome Hi-Fi'
  };

  if (Number.isFinite(expires) && expires > 0) {
    stream.expiresAtMs = expires * 1000;
  }

  return stream;
}

/**
 * Resolves the direct playable stream URL for the matched track.
 */
async function getTrackStreamUrl(trackId, quality, context) {
  const id = String(trackId || '').trim();
  const track = context?.track || context?.item || {};
  const title = track.title || '';
  const artists = Array.isArray(track.artists) ? track.artists.join(' ') : (track.artist || '');

  // 1. Custom Resolver Endpoint (if configured by the user in module settings)
  const customResolver = setting(context, 'customResolver', '');
  if (customResolver && /^https?:\/\//i.test(customResolver)) {
    try {
      const cleanBase = customResolver.replace(/\/+$/, '');
      const reqUrl = `${cleanBase}/api/stream?id=${encodeURIComponent(id)}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artists)}&quality=${encodeURIComponent(quality || 'lossless')}`;
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
            return {
              url: data.url,
              mimeType: data.mimeType || 'audio/flac',
              codecs: data.codecs || 'flac',
              bitrate: data.bitrate || 1411200,
              sampleRate: data.sampleRate || 44100,
              expiresInSeconds: data.expiresInSeconds || 3600,
              variant: data.variant || 'monochrome-custom-flac',
              provider: data.provider || 'Monochrome FLAC'
            };
          }
        } else {
          return {
            url: res.url || reqUrl,
            mimeType: 'audio/flac',
            codecs: 'flac',
            bitrate: 1411200,
            sampleRate: 44100,
            expiresInSeconds: 3600,
            variant: 'monochrome-custom-flac',
            provider: 'Monochrome FLAC'
          };
        }
      }
    } catch (_) {
      // Safe fallback if custom resolver is unreachable
    }
  }

  // 2. Direct resolution via Saavn ID
  if (id.startsWith('saavn:')) {
    const rawId = id.replace(/^saavn:/, '');
    try {
      return await getStreamFromSaavnId(rawId, quality);
    } catch (_) {}
  }

  // 3. High-Fidelity stream resolution by title & artist
  const query = `${title} ${artists}`.trim();
  if (query) {
    try {
      const searchData = await callSaavn('search.getResults', { q: query, n: '5', p: '1' });
      const results = searchData?.results || [];
      if (results.length > 0) {
        return await getStreamFromSaavnId(results[0].id, quality);
      }
    } catch (_) {}
  }

  // Fallback: search by title only if artist was compound
  if (title) {
    try {
      const searchData = await callSaavn('search.getResults', { q: title, n: '5', p: '1' });
      const results = searchData?.results || [];
      if (results.length > 0) {
        return await getStreamFromSaavnId(results[0].id, quality);
      }
    } catch (_) {}
  }

  throw new Error('Monochrome audio stream could not be resolved for this track.');
}

module.exports = { searchTracks, getTrackStreamUrl };
