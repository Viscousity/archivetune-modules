/**
 * Monochrome (Lossless FLAC Engine) for ArchiveTune
 * Version: 3.0.0
 *
 * Parallel Dual-Engine Architecture:
 * - Source A (Primary Hi-Res): Arcod Qobuz Bridge (https://arcod.xyz) — 16-bit/44.1kHz up to 24-bit/192kHz FLAC
 * - Source B (Native Co-Primary/Failover): Monochrome (https://tracks.monochrome.st) — direct 16-bit & 24-bit FLAC
 * - Optional Custom Source C: User-configured binimum/hifi-api instance (full non-preview guard enforced)
 *
 * Latency & Reliability Design:
 * - Parallel race with strict ArchiveTune ModuleTrackMatcher.kt parity check before early-return
 * - Speculative in-search stream ticket / FLAC header overlap (<1.5s typical cold start, 0ms on cache/preload)
 * - Exact binary FLAC STREAMINFO (bytes 0-63) parser for authentic per-track bit-depth, sample rate, size & bitrate
 * - Seamless onPlaybackError recovery ('retry' cross-backend -> 'fallback' cleanly to YouTube Music)
 */

const ARCOD_BASE = 'https://arcod.xyz';
const MONO_BASE = 'https://tracks.monochrome.st';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const POSITIVE_TTL_MS = 20 * 60 * 1000;
const TICKET_TTL_MS = 25 * 60 * 1000;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;
const HEADER_TTL_MS = 4 * 60 * 60 * 1000;
const FAIL_COOLDOWN_MS = 2 * 60 * 1000;

const SEARCH_HARD_TIMEOUT_MS = 6200;
const FALLBACK_SEARCH_TIMEOUT_MS = 3500;
const GRACE_AFTER_FIRST_HIT_MS = 450;
const GRACE_FOR_PRIMARY_ARCOD_MS = 700;
const PREWARM_TAIL_WAIT_MS = 550;
const TICKET_TIMEOUT_MS = 4500;
const PROBE_TIMEOUT_MS = 2800;
const STREAM_DEADLINE_MS = 7500;

