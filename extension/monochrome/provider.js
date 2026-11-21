/**
 * Monochrome Lossless Audio Provider for ArchiveTune
 * API Version 1 (QuickJS CommonJS)
 * Author: Viscousity
 */

function setting(context, key, fallback) {
  const value = context?.settings?.[key]?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Searches upstream catalogs for candidate tracks to match with the current song.
 * Uses public iTunes & Deezer search APIs to extract high-accuracy metadata (Title, Artist, Duration, Album).
 */
async function searchTracks(query, limit, context) {
  const searchLimit = Math.max(1, Math.min(Number(limit) || 10, 25));
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  // Try iTunes Search API first (Fast, comprehensive global catalog, returns millisecond duration)
  try {
    const itunesUrl = 'https://itunes.apple.com/search?term=' + encodeURIComponent(cleanQuery) + '&entity=song&limit=' + searchLimit;
    const response = await fetch(itunesUrl, {
      headers: { 'Accept': 'application/json' }
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.results) && data.results.length > 0) {
        return data.results.map(item => {
          const artists = [];
          if (item.artistName) artists.push(item.artistName.trim());
          
          return {
            id: String(item.trackId),
            title: String(item.trackName || '').trim(),
            artists: artists.length ? artists : ['Unknown Artist'],
            album: item.collectionName ? String(item.collectionName).trim() : '',
            durationMs: Number(item.trackTimeMillis) || 0,
            isrc: item.isrc ? String(item.isrc).trim() : null
          };
        }).filter(t => t.title && t.id);
      }
    }
  } catch (err) {
    // Continue to fallback search
  }

  // Fallback search via Deezer Search API
  try {
    const deezerUrl = 'https://api.deezer.com/search?q=' + encodeURIComponent(cleanQuery) + '&limit=' + searchLimit;
    const response = await fetch(deezerUrl, {
      headers: { 'Accept': 'application/json' }
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.data) && data.data.length > 0) {
        return data.data.map(item => {
          const artists = [];
          if (item.artist?.name) artists.push(item.artist.name.trim());

          return {
            id: String(item.id),
            title: String(item.title || item.title_short || '').trim(),
            artists: artists.length ? artists : ['Unknown Artist'],
            album: item.album?.title ? String(item.album.title).trim() : '',
            duration: Number(item.duration) || 0,
            isrc: null
          };
        }).filter(t => t.title && t.id);
      }
    }
  } catch (err) {
    // Both searches failed
  }

  return [];
}

/**
 * Resolves the direct playable lossless FLAC stream URL for the matched track.
 * Dispatches to configured Monochrome / Lucida nodes.
 */
async function getTrackStreamUrl(trackId, quality, context) {
  const selectedQuality = quality === 'hires' ? 'hires' : 'lossless';
  const track = context?.track || context?.item || {};
  const title = track.title || '';
  const artist = Array.isArray(track.artists) ? track.artists.join(', ') : (track.artist || '');
  const id = String(trackId);

  const primaryResolver = setting(context, 'resolver', 'https://wolf.qqdl.site');
  const fallbackResolver = setting(context, 'fallbackResolver', 'https://maus.qqdl.site');
  const resolvers = [primaryResolver, fallbackResolver].filter(Boolean);

  let lastError = null;

  for (const baseUrl of resolvers) {
    try {
      const cleanBase = baseUrl.replace(/\/+$/, '');
      const reqUrl = `${cleanBase}/api/stream?id=${encodeURIComponent(id)}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&quality=${selectedQuality}`;

      const response = await fetch(reqUrl, {
        headers: {
          'Accept': 'application/json, audio/flac, */*',
          'User-Agent': 'Monochrome-ArchiveTune/1.0'
        }
      });

      if (response.ok) {
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        
        // If the resolver returns a JSON descriptor with direct stream link
        if (contentType.includes('json')) {
          const data = await response.json();
          if (data && data.url) {
            const isHiRes = selectedQuality === 'hires' && (data.sampleRate > 48000 || data.bitDepth > 16);
            return {
              url: data.url,
              mimeType: data.mimeType || 'audio/flac',
              codecs: 'flac',
              bitrate: isHiRes ? 9216000 : 1411200,
              sampleRate: data.sampleRate || (isHiRes ? 96000 : 44100),
              expiresInSeconds: data.expiresInSeconds || 3600,
              variant: isHiRes ? 'monochrome-hires-flac' : 'monochrome-cd-flac',
              provider: 'Monochrome FLAC'
            };
          }
        } else {
          // Direct audio stream redirection
          return {
            url: response.url || reqUrl,
            mimeType: 'audio/flac',
            codecs: 'flac',
            bitrate: selectedQuality === 'hires' ? 9216000 : 1411200,
            sampleRate: selectedQuality === 'hires' ? 96000 : 44100,
            expiresInSeconds: 3600,
            variant: selectedQuality === 'hires' ? 'monochrome-hires-flac' : 'monochrome-cd-flac',
            provider: 'Monochrome FLAC'
          };
        }
      }
    } catch (err) {
      lastError = err;
    }
  }

  // If specific track resolution is pending, return direct fallback stream
  throw new Error('Monochrome FLAC stream unavailable for this track' + (lastError ? ': ' + lastError.message : ''));
}

module.exports = { searchTracks, getTrackStreamUrl };
