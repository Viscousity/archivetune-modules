# ArchiveTune Community Modules Catalog

Community audio provider modules and repository catalog for **ArchiveTune** (Android).

## Quick Install in ArchiveTune

You can add this entire repository directly to your ArchiveTune app:

1. In **ArchiveTune**, navigate to **Settings › Modules**.
2. Make sure the master switch **Use modules** is toggled **ON**.
3. Tap the floating **`+`** button (or the **Catalogs** tab) and select **Add catalog URL**.
4. Paste this repository URL:
   ```text
   https://github.com/Viscousity/archivetune-modules
   ```
   *(Or direct registry link: `https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/registry.json`)*
5. Tap **Add / Confirm**.
6. Tap the new **ArchiveTune Community Modules** catalog card and install **Monochrome (True FLAC & Hi-Fi)**!

---

## Direct Module Download

If you prefer installing individual `.arch` packages manually:

* **[Monochrome True FLAC & Hi-Fi (v2.2.0)](https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/dist/monochrome.arch)** (`monochrome.arch`)
  * Direct URL for ArchiveTune **Add module URL**:
    ```text
    https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/dist/monochrome.arch
    ```

---

## Available Modules

### 1. Monochrome (True FLAC & Hi-Fi) `v2.2.0`
* **ID:** `community.provider.monochrome`
* **Audio Format:** 16-bit / 44.1 kHz FLAC (CD Quality, ~25–50 MB) with automatic high-speed fallback to 320 kbps / 160 kbps progressive AAC.
* **Account Required:** **None** (zero sign-in or subscription needed).
* **Key Features:**
  * **Precision Studio Matching:** Compares duration against the original studio release (±4s) to eliminate live recordings, extended edits, and unofficial remixes.
  * **Universal 100% Fallback:** Seamlessly plays any track from YouTube Music mixes or playlists (FLAC -> 320k -> 160k).
  * **0ms Pre-Warmed Stream Resolution:** Pre-populates stream links in memory during search for instantaneous playback.
  * **Ultra-HD Studio Artwork:** Delivers crisp cover art up to 1400×1400 directly on track candidates.
  * **Bit-Accurate Honest Metadata:** Shows genuine codecs and bitrates matching actual file sizes.

---

## Authoring & Packaging

Modules follow the native `.arch` Package Format v1 (ZIP archive containing `manifest.json`, `provider.js`, and `icon.png`).

To package changes:
```bash
python scripts/package_module.py ./extension/monochrome ./dist/monochrome.arch
```