// Exact ArchiveTune ModuleTrackMatcher regexes
const RE_BRACKETED_FEATURE = /(?:\(|\[)\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*(?:\)|\])/gi;
const RE_TRAILING_FEATURE = /\s+(?:feat\.?|ft\.?|featuring)\s+.+?(?=\s+[-\u2013\u2014]\s+|[\[(]|$)/gi;
const RE_PRESENTATION = /[\[(]\s*(?:(?:official\s+)?(?:music\s+)?(?:audio|video)|lyrics?|lyric\s+video|hd|hq)\s*[\])]/gi;
const RE_CREDIT_SEP = /\s*(?:,|;|\s+(?:feat\.?|ft\.?|featuring|with)\s+|\s+&\s+)\s*/i;
const RE_SOUNDTRACK_SUFFIX = /\s*[\(\[]\s*from\s+(?:["'\u201c].+?["'\u201d]|the\s+(?:original\s+)?(?:motion\s+picture|film|movie|soundtrack)(?:\s+["'\u201c]?.+?["'\u201d]?)?)\s*[\)\]]/gi;
const RE_METADATA_VERSION_FILLER = /^(?:explicit(?:\s+version)?|clean(?:\s+version)?|album\s+version|single\s+version|original)$/i;
const RE_COMBINING_MARKS = /[\u0300-\u036f]/g;
const RE_WHITESPACE = /\s+/g;

let RE_NON_ALNUM;
try {
  RE_NON_ALNUM = new RegExp('[^\\p{L}\\p{N}]+', 'gu');
} catch (_) {
  RE_NON_ALNUM = /[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0b00-\u0b7f\u0b80-\u0cff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+/gi;
}

const RECORDING_MARKERS = [
  'live', 'remix', 'cover', 'karaoke', 'instrumental', 'acoustic',
  'sped up', 'slowed', 'remaster', 'remastered', 'radio edit',
  'extended', 'demo', 'clean', 'mono', 'stereo'
];
const RECORDING_MARKER_REGEXES = RECORDING_MARKERS.map(
  (m) => new RegExp(`(?:^| )${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`)
);

/**
 * Bounded LRU Map with per-entry expiration so QuickJS stays well inside 32 MiB heap.
 */
class LruCache {
  constructor(maxSize, defaultTtlMs) {
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.map.has(key)) this.map.delete(key);
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
    this.map.set(key, { value, expiresAt });
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }
}

const searchCache = new LruCache(120, POSITIVE_TTL_MS);
const pendingSearches = new Map();
const candidatePairCache = new LruCache(140, POSITIVE_TTL_MS);
const ticketCache = new LruCache(80, TICKET_TTL_MS);
const streamUrlCache = new LruCache(80, POSITIVE_TTL_MS);
const pendingTickets = new Map();
const flacHeaderCache = new LruCache(120, HEADER_TTL_MS);
const resolvedDescriptorCache = new LruCache(120, HEADER_TTL_MS);
const failedBackendCache = new LruCache(100, FAIL_COOLDOWN_MS);
const lastServedSource = new LruCache(100, HEADER_TTL_MS);

/**
 * Unwraps ArchiveTune context.settings values (Kotlin wraps as { value: ... }).
 */
function readSetting(context, key, fallback) {
  const settings = context?.settings;
  if (!settings || typeof settings !== 'object') return fallback;
  const raw = settings[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'value')) {
    return raw.value === undefined || raw.value === null ? fallback : raw.value;
  }
  return raw;
}

function getEffectiveOptions(context, explicitQuality) {
  const qualitySetting = readSetting(context, 'quality', 'HI_RES_24');
  const rawQuality = explicitQuality !== undefined && explicitQuality !== null && explicitQuality !== ''
    ? String(explicitQuality)
    : String(qualitySetting || 'HI_RES_24');

  const sourcePriority = String(readSetting(context, 'sourcePriority', 'auto_fastest') || 'auto_fastest');
  const targetResolution = String(readSetting(context, 'targetResolution', 'auto') || 'auto');
  const fastStartMode = String(readSetting(context, 'fastStartMode', 'instant') || 'instant');
  const normalizeSoundtrackTitles = readSetting(context, 'normalizeSoundtrackTitles', true) !== false;

  let customHifiApiUrl = String(readSetting(context, 'customHifiApiUrl', '') || '').trim();
  if (customHifiApiUrl && !/^https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(customHifiApiUrl)) {
    customHifiApiUrl = '';
  }
  customHifiApiUrl = customHifiApiUrl.replace(/\/+$/, '');

  const wantsHiRes =
    targetResolution === 'strict_hires' ||
    (targetResolution !== 'strict_cd' && !/16|cd|saver/i.test(rawQuality));

  return {
    quality: rawQuality,
    sourcePriority,
    targetResolution,
    fastStartMode,
    normalizeSoundtrackTitles,
    customHifiApiUrl,
    wantsHiRes,
    strictHiRes: targetResolution === 'strict_hires',
    strictCd: targetResolution === 'strict_cd' || rawQuality === 'LOSSLESS_16'
  };
}

function decodeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function toSeconds(dur) {
  if (!dur) return 0;
  const n = Number(dur);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 10000 ? Math.round(n / 1000) : Math.round(n);
}

function toHz(sr) {
  const n = Number(sr);
  if (!Number.isFinite(n) || n <= 0) return 44100;
  return n < 1000 ? Math.round(n * 1000) : Math.round(n);
}

function normalizeFuzzy(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(RE_COMBINING_MARKS, '')
    .replace(RE_NON_ALNUM, ' ')
    .trim()
    .replace(RE_WHITESPACE, ' ');
}

function stripMatcherTitle(value) {
  return String(value || '')
    .replace(RE_BRACKETED_FEATURE, ' ')
    .replace(RE_TRAILING_FEATURE, ' ')
    .replace(RE_PRESENTATION, ' ')
    .trim();
}

function jaroWinklerNormalized(first, second) {
  if (first === second) return 1.0;
  if (!first || !second) return 0.0;

  const matchDistance = Math.max(0, Math.floor(Math.max(first.length, second.length) / 2) - 1);
  const firstMatches = new Uint8Array(first.length);
  const secondMatches = new Uint8Array(second.length);
  let matches = 0;

  for (let i = 0; i < first.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, second.length);
    for (let j = start; j < end; j++) {
      if (secondMatches[j] || first.charCodeAt(i) !== second.charCodeAt(j)) continue;
      firstMatches[i] = 1;
      secondMatches[j] = 1;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < first.length; i++) {
    if (!firstMatches[i]) continue;
    while (!secondMatches[k]) k++;
    if (first.charCodeAt(i) !== second.charCodeAt(k)) transpositions++;
    k++;
  }

  const m = matches;
  const jaro = (m / first.length + m / second.length + (m - transpositions / 2) / m) / 3;
  if (jaro <= 0.7) return jaro;

  let prefix = 0;
  const maxPrefix = Math.min(4, first.length, second.length);
  while (prefix < maxPrefix && first.charCodeAt(prefix) === second.charCodeAt(prefix)) {
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function jaroWinkler(a, b) {
  return jaroWinklerNormalized(normalizeFuzzy(a), normalizeFuzzy(b));
}

/**
 * Exact JavaScript port of ArchiveTune ModuleTrackMatcher.evaluate().
 * Returns { score, accepted, rejection } so race orchestration never false-positives on covers/remixes.
 */
function evaluateTrackMatch(target, cand) {
  if (!cand || !cand.title || !Array.isArray(cand.artists) || cand.artists.length === 0) {
    return { score: 0, accepted: false, rejection: 'METADATA' };
  }

  const targetTitleNorm = normalizeFuzzy(stripMatcherTitle(target.title));
  const candTitleNorm = normalizeFuzzy(stripMatcherTitle(cand.title));
  if (!targetTitleNorm || !candTitleNorm) {
    return { score: 0, accepted: false, rejection: 'METADATA' };
  }

  const titleScore = jaroWinklerNormalized(targetTitleNorm, candTitleNorm);
  const primaryArtistRaw = (target.artists[0] || '').replace(RE_TRAILING_FEATURE, '').trim();

  let artistScore = 0;
  const artistForms = [];
  for (const a of cand.artists) {
    if (!a || !String(a).trim()) continue;
    artistForms.push(String(a));
    for (const part of String(a).split(RE_CREDIT_SEP)) {
      if (part && part.trim()) artistForms.push(part.trim());
    }
  }
  for (const form of artistForms) {
    const s = jaroWinkler(primaryArtistRaw, form);
    if (s > artistScore) artistScore = s;
    if (artistScore === 1.0) break;
  }

  const albumScore = target.album && cand.album ? jaroWinkler(target.album, cand.album) : 0.0;
  const score = titleScore * 0.6 + artistScore * 0.35 + albumScore * 0.05;

  const markerMismatch = RECORDING_MARKER_REGEXES.some(
    (re) => re.test(targetTitleNorm) !== re.test(candTitleNorm)
  );
  if (markerMismatch) return { score, accepted: false, rejection: 'RECORDING' };
  if (titleScore < 0.9) return { score, accepted: false, rejection: 'TITLE' };
  if (artistScore < 0.9) return { score, accepted: false, rejection: 'ARTIST' };
  if (RECORDING_MARKER_REGEXES.some((re) => re.test(targetTitleNorm)) && titleScore !== 1.0) {
    return { score, accepted: false, rejection: 'RECORDING' };
  }
  if (
    typeof target.explicit === 'boolean' &&
    typeof cand.explicit === 'boolean' &&
    target.explicit !== cand.explicit
  ) {
    return { score, accepted: false, rejection: 'EXPLICIT' };
  }
  const candDur = toSeconds(cand.duration || cand.durationMs);
  if (target.durationSec > 0 && candDur > 0) {
    const tol = Math.max(5.0, target.durationSec * 0.05);
    if (Math.abs(target.durationSec - candDur) > tol) {
      return { score, accepted: false, rejection: 'DURATION' };
    }
  }
  if (titleScore !== 1.0 || artistScore !== 1.0) {
    return { score, accepted: false, rejection: 'METADATA' };
  }
  return { score, accepted: true, rejection: null };
}

function extractSongTarget(rawQuery, context) {
  const song = context?.song || null;
  const track = context?.track || context?.item || context?.metadata || null;

  const title = decodeHtml(song?.title || track?.title || rawQuery || '');
  const artists = [];
  const pushArtist = (val) => {
    const text = decodeHtml(typeof val === 'string' ? val : (val?.name || '')).trim();
    if (text && !artists.includes(text)) artists.push(text);
  };

  if (Array.isArray(song?.artists)) {
    song.artists.forEach(pushArtist);
  }
  if (Array.isArray(song?.artistDetails)) {
    song.artistDetails.forEach(pushArtist);
  }
  if (artists.length === 0 && song?.artist) {
    String(song.artist).split(RE_CREDIT_SEP).forEach(pushArtist);
  }
  if (artists.length === 0 && Array.isArray(track?.artists)) {
    track.artists.forEach(pushArtist);
  }
  if (artists.length === 0 && track?.artist) {
    String(track.artist).split(RE_CREDIT_SEP).forEach(pushArtist);
  }

  return {
    title,
    artists,
    album: decodeHtml(song?.album || track?.album || ''),
    durationSec: toSeconds(song?.duration || song?.durationMs || track?.duration || track?.durationMs),
    explicit: typeof song?.explicit === 'boolean'
      ? song.explicit
      : (typeof track?.explicit === 'boolean' ? track.explicit : null)
  };
}

function extractIsrc(input) {
  if (!input) return null;
  if (typeof input === 'object') {
    if (typeof input.isrc === 'string') {
      const cleaned = input.isrc.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(cleaned)) return cleaned;
    }
    return null;
  }
  const m = String(input).match(/\b([A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5})\b/i);
  return m ? m[1].replace(/-/g, '').toUpperCase() : null;
}

function expandArtistAliases(rawArtists) {
  const out = [];
  const add = (s) => {
    const clean = decodeHtml(s).trim();
    if (clean && !out.includes(clean)) out.push(clean);
  };
  for (const artist of rawArtists) {
    add(artist);
    const decoded = decodeHtml(artist).trim();
    if (decoded.includes('-')) {
      add(decoded.replace(/-/g, ' & '));
      add(decoded.replace(/-/g, ' '));
    }
    if (decoded.includes('/')) {
      add(decoded.replace(/\s*\/\s*/g, ' & '));
      decoded.split('/').forEach(add);
    }
  }
  return out.length > 0 ? out : ['Unknown Artist'];
}

function maybeStripSoundtrackSuffix(title, targetTitle, enabled) {
  if (!enabled || !title) return title;
  if (/\bfrom\s+["'\u201c]/i.test(targetTitle || '')) return title;
  const stripped = title.replace(RE_SOUNDTRACK_SUFFIX, ' ').replace(RE_WHITESPACE, ' ').trim();
  return stripped || title;
}

function formatArcodTitle(rawTitle, rawVersion, targetTitle, normalizeSoundtrack) {
  let title = decodeHtml(rawTitle || '');
  const version = decodeHtml(rawVersion || '');
  if (version && !title.toLowerCase().includes(version.toLowerCase())) {
    if (!RE_METADATA_VERSION_FILLER.test(version) ||
        normalizeFuzzy(targetTitle).includes(normalizeFuzzy(version))) {
      title = `${title} (${version})`;
    }
  }
  return maybeStripSoundtrackSuffix(title, targetTitle, normalizeSoundtrack);
}

/**
 * Fetches JSON with AbortController and safe transport error classification.
 */
async function fetchJsonSafe(url, timeoutMs, extraHeaders = {}, externalSignal = null) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  let externalAborted = false;

  const onExternalAbort = () => {
    externalAborted = true;
    try { controller?.abort(); } catch (_) {}
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      return { ok: false, aborted: true, status: 0, data: null };
    }
    externalSignal.addEventListener('abort', onExternalAbort);
  }

  const timerId = controller && timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch (_) {}
      }, Math.min(timeoutMs, 14500))
    : null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller?.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': BROWSER_UA,
        ...extraHeaders
      }
    });
    if (!res.ok) {
      return { ok: false, aborted: false, status: res.status, data: null };
    }
    const data = await res.json();
    return { ok: true, aborted: false, status: res.status, data };
  } catch (_) {
    return {
      ok: false,
      aborted: externalAborted,
      timedOut,
      status: 0,
      data: null
    };
  } finally {
    if (timerId) clearTimeout(timerId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Parses binary FLAC STREAMINFO (bytes 0..41) from an ArrayBuffer.
 */
function parseFlacStreamInfo(buffer) {
  if (!buffer || buffer.byteLength < 42) return null;
  const bytes = new Uint8Array(buffer);
  // Check 'fLaC' magic [102, 76, 97, 67]
  if (bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) {
    return null;
  }
  const si = bytes.subarray(8, 42);
  const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] >> 1) & 0x7) + 1;
  const bitDepth = (((si[12] & 0x1) << 4) | (si[13] >> 4)) + 1;
  const totalSamples =
    (si[13] & 0x0f) * 4294967296 +
    (((si[14] << 24) >>> 0) + (si[15] << 16) + (si[16] << 8) + si[17]);
  if (!sampleRate || sampleRate < 8000) return null;
  const durationSec = totalSamples > 0 ? totalSamples / sampleRate : 0;
  return { sampleRate, channels, bitDepth, totalSamples, durationSec };
}

