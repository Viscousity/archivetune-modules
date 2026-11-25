# ArchiveTune Community Modules — Monochrome (v3.0.0)

[![Version](https://img.shields.io/badge/version-3.0.0-0A84FF?style=for-the-badge)](./extension/monochrome/manifest.json)
[![Audio](https://img.shields.io/badge/FLAC-Up%20to%2024--bit%2F192%20kHz-34C759?style=for-the-badge)](#-key-features)
[![Zero Auth](https://img.shields.io/badge/Auth-Zero%20Login%20Required-FF9F0A?style=for-the-badge)](#-quick-install-in-archivetune)

**Monochrome (Lossless FLAC Engine)** (`community.provider.monochrome`) is a high-speed, 100% lossless external audio module built specifically for **ArchiveTune**. It races verified zero-auth lossless backends in parallel, pre-warms stream tickets and binary FLAC headers before playback resolution begins, and fails over cleanly with zero playback popups.

---

## Quick Install in ArchiveTune

### Option A — Module Repository URL (Recommended for auto-updates)
1. Open **ArchiveTune** -> **Settings** -> **Modules** -> **Repositories** -> **Add Repository**.
2. Paste this URL:
   ```text
   https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/registry.json
   ```
3. Install **Monochrome (Lossless FLAC Engine)** (`v3.0.0`), open its settings card if desired, and switch it to **Enabled**.

### Option B — Direct `.arch` Package Import
1. Download [`dist/monochrome.arch`](https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/dist/monochrome.arch).
2. In **ArchiveTune**, go to **Settings** -> **Modules** -> **Add** -> **Import file** and select `monochrome.arch`.

---

## Key Features (`v3.0.0`)

- **100% True Lossless FLAC (No Lossy Fallbacks):** Streams Studio Master Hi-Res FLAC (24-bit up to 192 kHz) and bit-perfect CD Lossless FLAC (16-bit / 44.1 kHz). Zero MP3/AAC downgrade sources.
- **Parallel Dual-Engine Race:**
  - **Source A — Arcod Qobuz Bridge (`https://arcod.xyz`):** Hi-Res Qobuz masters (`24-bit/44.1kHz`, `88.2kHz`, `96kHz`, `192kHz`) and CD `16-bit/44.1kHz` FLAC with multi-performer credit extraction (`item.performers`), `item.version` preservation, and dead-release (`502`/`404`) skipping.
  - **Source B — Monochrome (`https://tracks.monochrome.st`):** Native `16-bit` & `24-bit` FLAC with ISRC query fallback and deep catalog coverage (remixes, radio edits, regional/indie releases).
  - **Optional Custom HiFi-API (`customHifiApiUrl`):** Supports user-supplied `binimum/hifi-api` endpoints with strict anti-preview verification (`assetPresentation !== "PREVIEW"` and DASH preview duration filtering).
- **Speculative Pre-Warming for Near-Instant Start:** Overlaps signed stream ticket fetching and 64-byte `Range: bytes=0-63` binary FLAC `STREAMINFO` header verification right inside the search race window, cutting `getTrackStreamUrl` handoff to `0–200 ms` on fresh searches and `0 ms` on repeated/preloaded tracks.
- **Authentic Per-Track Acoustic Telemetry:** Parses real binary FLAC `STREAMINFO` frames (`sampleRate`, `bitDepth`, `contentLength`, and computed `bitrate`), using ArchiveTune-compliant diagnostic provider labels (`Qobuz Studio Master (24-bit / 96 kHz FLAC)`, `Monochrome CD Lossless (16-bit / 44.1 kHz FLAC)`).
- **Exact `ModuleTrackMatcher` Parity:** Matches ArchiveTune's native `Jaro-Winkler`, bracketed/trailing `feat.` handling, recording marker safety (`Live`, `Remix`, `Radio Edit`, `Acoustic`), duration tolerance, explicit flag handling, and optional soundtrack suffix normalization (e.g. `(From "...")`).
- **Silent Zero-Error YouTube Music Failover:** Implements `onPlaybackError` (`attempt 1` -> automatic `'retry'` across remaining Qobuz releases/tiers or Monochrome; `attempt >= 2` or catalog miss `[]` -> silent `'fallback'` to YouTube Music with zero `REQUEST_NETWORK` dialog poisoning).

---

## Module Quality & Configuration Options

### Quality Presets
| ID | Description |
| --- | --- |
| `HI_RES_24` (default) | **Studio Master Hi-Res** · up to 24-bit / 192 kHz FLAC (falls back smoothly to 16-bit CD FLAC when a master isn't available) |
| `LOSSLESS_16` | **Lossless CD** · 16-bit / 44.1 kHz FLAC |

### Module Settings
| Key | Default | Description |
| --- | --- | --- |
| `sourcePriority` | `auto_fastest` | `auto_fastest`, `arcod_first`, `mono_first`, `arcod_only`, or `mono_only` |
| `targetResolution` | `auto` | `auto` (highest genuine lossless), `strict_cd` (16-bit/44.1kHz only), or `strict_hires` (24-bit / >48kHz only) |
| `fastStartMode` | `instant` | `instant` (overlapped pre-warm + non-blocking timeout tolerance) or `always_verify` (strict 64-byte `fLaC` pre-check on every play) |
| `normalizeSoundtrackTitles` | `true` | Normalizes `(From "Movie")` soundtrack suffixes when matching cleanly while keeping remix/live/radio edit markers |
| `customHifiApiUrl` | `""` | Optional custom private `binimum/hifi-api` server URL |

---

## Packaging & Verification

To inspect or rebuild the `.arch` bundle from source:

```bash
python scripts/package_module.py extension/monochrome dist/monochrome.arch --report package_report.json
python scripts/package_module.py --inspect dist/monochrome.arch --json
```

Package SHA-256 (`dist/monochrome.arch`):
`61cde9b9192d89f73f3fefde263dcdc75dff7fbe0dd711b85433c75209a37771`

---

## License

Released under the [GNU General Public License v3.0](./LICENSE).
