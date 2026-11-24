<div align="center">

# 🎵 Monochrome Pure Lossless FLAC Engine
### Official Audio Provider Module & Community Catalog for [ArchiveTune](https://github.com/rukamori/ArchiveTune) (Android)

[![Version](https://img.shields.io/badge/version-2.8.2-gold.svg?style=for-the-badge)](https://github.com/Viscousity/archivetune-modules/releases)
[![Format](https://img.shields.io/badge/Format-Pure%20Lossless%20FLAC-brightgreen.svg?style=for-the-badge)](https://github.com/Viscousity/archivetune-modules)
[![Fallback](https://img.shields.io/badge/Fallback-Native%20YouTube%20Music-red.svg?style=for-the-badge)](https://github.com/Viscousity/archivetune-modules)
[![License](https://img.shields.io/badge/license-GPL--3.0-orange.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-ArchiveTune%20Android-informational.svg?style=for-the-badge)](https://github.com/rukamori/ArchiveTune)

<p align="center">
  <b>Stream 100% bit-perfect 16-bit CD Lossless & 24-bit Studio Master FLAC directly inside ArchiveTune.</b><br/>
  Featuring adaptive resilient search, ISRC studio-master cross-resolution (Amazon Music, Qobuz & Tidal matched), strict candidate scoring, per-track acoustic metadata, and seamless zero-error YouTube Music fallback.
</p>

---

</div>

## 📑 Table of Contents

- [Overview](#-overview)
- [How to Install in ArchiveTune](#-how-to-install-in-archivetune)
  - [Method 1: Add as Catalog (Recommended)](#method-1-add-as-catalog-recommended)
  - [Method 2: Direct .arch Package Import](#method-2-direct-arch-package-import)
- [Fixing the "Unavailable · PROVIDER/REQUEST_NETWORK" Error](#-fixing-the-unavailable--providerrequest_network-error)
- [Architecture & Failover](#-architecture--failover)
- [Audio Quality Tiers & Settings](#-audio-quality-tiers--settings)
- [Troubleshooting & Common Questions](#-troubleshooting--common-questions)
- [Building & Packaging](#-building--packaging)

---

## 🌟 Overview

**Monochrome (Pure Lossless FLAC)** is a dedicated high-fidelity native audio provider module for ArchiveTune. It eliminates lossy, muddy streams and rate limits by delivering:

1. **100% Pure Lossless FLAC:** Bit-perfect 16-bit / 44.1 kHz (CD quality) and 24-bit / 96–192 kHz (Studio Master) lossless audio only. (All muddy lossy sources have been completely purged).
2. **Adaptive Resilient Search:** Direct, paced query resolution against `tracks.monochrome.st` with an extended 9-second timeout budget to accommodate server response spikes without premature aborts.
3. **Cross-Catalog ISRC Matching:** Leverages international 12-character ISRC codes so releases from Amazon Music Ultra HD, Qobuz, Apple Music, and Tidal resolve to the exact bit-perfect studio recording in < 250ms.
4. **Strict Candidate Scoring & Artist Expansion:** Automatically maps hyphenated and grouped artist names (`Vishal-Shekhar` ↔ `Vishal & Shekhar`), ensuring exact 1.0 Jaro-Winkler matches and strict duration tolerance (within ±5 seconds).
5. **Accurate Per-Track Metadata:** Each track reports distinct, authentic technical audio specs (sample rate, bitrate, MIME `audio/flac`, and codec `flac`).
6. **Seamless Zero-Error YouTube Music Fallback:** If no verified FLAC match exists or if playback fails, ArchiveTune silently and smoothly plays from native YouTube Music without interrupting playback or throwing red error banners.

---

## 📥 How to Install in ArchiveTune

### Method 1: Add as Catalog (Recommended)

Adding the catalog allows ArchiveTune to automatically check for updates and refresh modules with one tap:

1. Open **ArchiveTune** on your Android device.
2. Go to **Settings › Modules**.
3. Ensure the master toggle **Use modules** is switched **ON**.
4. Tap the **`+`** (Add) button and select **Add catalog URL**.
5. Copy and paste the exact raw catalog URL below:
   ```text
   https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/registry.json
   ```
   > [!IMPORTANT]
   > **Do not** paste the web repository link (`https://github.com/...`). ArchiveTune requires the direct raw JSON file above!
6. Tap **Confirm / Add**.
7. Tap the newly added **ArchiveTune Community Modules** card and tap **Install / Update** on **Monochrome (Pure Lossless FLAC)**.

---

### Method 2: Direct `.arch` Package Import

If you prefer installing the standalone module directly without adding a catalog:

1. Download the latest compiled package:
   * **[Download monochrome.arch (v2.8.2)](https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/dist/monochrome.arch)**
   *(SHA-256: `39c87951f02a9dab38de4feecbcd3b25d58800e16b5c054c0704f61029a9fdc6`)*
2. In **ArchiveTune**, navigate to **Settings › Modules › `+`**.
3. Select **Import file** and choose the downloaded `monochrome.arch`.
4. Review permissions and tap **Enable**!

---

## 🚨 Fixing the "Unavailable · PROVIDER/REQUEST_NETWORK" Error

If your ArchiveTune screen previously showed:
> *Stage: provider search · The source could not be reached. Check its URL and your connection. (PROVIDER/REQUEST_NETWORK/ModuleException)*

This occurred in v2.8.1 because:
1. **Premature 2500ms timeout:** Monochrome's search API under heavy traffic takes 4–8 seconds. A 2.5s client-side abort fired prematurely, cancelling the connection.
2. **Dead domain in mirror list:** An unresolvable hostname (`sp-flac.monochrome.st`) threw an `UnknownHostException` in OkHttp, which stained ArchiveTune's internal `requestProblem` monitor with `REQUEST_NETWORK`.

### In v2.8.2:
* **Purged Dead Mirrors:** Only queries the verified live endpoint `https://tracks.monochrome.st`.
* **Adaptive 9000ms Timeout:** Gives the backend sufficient time to return full search results while remaining safely within ArchiveTune's 15s session budget.
* **Instant 0ms Stream URL Delivery:** Direct FLAC streaming without in-JavaScript pre-flight fetches that could trip network aborts.
* **Clean Fallback Guarantee:** If a track is not present on Monochrome, the module cleanly returns `[]` without network errors, allowing ArchiveTune to seamlessly stream from YouTube Music with a harmless blue dot instead of a red error banner!

---

## ⚙️ Architecture & Failover

```
                     ┌──────────────────────────────────────────┐
                     │     ArchiveTune Audio Stream Request     │
                     └────────────────────┬─────────────────────┘
                                          │
                        ┌─────────────────┴─────────────────┐
                        │   Detect ISRC & Clean Title/Artist│
                        └─────────────────┬─────────────────┘
                                          │
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
         [ISRC Code Detected?]                      [Standard Text Search]
                     │                                         │
        YES ─────────┴───────── NO                             │
         │                      │                              │
         ▼                      └──────────────┬───────────────┘
  Query isrc:<ISRC>                            ▼
  on Monochrome FLAC             Direct Query on Monochrome
  (< 250ms direct match)         (with 9000ms resilient timeout)
         │                                     │
         └──────────────────────┬──────────────┘
                                │
                                ▼
                   [Candidate Strict Verification]
                   - Title normalization & edition match
                   - Artist variant expansion ('Vishal-Shekhar' & 'Vishal & Shekhar')
                   - Duration match within ±5 seconds
                                │
                     ┌──────────┴──────────┐
                     ▼                     ▼
          [Strict Match Passed?]   [No FLAC Match Found?]
                     │                     │
            YES ─────┴───── NO             ▼
             │               │    Return empty list []
             ▼               │    ArchiveTune transparently
   Instant 0ms FLAC Stream   │    plays from native YouTube Music!
   Object with Headers       │    (Zero errors, zero halts)
             │               │
             ▼               └────────┘
Stream Bit-Perfect FLAC
(16-bit CD or 24-bit Hi-Res)
```

---

## 🎛️ Audio Quality Tiers & Settings

### Quality Options
* **Lossless CD · 16-bit / 44.1 kHz FLAC (`LOSSLESS_16`):** Authentic bit-perfect CD audio stream (1,411 kbps, ~25–50 MB).
* **Studio Master · 24-bit / 96–192 kHz FLAC (`HI_RES_24`):** Ultra high-resolution studio master recording (4,608 kbps+, ~50–120 MB).

### Module Settings
* **Resolution Preference:**
  * `Adaptive (Studio Master 24-bit if available, else CD 16-bit)` *(Default)*: Automatically streams the highest available lossless fidelity.
  * `Standard CD Lossless (16-bit / 44.1 kHz)`: Limits streaming strictly to 16-bit CD quality.
  * `Strict Studio Master (24-bit only)`: Streams only true 24-bit studio masters.
* **Skip Velocity Sensitivity:**
  * `Ultra Fast (30ms debounce)` *(Default)*: Fastest landing, immediately cancels obsolete in-flight requests when skipping rapidly.
  * `Balanced (60ms debounce)`: Recommended for everyday cellular usage.
  * `Relaxed (100ms debounce)`: Protects slower network connections from burst requests.

---

## 🛠️ Building & Packaging

To compile and package the module from source:

```bash
# Package into distribution .arch file
python scripts/package_module.py extension/monochrome dist/monochrome.arch

# Inspect and verify package integrity
python scripts/package_module.py --inspect dist/monochrome.arch
```

---

## 📄 License

GPL-3.0 License. See [LICENSE](LICENSE) for details.