function parseContentRangeTotal(headerVal) {
  if (!headerVal) return 0;
  const m = String(headerVal).match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) || 0 : 0;
}

/**
 * Estimates lossless FLAC bitrate safely without exaggerating bit-depth.
 */
function estimateFlacBitrate(sampleRate, bitDepth, channels = 2) {
  const sr = toHz(sampleRate || 44100);
  const bd = bitDepth >= 24 ? 24 : 16;
  const rawPcm = sr * bd * channels;
  // Average real FLAC compression factor is ~0.62 of raw PCM
  return Math.round(rawPcm * 0.62);
}

function awaitWithFreshTimeout(promise, timeoutMs, fallbackValue) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise((resolve) => {
    let settled = false;
    const tid = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallbackValue);
      }
    }, Math.min(timeoutMs, 14500));
    promise.then(
      (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(tid);
          resolve(val);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(tid);
          resolve(fallbackValue);
        }
      }
    );
  });
}

/**
 * Probes first 64 bytes of a FLAC URL to confirm live HTTP 200/206 + exact FLAC STREAMINFO.
 */
async function probeFlacHeader(url, timeoutMs = PROBE_TIMEOUT_MS, headers = {}) {
  const cached = flacHeaderCache.get(url);
  if (cached) return cached;

  const inflightKey = `probe:${url}`;
  if (pendingTickets.has(inflightKey)) {
    return await awaitWithFreshTimeout(pendingTickets.get(inflightKey), timeoutMs, { ok: false, status: 0 });
  }

  const work = (async () => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timerId = controller && timeoutMs > 0
      ? setTimeout(() => { try { controller.abort(); } catch (_) {} }, Math.min(timeoutMs, 14500))
      : null;

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller?.signal,
        headers: {
          Range: 'bytes=0-63',
          Accept: '*/*',
          'User-Agent': BROWSER_UA,
          ...headers
        }
      });
      if (res.status !== 200 && res.status !== 206) {
        const failInfo = { ok: false, status: res.status };
        if (res.status >= 400) flacHeaderCache.set(url, failInfo, 90000);
        return failInfo;
      }

      const buf = await res.arrayBuffer();
      const si = parseFlacStreamInfo(buf);
      if (!si) {
        const badMagic = { ok: false, status: res.status, invalidMagic: true };
        flacHeaderCache.set(url, badMagic, 90000);
        return badMagic;
      }

      const contentLength =
        parseContentRangeTotal(res.headers?.get?.('content-range')) ||
        (res.status === 200 ? Number(res.headers?.get?.('content-length') || 0) : 0);

      const bitrate =
        contentLength > 0 && si.durationSec > 0
          ? Math.round((contentLength * 8) / si.durationSec)
          : estimateFlacBitrate(si.sampleRate, si.bitDepth, si.channels);

      const info = {
        ok: true,
        status: res.status,
        sampleRate: si.sampleRate,
        bitDepth: si.bitDepth,
        channels: si.channels,
        durationSec: si.durationSec,
        contentLength,
        bitrate
      };
      flacHeaderCache.set(url, info);
      return info;
    } catch (_) {
      return { ok: false, status: 0 };
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  })();

  pendingTickets.set(inflightKey, work);
  work.finally(() => {
    if (pendingTickets.get(inflightKey) === work) pendingTickets.delete(inflightKey);
  });
  return await work;
}

function computeQualityLabel(sourceName, bitDepth, sampleRate) {
  const srKhz = (sampleRate / 1000).toFixed(1).replace(/\.0$/, '');
  const isHiRes = bitDepth >= 24 || sampleRate > 48000;
  const tier = isHiRes ? 'Studio Master' : 'CD Lossless';
  return `${sourceName} ${tier} (${bitDepth}-bit / ${srKhz} kHz FLAC)`;
}

function extractArcodArtists(item) {
  const names = [];
  const primary = item.performer?.name || item.artist?.name || '';
  if (primary) names.push(primary);
  if (typeof item.performers === 'string' && item.performers) {
    const segs = item.performers.split(' - ');
    for (const seg of segs) {
      if (names.length >= 8) break;
      if (!/\b(?:MainArtist|FeaturedArtist|Vocalist|Artist)\b/i.test(seg) &&
          !(/\bAssociatedPerformer\b/i.test(seg) && /&/.test(seg))) {
        continue;
      }
      const cleanName = seg
        .replace(/\s*,\s*(?:MainArtist|FeaturedArtist|AssociatedPerformer|Performer|Artist|Vocalist|Composer|Lyricist|Producer|CoProducer|RecordingEngineer|Engineer|Author|Mixer|Mastering|Featuring)\b.*$/i, '')
        .trim();
      if (cleanName && !names.includes(cleanName)) {
        names.push(cleanName);
      }
    }
  }
  return expandArtistAliases(names);
}

/**
 * Queries Arcod (Qobuz bridge) search endpoint.
 */
