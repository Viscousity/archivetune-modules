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
6. Tap the new **ArchiveTune Community Modules** catalog card and install **Monochrome (Lossless FLAC)**!

---

## Direct Module Download

If you prefer installing individual `.arch` packages manually:

* **[Monochrome Lossless FLAC](https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/dist/monochrome.arch)** (`monochrome.arch`)
  * Direct URL for ArchiveTune **Add module URL**:
    ```text
    https://raw.githubusercontent.com/Viscousity/archivetune-modules/main/dist/monochrome.arch
    ```

---

## Available Modules

### 1. Monochrome (Lossless FLAC)
* **ID:** `community.provider.monochrome`
* **Audio Format:** 16-bit / 44.1 kHz FLAC (CD Quality) and up to 24-bit / 192 kHz FLAC (Hi-Res Master).
* **Account Required:** **None** (zero sign-in or subscription).
* **How it works:** Transparently intercepts standard YouTube Music tracks and matches them against public lossless backends (Monochrome, Lucida, Qobuz scrapers) to stream uncompressed bit-perfect FLAC on-the-fly.

---

## Authoring & Packaging

Modules follow the native `.arch` Package Format v1 (ZIP archive containing `manifest.json`, `provider.js`, and optional `icon.png`).

To package changes:
```bash
python scripts/package_module.py ./extension/monochrome ./dist/monochrome.arch
```
