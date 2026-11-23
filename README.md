<div align="center">

# 🎵 Monochrome True Lossless & Hi-Fi Engine
### Official Audio Provider Module & Community Catalog for [ArchiveTune](https://github.com/rukamori/ArchiveTune) (Android)

[![Version](https://img.shields.io/badge/version-2.7.0-gold.svg?style=for-the-badge)](https://github.com/Viscousity/archivetune-modules/releases)
[![Format](https://img.shields.io/badge/Format-FLAC%2024--bit%20%2F%2016--bit-brightgreen.svg?style=for-the-badge)](https://github.com/Viscousity/archivetune-modules)
[![Fallback](https://img.shields.io/badge/Failover-320kbps%20AAC-blue.svg?style=for-the-badge)](https://github.com/Viscousity/archivetune-modules)
[![License](https://img.shields.io/badge/license-GPL--3.0-orange.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-ArchiveTune%20Android-informational.svg?style=for-the-badge)](https://github.com/rukamori/ArchiveTune)

<p align="center">
  <b>Stream bit-perfect 16-bit / 24-bit Lossless FLAC and authentic 320 kbps AAC directly inside ArchiveTune.</b><br/>
  Featuring parallel dual-engine search, ISRC studio-master resolution (Amazon Music & Qobuz cross-matched), multi-mirror redundancy, 4-tier quality selector, and predictive 0ms gapless pre-warming.
</p>

---

</div>

## 📑 Table of Contents

- [Overview](#-overview)
- [How to Install in ArchiveTune](#-how-to-install-in-archivetune)
  - [Method 1: Add as Catalog (Recommended)](#method-1-add-as-catalog-recommended)
  - [Method 2: Direct .arch Package Import](#method-2-direct-arch-package-import)
- [Architecture & Multi-Source Failover](#-architecture--multi-source-failover)
- [Audio Quality Tiers](#-audio-quality-tiers)
- [Module Settings](#-module-settings)
- [Key Features](#-key-features)
- [Troubleshooting & Common Questions](#-troubleshooting--common-questions)
- [Building & Packaging](#-building--packaging)

---

## 🌟 Overview

**Monochrome (True FLAC & Hi-Fi)** is an advanced native audio provider module for ArchiveTune. It eliminates the frustration of lossy streaming, broken mirrors, and rate limits by unifying:
1. **Lossless FLAC Master Tiers:** Tidal Hi-Fi & Studio Masters (up to 24-bit / 192 kHz).
2. **Multi-Mirror Redundancy:** Automatic switching between primary and backup Tidal endpoints.
3. **Cross-Catalog ISRC Matching:** Leverages international ISRC codes so tracks from Amazon Music Ultra HD, Qobuz, and Apple Music resolve to bit-perfect studio master FLACs in < 300ms.
4. **Resilient 320k Failover:** Automatically switches to authentic 320 kbps AAC via JioSaavn CDN if FLAC encounters temporary rate limits—ensuring music **never halts**.

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
7. Tap the newly added **ArchiveTune Community Modules** card and tap **Install** on **Monochrome (True FLAC & Hi-Fi)**.

---

### Method 2: Direct `.arch` Package Import

If you prefer installing the standalone module directly without adding a catalog:

1. Download the latest compiled package:
   * **[Download monochrome.arch (v2.7.0)](https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/dist/monochrome.arch)**
2. In **ArchiveTune**, navigate to **Settings › Modules › `+`**.
3. Select **Import file** and choose the downloaded `monochrome.arch`.
4. Review permissions and tap **Enable**!

---

## ⚙️ Architecture & Multi-Source Failover

```
                     ┌──────────────────────────────────────────┐
                     │     ArchiveTune Audio Stream Request     │
                     └────────────────────┬─────────────────────┘
                                          │
                        ┌─────────────────┴─────────────────┐
                        │   Detect ISRC & Clean Title/Artist│
                        └─────────────────┬─────────────────┘
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
      ┌───────────────────────────┐               ┌───────────────────────────┐
      │   Monochrome Tidal FLAC   │               │   JioSaavn Progressive    │
      │   (Primary + Backup API)  │               │   (Authentic 320k / 160k) │
      └─────────────┬─────────────┘               └─────────────┬─────────────┘
                    │                                           │
                    │ [Parallel Promise.allSettled (~1s)]       │
                    └─────────────────────┬─────────────────────┘
                                          │
                         ┌────────────────┴────────────────┐
                         ▼                                 ▼
              [FLAC Candidate Available?]       [User selected HIGH_320 / 160?]
                         │                                 │
                 YES ────┴──── NO                          ▼
                  │            │                 Instant 320k / 160k Stream
                  ▼            ▼                 (0ms latency, ~10 MB)
         Test Mirror Reachability
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
    [Healthy]          [429 / 502 / Offline]
        │                   │
        ▼                   ▼
   Bit-Perfect FLAC   Seamless 320k Failover
   (16-bit / 24-bit)  (Playback never stops)
```

---

## 🎧 Audio Quality Tiers

You can customize your desired streaming bitrate directly inside **ArchiveTune › Module Settings › Streaming Quality**:

| Tier ID | Display Name | Quality & Codec | Typical File Size | Best For |
| :--- | :--- | :--- | :--- | :--- |
| `LOSSLESS_16` *(Default)* | **Lossless CD** | 16-bit / 44.1 kHz FLAC (1411 kbps) | ~25–50 MB | Audiophile listening, home Wi-Fi, studio monitors |
| `HI_RES_24` | **Studio Master** | 24-bit / 96–192 kHz FLAC (up to 4608 kbps) | ~50–120 MB | External DACs, high-end Hi-Fi headphones |
| `HIGH_320` | **High Speed** | 320 kbps AAC (`mp4a.40.2`) | ~8–12 MB | Fast instant start, mobile data, balanced fidelity |
| `SAVER_160` | **Data Saver** | 160 kbps AAC (`mp4a.40.2`) | ~4–6 MB | Low-bandwidth mobile networks, minimal data usage |

---

## 🛠️ Module Settings

ArchiveTune natively provides a settings panel for Monochrome under **Settings › Modules › Monochrome › Configure**:

* **Failover Strategy (`fallbackMode`)**:
  * `Seamless Failover (FLAC -> 320k AAC)` *(Default)*: If Tidal/Monochrome is rate-limited (429) or unavailable, the module transparently drops to JioSaavn authentic 320k AAC so music never cuts out.
  * `Strict Lossless Only`: Strictly serves FLAC. If lossless is unreachable, playback fails over cleanly without downgrading to lossy audio.
* **Skip Velocity Sensitivity (`skipSensitivity`)**:
  * `Ultra Fast (30ms)`: Minimal debounce interval for fiber / high-speed Wi-Fi.
  * `Balanced (60ms)` *(Default)*: Ideal responsiveness for normal browsing.
  * `Relaxed (100ms)`: Debounces rapid skipping to conserve mobile data and prevent burst traffic.
* **Predictive Next-Track Pre-warming (`autoPrewarmNext`)**:
  * Toggles background stream pre-fetching for upcoming tracks in your queue, enabling **0ms gapless playback**.

---

## ✨ Key Features

* **Amazon Music & Qobuz ISRC Cross-Matching**: 
  Songs from Amazon Music Ultra HD or Qobuz share standard international ISRC codes. When an ISRC is provided, Monochrome matches the exact studio master recording in under 300ms without relying on error-prone fuzzy text matching.
* **Parallel Dual-Engine Search**:
  Queries both Monochrome Lossless and JioSaavn simultaneously with `Promise.allSettled`. JioSaavn returns in ~200ms while Monochrome resolves FLAC in ~1000ms, populating high-resolution search results in record time.
* **Smart Skip Debouncer**:
  Rapidly pressing Next > Next > Next immediately cancels previous in-flight requests via `AbortController`, preventing socket clogging and Cloudflare 429 rate limit triggers.
* **Zero 429 Lockouts**:
  An intelligent circuit breaker tracks rate limits with a 60-second cooldown timer. It rotates to secondary mirror endpoints and automatically restores FLAC playback once the rate limit clears.

---

## ❓ Troubleshooting & Common Questions

#### Q: I see "This file or URL does not contain a valid supported module or catalog"?
**A:** This error occurs if you paste the webpage URL (`https://github.com/...`) into ArchiveTune instead of the raw JSON file. 
* To add the **Catalog**: Use `https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/registry.json`.
* To import the **Module**: Download `monochrome.arch` and choose **Import file**.

#### Q: How do I update to the latest version?
1. In ArchiveTune, go to **Settings › Modules › Catalogs**.
2. Tap **ArchiveTune Community Modules** and tap **Refresh catalog**.
3. Tap **Update / Install** on the Monochrome card.

#### Q: Can I stream Amazon Music tracks directly?
**A:** Amazon Music encrypts its audio chunks using Google Widevine DRM, which requires a hardware/software Content Decryption Module (CDM) unavailable in mobile JS runtimes. However, Monochrome resolves the **identical studio master FLAC** using the track's ISRC code across the Tidal/Qobuz catalog.

---

## 🔨 Building & Packaging

The module is packaged into the official ArchiveTune `.arch` archive format (ZIP bundle containing `manifest.json`, `provider.js`, and `icon.png` with internal SHA-256 hashes).

To re-package after editing:
```bash
python scripts/package_module.py extension/monochrome dist/monochrome.arch
```

To calculate the new package hash:
```bash
certutil -hashfile dist/monochrome.arch SHA256
```

---

## 📜 License & Credits

* **Author:** Viscousity
* **License:** GNU General Public License v3.0 ([GPL-3.0](LICENSE))
* **Application:** Designed specifically for [ArchiveTune](https://github.com/rukamori/ArchiveTune) by Rukamori.