async function queryArcod(query, target, opts, timeoutMs, signal) {
  const url = `${ARCOD_BASE}/api/search?q=${encodeURIComponent(query)}&limit=15`;
  const resp = await fetchJsonSafe(url, timeoutMs, {}, signal);
  if (!resp.ok) {
    return { source: 'arcod', ok: false, transportError: !resp.aborted, status: resp.status, items: [] };
  }
  const rawItems = Array.isArray(resp.data?.data?.tracks?.items) ? resp.data.data.tracks.items : [];
  const items = [];
  for (const item of rawItems) {
    if (!item || !item.id || item.streamable === false) continue;
    const rawId = String(item.id);
    const title = formatArcodTitle(item.title, item.version, target.title, opts.normalizeSoundtrackTitles);
    if (!title) continue;
    const artists = extractArcodArtists(item);
    const duration = toSeconds(item.duration);
    const album = decodeHtml(item.album?.title || '');
    const explicit = typeof item.parental_warning === 'boolean' ? item.parental_warning : undefined;
    const artwork = item.album?.image?.large || item.album?.image?.small || undefined;

    const maxBitDepth = Number(item.maximum_bit_depth) >= 24 || item.hires === true ? 24 : 16;
    const maxSampleRate = toHz(item.maximum_sampling_rate || 44.1);

    const cand = {
      id: `ar:${rawId}`,
      source: 'arcod',
      rawId,
      title,
      artists,
      duration,
      durationMs: duration * 1000,
      meta: { bitDepth: maxBitDepth, sampleRate: maxSampleRate, durationSec: duration, isrc: item.isrc || null }
    };
    if (album) cand.album = album;
    if (item.isrc) cand.isrc = String(item.isrc);
    if (explicit !== undefined) cand.explicit = explicit;
    if (artwork && /^https?:\/\//i.test(artwork)) cand.artworkUrl = artwork;

    const matchEval = evaluateTrackMatch(target, cand);
    cand._match = matchEval;
    items.push(cand);
  }
  return { source: 'arcod', ok: true, transportError: false, status: 200, items };
}

/**
 * Queries Monochrome tracks API search endpoint.
 */
async function queryMonochrome(query, target, opts, timeoutMs, signal) {
  const url = `${MONO_BASE}/search/tracks?q=${encodeURIComponent(query)}&limit=12`;
  const resp = await fetchJsonSafe(url, timeoutMs, {}, signal);
  if (!resp.ok) {
    return { source: 'mono', ok: false, transportError: !resp.aborted, status: resp.status, items: [] };
  }
  const rawItems = Array.isArray(resp.data?.tracks) ? resp.data.tracks : [];
  const items = [];
  for (const item of rawItems) {
    if (!item || item.playable === false) continue;
    const rawId = String(item.trackId || item.id || '');
    if (!rawId) continue;
    const rawArtists = Array.isArray(item.artistNames) && item.artistNames.length > 0
      ? item.artistNames
      : (Array.isArray(item.artists) ? item.artists.map((a) => typeof a === 'string' ? a : (a?.name || '')) : []);
    const artists = expandArtistAliases(rawArtists);
    const title = maybeStripSoundtrackSuffix(decodeHtml(item.title || ''), target.title, opts.normalizeSoundtrackTitles);
    if (!title) continue;
    const duration = toSeconds(item.duration);
    const explicit = typeof item.explicit === 'boolean' ? item.explicit : undefined;
    const artwork = item.artwork || (item.releaseId ? `${MONO_BASE}/proxy/mi/${item.releaseId}-1A01.jpg` : undefined);

    const cand = {
      id: `mc:${rawId}`,
      source: 'mono',
      rawId,
      title,
      artists,
      duration,
      durationMs: duration * 1000,
      meta: { bitDepth: 16, sampleRate: 44100, durationSec: duration, isrc: item.isrc || null }
    };
    if (item.albumTitle) cand.album = decodeHtml(item.albumTitle);
    if (item.isrc) cand.isrc = String(item.isrc);
    if (explicit !== undefined) cand.explicit = explicit;
    if (artwork) cand.artworkUrl = artwork;

    const matchEval = evaluateTrackMatch(target, cand);
    cand._match = matchEval;
    items.push(cand);
  }
  return { source: 'mono', ok: true, transportError: false, status: 200, items };
}

/**
 * Optionally queries user-provided custom binimum/hifi-api URL.
 */
async function queryCustomHifi(baseUrl, query, target, opts, timeoutMs, signal) {
  if (!baseUrl) return { source: 'hifi', ok: true, transportError: false, status: 200, items: [] };
  const url = `${baseUrl}/search/?s=${encodeURIComponent(query)}&limit=10`;
  const resp = await fetchJsonSafe(url, timeoutMs, { 'x-client': 'BiniLossless/v3.4' }, signal);
  if (!resp.ok) {
    return { source: 'hifi', ok: false, transportError: !resp.aborted, status: resp.status, items: [] };
  }
  const rawItems = resp.data?.data?.items || resp.data?.items || [];
  const items = [];
  for (const item of rawItems) {
    if (!item || !item.id || !item.title) continue;
    const rawId = String(item.id);
    const title = maybeStripSoundtrackSuffix(decodeHtml(item.title), target.title, opts.normalizeSoundtrackTitles);
    const rawArtists = [];
    if (item.artist?.name) rawArtists.push(item.artist.name);
    if (Array.isArray(item.artists)) {
      item.artists.forEach((a) => rawArtists.push(typeof a === 'string' ? a : (a?.name || '')));
    }
    const artists = expandArtistAliases(rawArtists);
    const duration = toSeconds(item.duration);
    const explicit = typeof item.explicit === 'boolean' ? item.explicit : undefined;
    const hiRes =
      item.audioQuality === 'HI_RES_LOSSLESS' ||
      item.audioQuality === 'HI_RES' ||
      (Array.isArray(item.mediaMetadata?.tags) && item.mediaMetadata.tags.includes('HIRES_LOSSLESS'));

    const cand = {
      id: `hf:${rawId}`,
      source: 'hifi',
      rawId,
      title,
      artists,
      duration,
      durationMs: duration * 1000,
      meta: { bitDepth: hiRes ? 24 : 16, sampleRate: hiRes ? 96000 : 44100, durationSec: duration, isrc: item.isrc || null }
    };
    if (item.album?.title) cand.album = decodeHtml(item.album.title);
    if (item.isrc) cand.isrc = String(item.isrc);
    if (explicit !== undefined) cand.explicit = explicit;

    cand._match = evaluateTrackMatch(target, cand);
    items.push(cand);
  }
  return { source: 'hifi', ok: true, transportError: false, status: 200, items };
}

function getArcodQualityChain(arcodMeta, opts) {
  if (opts.strictCd) return [6];
  if (arcodMeta && arcodMeta.bitDepth <= 16 && !opts.strictHiRes) return [6];
  const lowerTail = opts.strictHiRes ? [] : [6];
  if (arcodMeta && arcodMeta.bitDepth >= 24 && arcodMeta.sampleRate > 96000) {
    return [27, 7, ...lowerTail];
  }
  if (arcodMeta && arcodMeta.bitDepth >= 24 && arcodMeta.sampleRate <= 96000) {
    return [7, 27, ...lowerTail];
  }
  return [27, 7, ...lowerTail];
}

function chooseArcodQualityCode(arcodMeta, opts) {
  return getArcodQualityChain(arcodMeta, opts)[0];
}

/**
 * Fetches Arcod signed player stream URL, deduplicated & cacheable across search -> stream handoff.
 */
async function fetchArcodTicket(rawId, qualityCode, timeoutMs = TICKET_TIMEOUT_MS) {
  const key = `ar:${rawId}:${qualityCode}`;
  const cached = ticketCache.get(key);
  if (cached && cached.expiresAtMs > Date.now() + 60000) {
    return { ok: true, streamUrl: cached.url, fromCache: true };
  }
  if (pendingTickets.has(key)) {
    return await awaitWithFreshTimeout(pendingTickets.get(key), timeoutMs, { ok: false, status: 0, streamUrl: '' });
  }

  const work = (async () => {
    const resp = await fetchJsonSafe(`${ARCOD_BASE}/api/player/stream/${encodeURIComponent(rawId)}?quality=${qualityCode}`, timeoutMs);
    const streamUrl = resp.ok ? resp.data?.url : '';
    if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) {
      return { ok: false, status: resp.status, streamUrl: '' };
    }
    ticketCache.set(key, { url: streamUrl, expiresAtMs: Date.now() + TICKET_TTL_MS });
    return { ok: true, status: 200, streamUrl };
  })();

  pendingTickets.set(key, work);
  work.finally(() => {
    if (pendingTickets.get(key) === work) pendingTickets.delete(key);
  });
  return await work;
}

/**
 * Picks highest-fidelity (and highest-scoring) accepted candidate from a source result list.
 * Because all accepted candidates already passed exact 1.0 title & artist matching,
 * prioritize true 24-bit/Hi-Res over minor album suffix score differences (e.g. "(Explicit Version)").
 */
function pickAcceptedWinner(items, preferHiRes = true) {
  const accepted = items.filter((c) => c._match?.accepted);
  if (accepted.length === 0) return null;
  accepted.sort((a, b) => {
    if (preferHiRes) {
      const bdDiff = (b.meta?.bitDepth || 16) - (a.meta?.bitDepth || 16);
      if (bdDiff !== 0) return bdDiff;
      const srDiff = (b.meta?.sampleRate || 44100) - (a.meta?.sampleRate || 44100);
      if (srDiff !== 0) return srDiff;
    }
    const scoreDiff = (b._match?.score || 0) - (a._match?.score || 0);
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
    return 0;
  });
  return accepted[0];
}

function buildCleanSearchQuery(rawQuery, target) {
  const base = stripMatcherTitle(rawQuery || `${target.title} ${target.artists[0] || ''}`.trim());
  return base.replace(RE_WHITESPACE, ' ').trim();
}

function stripCandidateInternals(cand) {
  const out = {
    id: cand.id,
    title: cand.title,
    artists: cand.artists,
    duration: cand.duration,
    durationMs: cand.durationMs
  };
  if (cand.album) out.album = cand.album;
  if (cand.isrc) out.isrc = cand.isrc;
  if (cand.explicit !== undefined) out.explicit = cand.explicit;
  if (cand.artworkUrl) out.artworkUrl = cand.artworkUrl;
  return out;
}

/**
 * Parallel race coordinator: overlaps Arcod & Monochrome search,
 * returns as soon as preferred match + optional grace settles,
 * and pre-warms stream tickets/probes before returning to ArchiveTune!
 */
async function searchTracks(query, limit, context) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return [];

  const opts = getEffectiveOptions(context);
  const target = extractSongTarget(rawQuery, context);
  const cleanQ = buildCleanSearchQuery(rawQuery, target);
  if (!cleanQ) return [];

  const cacheKey = `${opts.sourcePriority}|${opts.targetResolution}|${opts.quality}|${opts.normalizeSoundtrackTitles ? 1 : 0}|${opts.customHifiApiUrl}|${normalizeFuzzy(cleanQ)}|${target.durationSec}|${target.explicit}`;
  const cached = searchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (pendingSearches.has(cacheKey)) {
    return await pendingSearches.get(cacheKey);
  }

  const runSearch = async () => {
    const startMs = Date.now();
    const useArcod = opts.sourcePriority !== 'mono_only';
    const useMono = opts.sourcePriority !== 'arcod_only';
    const useCustomHifi = Boolean(opts.customHifiApiUrl);

    const raceSources = async (searchQ, timeoutMs) => {
      const controllers = {};
      const tasks = [];

      const launch = (name, fn) => {
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (ac) controllers[name] = ac;
        const p = fn(ac?.signal).then((res) => ({ name, res }));
        tasks.push(p);
        return p;
      };

      if (useArcod) launch('arcod', (sig) => queryArcod(searchQ, target, opts, timeoutMs, sig));
      if (useMono) launch('mono', (sig) => queryMonochrome(searchQ, target, opts, timeoutMs, sig));
      if (useCustomHifi) launch('hifi', (sig) => queryCustomHifi(opts.customHifiApiUrl, searchQ, target, opts, timeoutMs, sig));

      const resultsBySource = {};
      const prewarmBySource = {};
      let firstWinner = null;

      await new Promise((resolve) => {
        let remaining = tasks.length;
        let graceTimer = null;
        let finished = false;

        const finishNow = () => {
          if (finished) return;
          finished = true;
          if (graceTimer) clearTimeout(graceTimer);
          resolve();
        };

        if (remaining === 0) {
          finishNow();
          return;
        }

        tasks.forEach((task) => {
          task.then(({ name, res }) => {
            if (finished) return;
            resultsBySource[name] = res;
            remaining--;

            const winner = res.ok ? pickAcceptedWinner(res.items, opts.wantsHiRes) : null;
            if (winner) {
              if (!firstWinner) firstWinner = { name, winner };
              // Immediately overlap stream resolution for every valid primary source inside the grace window
              if (name === 'arcod' && !prewarmBySource.arcod && opts.sourcePriority !== 'mono_only') {
                if (opts.sourcePriority !== 'mono_first' || !firstWinner || firstWinner.name === 'arcod') {
                  const qCode = chooseArcodQualityCode(winner.meta, opts);
                  prewarmBySource.arcod = fetchArcodTicket(winner.rawId, qCode, TICKET_TIMEOUT_MS).then((tk) => {
                    if (tk?.ok && tk.streamUrl) {
                      return probeFlacHeader(tk.streamUrl, 1600).then(() => tk);
                    }
                    return tk;
                  });
                }
              } else if (name === 'mono' && !prewarmBySource.mono && opts.sourcePriority !== 'arcod_only') {
                if (!prewarmBySource.arcod) {
                  prewarmBySource.mono = probeFlacHeader(`${MONO_BASE}/track/${winner.rawId}`, PROBE_TIMEOUT_MS);
                }
              }
            }

            if (remaining === 0) {
              finishNow();
              return;
            }

            if (winner) {
              // Fast-return heuristic: how long to give remaining sources?
              const isArcodPreferredDone =
                name === 'arcod' && (opts.sourcePriority === 'arcod_first' || opts.sourcePriority === 'auto_fastest');
              const isMonoPreferredDone =
                name === 'mono' && opts.sourcePriority === 'mono_first';

              if (isArcodPreferredDone && (winner.meta?.bitDepth >= 24 || !opts.wantsHiRes || opts.strictCd)) {
                // Wait just up to 450ms (which overlaps with the prewarm ticket anyway!) for Monochrome backup
                if (!graceTimer) graceTimer = setTimeout(finishNow, GRACE_AFTER_FIRST_HIT_MS);
              } else if (isMonoPreferredDone) {
                if (!graceTimer) graceTimer = setTimeout(finishNow, GRACE_AFTER_FIRST_HIT_MS);
              } else if (!graceTimer) {
                // e.g. Monochrome settled first in arcod_first/auto_fastest — give Arcod Hi-Res slightly longer
                const graceMs = name === 'mono' && (opts.sourcePriority === 'arcod_first' || opts.sourcePriority === 'auto_fastest')
                  ? GRACE_FOR_PRIMARY_ARCOD_MS
                  : GRACE_AFTER_FIRST_HIT_MS;
                graceTimer = setTimeout(finishNow, graceMs);
              }
            }
          });
        });
      });

      // Wait briefly only on the highest-priority prewarm so first playback hits 0ms cache
      const chosenPrewarm = opts.sourcePriority === 'mono_first'
        ? (prewarmBySource.mono || prewarmBySource.arcod)
        : (prewarmBySource.arcod || prewarmBySource.mono);
      if (chosenPrewarm) {
        let waitTid = null;
        await Promise.race([
          chosenPrewarm.catch(() => null),
          new Promise((r) => { waitTid = setTimeout(r, PREWARM_TAIL_WAIT_MS); })
        ]);
        if (waitTid) clearTimeout(waitTid);
      }

      // Abort any lagging searches ONLY when we already have an accepted match so requestProblem stays clean when 0 results
      const hasAnyAccepted = Object.values(resultsBySource).some(
        (r) => r.ok && r.items.some((i) => i._match?.accepted)
      );
      if (hasAnyAccepted) {
        Object.entries(controllers).forEach(([src, ac]) => {
          if (!resultsBySource[src]) {
            try { ac.abort(); } catch (_) {}
          }
        });
      }

      return resultsBySource;
    };

    let bySource = await raceSources(cleanQ, SEARCH_HARD_TIMEOUT_MS);

    // Optional fallback query ONLY if zero accepted candidates AND cleanQ differs from bare title + primary artist AND budget remains
    const gatherAll = (sourceMap) => {
      const all = [];
      Object.values(sourceMap).forEach((r) => {
        if (r?.ok && Array.isArray(r.items)) all.push(...r.items);
      });
      return all;
    };

    let allItems = gatherAll(bySource);
    let anyAccepted = allItems.some((c) => c._match?.accepted);

    const simpleQ = `${stripMatcherTitle(target.title)} ${target.artists[0] || ''}`.replace(RE_WHITESPACE, ' ').trim();
    const detectedIsrc = extractIsrc(rawQuery) || extractIsrc(context?.track);
    if (!anyAccepted && (Date.now() - startMs) < 6200) {
      if (detectedIsrc && useMono) {
        const isrcRes = await queryMonochrome(`isrc:${detectedIsrc}`, target, opts, FALLBACK_SEARCH_TIMEOUT_MS);
        if (isrcRes.ok && isrcRes.items.length > 0) {
          bySource.mono = isrcRes;
          allItems = gatherAll(bySource);
          anyAccepted = allItems.some((c) => c._match?.accepted);
        }
      } else if (simpleQ && normalizeFuzzy(simpleQ) !== normalizeFuzzy(cleanQ)) {
        bySource = await raceSources(simpleQ, FALLBACK_SEARCH_TIMEOUT_MS);
        allItems = gatherAll(bySource);
        anyAccepted = allItems.some((c) => c._match?.accepted);
      }
    }

    const arcodWinner = pickAcceptedWinner(bySource.arcod?.items || [], opts.wantsHiRes);
    const monoWinner = pickAcceptedWinner(bySource.mono?.items || [], opts.wantsHiRes);
    const hifiWinner = pickAcceptedWinner(bySource.hifi?.items || [], opts.wantsHiRes);

    // Determine primary source according to settings & actual fidelity
    let orderedWinners = [];
    if (opts.sourcePriority === 'mono_first') {
      orderedWinners = [monoWinner, arcodWinner, hifiWinner].filter(Boolean);
    } else if (opts.sourcePriority === 'arcod_first' || opts.sourcePriority === 'auto_fastest') {
      if (opts.strictHiRes && !arcodWinner && monoWinner) {
        orderedWinners = [monoWinner, hifiWinner].filter(Boolean);
      } else {
        orderedWinners = [arcodWinner, monoWinner, hifiWinner].filter(Boolean);
      }
    } else {
      orderedWinners = [arcodWinner, monoWinner, hifiWinner].filter(Boolean);
    }

    const out = [];
    const seenIds = new Set();
    const arcodAlts = (bySource.arcod?.items || [])
      .filter((c) => c._match?.accepted && arcodWinner && c.rawId !== arcodWinner.rawId)
      .sort((a, b) => (b.meta?.bitDepth || 16) - (a.meta?.bitDepth || 16))
      .slice(0, 2)
      .map((c) => ({ rawId: c.rawId, meta: c.meta }));
    const pairBundle = {
      target,
      arcod: arcodWinner ? { rawId: arcodWinner.rawId, meta: arcodWinner.meta } : null,
      arcodAlts,
      mono: monoWinner ? { rawId: monoWinner.rawId, meta: monoWinner.meta } : null,
      hifi: hifiWinner ? { rawId: hifiWinner.rawId, meta: hifiWinner.meta } : null,
      searchedArcod: Boolean(bySource.arcod),
      searchedMono: Boolean(bySource.mono)
    };

    if (orderedWinners.length > 0) {
      const primaryWinner = orderedWinners[0];
      const minOutBitDepth = opts.wantsHiRes ? (primaryWinner.meta?.bitDepth || 16) : 16;
      // Filter out lower-bit-depth duplicates so Kotlin maxByOrNull { albumScore } never downgrades 24-bit -> 16-bit
      const primaryList = (bySource[primaryWinner.source]?.items || []).filter(
        (c) => c._match?.accepted && (c.meta?.bitDepth || 16) >= minOutBitDepth
      );
      for (const c of [primaryWinner, ...primaryList]) {
        if (seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        candidatePairCache.set(c.id, pairBundle);
        out.push(stripCandidateInternals(c));
      }
      // Note: Do NOT append Arcod after Mono when user explicitly chose mono_first if Arcod has an album string
      // and Mono doesn't (Kotlin's 0.05 albumScore would otherwise override primary preference!). Failover happens seamlessly inside getTrackStreamUrl!
      if (opts.sourcePriority !== 'mono_first' && opts.sourcePriority !== 'arcod_first') {
        for (const fallbackWinner of orderedWinners.slice(1)) {
          if (seenIds.has(fallbackWinner.id)) continue;
          // Only append fallback candidate if primary didn't match with equal score, or always stash in pairBundle
          candidatePairCache.set(fallbackWinner.id, pairBundle);
        }
      }
    } else {
      // No strict matches: check if all sources suffered transport error vs genuine no-match
      const attempted = Object.values(bySource);
      const allFailedTransport = attempted.length > 0 && attempted.every((r) => !r.ok && r.transportError);
      if (allFailedTransport) {
        throw new Error('ALL_SOURCES_UNREACHABLE');
      }
      // Return best non-rejected raw candidates only if helpful? Actually ModuleTrackMatcher rejects non-1.0 anyway,
      // so returning [] prevents pointless match evaluation and lets ArchiveTune fall back cleanly.
    }

    const ttl = out.length > 0 ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    searchCache.set(cacheKey, out, ttl);
    return out;
  };

  const p = runSearch();
  pendingSearches.set(cacheKey, p);
  try {
    return await p;
  } finally {
    pendingSearches.delete(cacheKey);
  }
}

/**
 * Resolves and validates an Arcod (Qobuz) stream candidate.
 * Always checks Range bytes 0-63 (usually pre-warmed in 0ms) to get true FLAC metrics
 * and catch dead/502 Qobuz release IDs before ExoPlayer ever opens the stream.
 */
async function resolveArcodAttempt(rawId, meta, qCode, opts, verifyHeader, deadlineMs) {
  const remaining = deadlineMs - Date.now();
  if (remaining < 600) return { stream: null, deadRelease: false };

  const ticket = await fetchArcodTicket(rawId, qCode, Math.min(TICKET_TIMEOUT_MS, remaining));
  if (!ticket.ok || !ticket.streamUrl) {
    return { stream: null, deadRelease: ticket.status >= 400 && ticket.status !== 429 };
  }

  const estBitDepth = qCode === 6 ? 16 : (meta?.bitDepth || 24);
  const estSampleRate = qCode === 6 ? 44100 : (qCode === 7 ? Math.min(96000, meta?.sampleRate || 96000) : (meta?.sampleRate || 44100));

  let bitDepth = estBitDepth;
  let sampleRate = estSampleRate;
  let contentLength = 0;
  let bitrate = estimateFlacBitrate(sampleRate, bitDepth, 2);

  const probeCap = verifyHeader ? PROBE_TIMEOUT_MS : 1400;
  const probeBudget = Math.min(probeCap, Math.max(500, deadlineMs - Date.now()));
  const probe = await probeFlacHeader(ticket.streamUrl, probeBudget);

  if (probe.ok) {
    bitDepth = probe.bitDepth;
    sampleRate = probe.sampleRate;
    contentLength = probe.contentLength;
    bitrate = probe.bitrate;
  } else if (probe.invalidMagic || probe.status >= 400) {
    // Hard failure (e.g. 502 Bad Gateway on broken Qobuz release) -> reject immediately & blacklist release
    return { stream: null, deadRelease: probe.status === 502 || probe.status === 404 || probe.invalidMagic };
  } else if (verifyHeader || (opts.strictHiRes && bitDepth < 24 && sampleRate <= 48000)) {
    // Under strict pre-verify or strict hi-res, refuse unverified timeouts
    return { stream: null, deadRelease: false };
  }

  if (opts.strictHiRes && bitDepth < 24 && sampleRate <= 48000) {
    return { stream: null, deadRelease: false };
  }

  const stream = {
    url: ticket.streamUrl,
    mimeType: 'audio/flac',
    codecs: 'flac',
    bitrate,
    sampleRate,
    contentLength,
    expiresInSeconds: 1800,
    expiresAtMs: Date.now() + 1800 * 1000,
    variant: `qobuz-flac-${bitDepth}-${sampleRate}`,
    provider: computeQualityLabel('Qobuz', bitDepth, sampleRate),
    track: { sourceId: `ar:${rawId}`, bitrate, sampleRate, codecs: 'flac', mimeType: 'audio/flac' }
  };
  return { stream, deadRelease: false };
}

/**
 * Resolves and validates a Monochrome stream candidate (reads real FLAC STREAMINFO!).
 */
async function resolveMonoAttempt(rawId, opts, deadlineMs) {
  const remaining = deadlineMs - Date.now();
  if (remaining < 600) return null;

  const url = `${MONO_BASE}/track/${encodeURIComponent(rawId)}`;
  const probe = await probeFlacHeader(url, Math.min(PROBE_TIMEOUT_MS, remaining));
  if (!probe.ok) return null;

  if (opts.strictHiRes && probe.bitDepth < 24 && probe.sampleRate <= 48000) {
    return null;
  }

  return {
    url,
    headers: { 'User-Agent': BROWSER_UA },
    mimeType: 'audio/flac',
    codecs: 'flac',
    bitrate: probe.bitrate,
    sampleRate: probe.sampleRate,
    contentLength: probe.contentLength,
    expiresInSeconds: 7200,
    expiresAtMs: Date.now() + 7200 * 1000,
    variant: `mono-flac-${probe.bitDepth}-${probe.sampleRate}`,
    provider: computeQualityLabel('Monochrome', probe.bitDepth, probe.sampleRate),
    track: { sourceId: `mc:${rawId}`, bitrate: probe.bitrate, sampleRate: probe.sampleRate, codecs: 'flac', mimeType: 'audio/flac' }
  };
}

/**
 * Checks custom self-hosted binimum/hifi-api URL with strict anti-preview guard.
 */
async function resolveCustomHifiAttempt(baseUrl, rawId, opts, deadlineMs) {
  if (!baseUrl) return null;
  const qualities = opts.strictCd ? ['LOSSLESS'] : ['HI_RES_LOSSLESS', 'LOSSLESS'];
  for (const q of qualities) {
    const remaining = deadlineMs - Date.now();
    if (remaining < 600) return null;
    const resp = await fetchJsonSafe(`${baseUrl}/track/?id=${encodeURIComponent(rawId)}&quality=${q}`, Math.min(3500, remaining));
    if (!resp.ok) continue;
    const data = resp.data?.data || resp.data;
    if (!data || data.assetPresentation === 'PREVIEW' || !data.manifest) continue;

    let decoded = '';
    try {
      decoded = typeof atob === 'function' ? atob(data.manifest) : '';
    } catch (_) {
      continue;
    }
    if (!decoded) continue;

    if (data.manifestMimeType === 'application/vnd.tidal.bts') {
      try {
        const mj = JSON.parse(decoded);
        const u = Array.isArray(mj.urls) ? mj.urls[0] : '';
        if (!u || !String(mj.codecs || '').toLowerCase().includes('flac')) continue;
        const sr = toHz(data.sampleRate || 44100);
        const bd = Number(data.bitDepth) || (q === 'HI_RES_LOSSLESS' ? 24 : 16);
        if (opts.strictHiRes && bd < 24 && sr <= 48000) continue;
        return {
          url: u,
          mimeType: 'audio/flac',
          codecs: 'flac',
          bitrate: estimateFlacBitrate(sr, bd, 2),
          sampleRate: sr,
          contentLength: 0,
          expiresInSeconds: 1800,
          expiresAtMs: Date.now() + 1800 * 1000,
          variant: `hifi-flac-${bd}-${sr}`,
          provider: computeQualityLabel('HiFi', bd, sr),
          track: { sourceId: `hf:${rawId}` }
        };
      } catch (_) {
        continue;
      }
    } else if (String(data.manifestMimeType || '').includes('dash') && !/ContentProtection/i.test(decoded)) {
      if (/mediaPresentationDuration="PT(?:29|30)(?:\.\d+)?S"/i.test(decoded)) continue;
      const srMatch = decoded.match(/audioSamplingRate="(\d+)"/);
      const sr = toHz(srMatch ? srMatch[1] : (data.sampleRate || 48000));
      const bd = Number(data.bitDepth) || (sr > 48000 ? 24 : 16);
      if (opts.strictHiRes && bd < 24 && sr <= 48000) continue;
      return {
        url: `${baseUrl}/track/?id=${encodeURIComponent(rawId)}&quality=${q}`,
        inlineManifest: decoded,
        mimeType: 'application/dash+xml',
        codecs: 'flac',
        bitrate: estimateFlacBitrate(sr, bd, 2),
        sampleRate: sr,
        contentLength: 0,
        expiresInSeconds: 1800,
        expiresAtMs: Date.now() + 1800 * 1000,
        variant: `hifi-dash-${bd}-${sr}`,
        provider: computeQualityLabel('HiFi DASH', bd, sr),
        track: { sourceId: `hf:${rawId}` }
      };
    }
  }
  return null;
}

/**
 * Resolves the highest-fidelity working FLAC stream URL with automatic cross-quality & cross-source failover.
 */
async function getTrackStreamUrl(trackId, quality, context = {}) {
  const fullId = String(trackId || '').trim();
  if (!fullId) {
    throw new Error('INVALID_TRACK_ID');
  }

  const opts = getEffectiveOptions(context, quality);
  const isRetry = Boolean(context?.playbackError);
  const prefixMatch = fullId.match(/^(ar|mc|hf):(.+)$/);
  const primaryBackend = prefixMatch ? prefixMatch[1] : 'mono';
  const primaryRawId = prefixMatch ? prefixMatch[2] : fullId;

  const streamCacheKey = `${fullId}:${opts.targetResolution}:${opts.wantsHiRes ? 'HIRES' : 'CD'}:${opts.fastStartMode}`;

  if (!isRetry) {
    const cached = streamUrlCache.get(streamCacheKey);
    if (cached && cached.expiresAtMs > Date.now() + 60000) {
      return cached;
    }
  } else {
    streamUrlCache.delete(streamCacheKey);
    const lastUsed = lastServedSource.get(fullId);
    if (lastUsed) {
      failedBackendCache.set(`${fullId}:${lastUsed}`, true);
      if (lastUsed.startsWith('ar:')) ticketCache.delete(lastUsed);
    }
  }

  let pairBundle = candidatePairCache.get(fullId) || null;
  const savedDescriptor = !isRetry ? resolvedDescriptorCache.get(streamCacheKey) : null;

  // Lazy cross-source recovery on cold restart OR when fast-return aborted the slower sibling during search
  const needsArcodFill = opts.sourcePriority !== 'mono_only' && !pairBundle?.arcod;
  const needsMonoFill = opts.sourcePriority !== 'arcod_only' && !pairBundle?.mono;
  if (isRetry && context?.song && (needsArcodFill || needsMonoFill)) {
    try {
      const target = pairBundle?.target || extractSongTarget('', context);
      const cleanQ = buildCleanSearchQuery(context.song.query || `${target.title} ${target.artists[0] || ''}`, target);
      if (cleanQ) {
        const [aRes, mRes] = await Promise.all([
          needsArcodFill ? queryArcod(cleanQ, target, opts, 2800) : Promise.resolve({ ok: false, items: [] }),
          needsMonoFill ? queryMonochrome(cleanQ, target, opts, 2800) : Promise.resolve({ ok: false, items: [] })
        ]);
        const aw = needsArcodFill && aRes.ok ? pickAcceptedWinner(aRes.items, opts.wantsHiRes) : null;
        const mw = needsMonoFill && mRes.ok ? pickAcceptedWinner(mRes.items, opts.wantsHiRes) : null;
        pairBundle = {
          target,
          arcod: pairBundle?.arcod || (aw ? { rawId: aw.rawId, meta: aw.meta } : null),
          arcodAlts: pairBundle?.arcodAlts || (aRes.ok && aw
            ? aRes.items.filter((c) => c._match?.accepted && c.rawId !== aw.rawId).slice(0, 2).map((c) => ({ rawId: c.rawId, meta: c.meta }))
            : []),
          mono: pairBundle?.mono || (mw ? { rawId: mw.rawId, meta: mw.meta } : null),
          hifi: pairBundle?.hifi || null,
          searchedArcod: Boolean(pairBundle?.searchedArcod || needsArcodFill),
          searchedMono: Boolean(pairBundle?.searchedMono || needsMonoFill)
        };
        candidatePairCache.set(fullId, pairBundle);
      }
    } catch (_) {}
  }

  const deadlineMs = Date.now() + STREAM_DEADLINE_MS;
  const verifyHeader = opts.fastStartMode === 'always_verify' || isRetry;

  // Build ordered attempt descriptors
  const attempts = [];
  const pushArcodAttempts = (rawId, meta) => {
    if (!rawId || opts.sourcePriority === 'mono_only') return;
    const codes = getArcodQualityChain(meta, opts);
    for (const qCode of codes) {
      const failKey = `${fullId}:ar:${rawId}:${qCode}`;
      if (!failedBackendCache.get(failKey)) {
        attempts.push({ type: 'arcod', rawId, meta, qCode, failKey });
      }
    }
  };
  const pushMonoAttempt = (rawId) => {
    if (!rawId || opts.sourcePriority === 'arcod_only') return;
    const failKey = `${fullId}:mc:${rawId}`;
    if (!failedBackendCache.get(failKey)) {
      attempts.push({ type: 'mono', rawId, failKey });
    }
  };
  const pushHifiAttempt = (rawId) => {
    if (!rawId || !opts.customHifiApiUrl) return;
    const failKey = `${fullId}:hf:${rawId}`;
    if (!failedBackendCache.get(failKey)) {
      attempts.push({ type: 'hifi', rawId, failKey });
    }
  };

  const deadArcodIds = new Set();
  const alts = Array.isArray(pairBundle?.arcodAlts) ? pairBundle.arcodAlts : [];
  const hiResAlts = alts.filter((a) => (a.meta?.bitDepth || 16) >= 24);
  const cdAlts = opts.strictHiRes ? [] : alts.filter((a) => (a.meta?.bitDepth || 16) < 24);

  if (primaryBackend === 'ar') {
    pushArcodAttempts(primaryRawId, pairBundle?.arcod?.meta || null);
    hiResAlts.forEach((a) => pushArcodAttempts(a.rawId, a.meta));
    if (pairBundle?.mono) pushMonoAttempt(pairBundle.mono.rawId);
    cdAlts.forEach((a) => pushArcodAttempts(a.rawId, a.meta));
    if (pairBundle?.hifi) pushHifiAttempt(pairBundle.hifi.rawId);
  } else if (primaryBackend === 'mc') {
    pushMonoAttempt(primaryRawId);
    if (pairBundle?.arcod) pushArcodAttempts(pairBundle.arcod.rawId, pairBundle.arcod.meta);
    alts.forEach((a) => pushArcodAttempts(a.rawId, a.meta));
    if (pairBundle?.hifi) pushHifiAttempt(pairBundle.hifi.rawId);
  } else if (primaryBackend === 'hf') {
    pushHifiAttempt(primaryRawId);
    if (pairBundle?.arcod) pushArcodAttempts(pairBundle.arcod.rawId, pairBundle.arcod.meta);
    alts.forEach((a) => pushArcodAttempts(a.rawId, a.meta));
    if (pairBundle?.mono) pushMonoAttempt(pairBundle.mono.rawId);
  }

  for (const att of attempts) {
    if (att.type === 'arcod' && deadArcodIds.has(att.rawId)) continue;
    if (Date.now() >= deadlineMs - 400) break;
    let stream = null;
    if (att.type === 'arcod') {
      const arcRes = await resolveArcodAttempt(att.rawId, att.meta, att.qCode, opts, verifyHeader, deadlineMs);
      stream = arcRes.stream;
      if (!stream && arcRes.deadRelease) {
        deadArcodIds.add(att.rawId);
        [27, 7, 6].forEach((qc) => failedBackendCache.set(`${fullId}:ar:${att.rawId}:${qc}`, true));
      }
    } else if (att.type === 'mono') {
      stream = await resolveMonoAttempt(att.rawId, opts, deadlineMs);
    } else if (att.type === 'hifi') {
      stream = await resolveCustomHifiAttempt(opts.customHifiApiUrl, att.rawId, opts, deadlineMs);
    }

    if (stream) {
      const attSourceKey = att.type === 'arcod' ? `${att.type}:${att.rawId}:${att.qCode}` : `${att.type}:${att.rawId}`;
      // Preserve consistent cacheKey descriptors across token refresh when exact backend & quality tier repeats
      if (savedDescriptor && savedDescriptor.sourceKey === attSourceKey) {
        stream.bitrate = savedDescriptor.bitrate;
        stream.sampleRate = savedDescriptor.sampleRate;
        stream.contentLength = savedDescriptor.contentLength;
        stream.variant = savedDescriptor.variant;
        stream.provider = savedDescriptor.provider;
      } else {
        resolvedDescriptorCache.set(streamCacheKey, {
          sourceKey: attSourceKey,
          bitrate: stream.bitrate,
          sampleRate: stream.sampleRate,
          contentLength: stream.contentLength,
          variant: stream.variant,
          provider: stream.provider
        });
      }

      const usedPrefix = att.type === 'arcod' ? 'ar' : (att.type === 'mono' ? 'mc' : 'hf');
      const usedKey = att.type === 'arcod' ? `ar:${att.rawId}:${att.qCode}` : `${usedPrefix}:${att.rawId}`;
      lastServedSource.set(fullId, usedKey);
      streamUrlCache.set(streamCacheKey, stream);
      return stream;
    }
    failedBackendCache.set(att.failKey, true);
  }

  throw new Error('NO_PLAYABLE_FLAC_STREAM');
}

/**
 * Handles mid-stream or CDN playback errors cleanly:
 * - Attempt 1: 'retry' when another backend or quality tier exists
 * - Attempt >= 2 or exhausted: 'fallback' to native YouTube Music with zero dialog
 */
async function onPlaybackError(error, context = {}) {
  const trackId = String(error?.trackId || context?.track?.id || '').trim();
  const attempt = Number(error?.attempt || 1);
  const category = String(error?.category || '').toLowerCase();
  const opts = getEffectiveOptions(context);

  if (trackId) {
    const lastUsed = lastServedSource.get(trackId);
    if (lastUsed) {
      failedBackendCache.set(`${trackId}:${lastUsed}`, true);
      if (lastUsed.startsWith('ar:')) ticketCache.delete(lastUsed);
    }
    streamUrlCache.delete(`${trackId}:${opts.targetResolution}:${opts.wantsHiRes ? 'HIRES' : 'CD'}:${opts.fastStartMode}`);
  }

  if (attempt > 1 || category === 'drm' || category === 'cancelled') {
    return 'fallback';
  }

  // Verify whether any alternative backend or lower tier remains before paying retry latency
  if (trackId) {
    const pm = trackId.match(/^(ar|mc|hf):(.+)$/);
    const backend = pm ? pm[1] : 'mono';
    const rawId = pm ? pm[2] : trackId;
    const bundle = candidatePairCache.get(trackId);
    const hasArcodLeft = (metaId, metaObj) =>
      opts.sourcePriority !== 'mono_only' &&
      getArcodQualityChain(metaObj, opts).some((qc) => !failedBackendCache.get(`${trackId}:ar:${metaId}:${qc}`));
    const hasMonoLeft = (mId) =>
      opts.sourcePriority !== 'arcod_only' && !failedBackendCache.get(`${trackId}:mc:${mId}`);
    const hasHifiLeft = (hId) =>
      Boolean(opts.customHifiApiUrl) && !failedBackendCache.get(`${trackId}:hf:${hId}`);

    if (bundle) {
      const alts = Array.isArray(bundle.arcodAlts) ? bundle.arcodAlts : [];
      const canLazyArcod = opts.sourcePriority !== 'mono_only' && !bundle.searchedArcod;
      const canLazyMono = opts.sourcePriority !== 'arcod_only' && !bundle.searchedMono;
      const anyLeft =
        canLazyArcod ||
        canLazyMono ||
        (backend === 'ar' && hasArcodLeft(rawId, bundle.arcod?.meta)) ||
        (bundle.arcod && hasArcodLeft(bundle.arcod.rawId, bundle.arcod.meta)) ||
        alts.some((a) => hasArcodLeft(a.rawId, a.meta)) ||
        (backend === 'mc' && hasMonoLeft(rawId)) ||
        (bundle.mono && hasMonoLeft(bundle.mono.rawId)) ||
        (bundle.hifi && hasHifiLeft(bundle.hifi.rawId));
      if (!anyLeft) return 'fallback';
    }
  }

  return 'retry';
}

module.exports = { searchTracks, getTrackStreamUrl, onPlaybackError };
