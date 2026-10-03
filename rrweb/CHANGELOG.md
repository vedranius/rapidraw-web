# rapidraw-web changelog

Versions of the web layer ([`rrweb/VERSION`](VERSION)). Every release also names the unmodified RapidRAW inside it: `rapidraw-v<RapidRAW>-web-v<web>`. What's new in the editor itself is in [RapidRAW's releases](https://github.com/CyberTimon/RapidRAW/releases).

## 1.4.0

- **Use a folder from this computer.** In the Files tab (*This computer*), share a folder from the computer you are browsing from. Your photos and edits stay there; RapidRAW on the server edits them. Needs Chrome or Edge, and HTTPS or localhost.
  - **Copy to the server in the background:** the folder with all subfolders is copied to the server first (resumable, already copied files are skipped). Edits (`.rrdata`) and exports written by RapidRAW come back into the folder automatically. Works with every server OS.
  - **On demand** (Linux server): nothing is copied up front. The folder appears to RapidRAW as a disk (FUSE) and only the bytes it reads travel: a thumbnail needs about 1 MB, a photo is fetched completely once you edit it. Everything RapidRAW writes goes straight back into the folder.
  - **Keep a copy on the server** in a folder you choose, or use a temporary copy that is deleted when you stop sharing.
- **Preview quality for your connection.** A badge next to *Editor | Files* measures speed and ping, recommends RapidRAW's preview size and live quality, and warns when previews get slow.
- A relay started with a non-default `RR_PORT` no longer takes over port 8780 of another program on Windows; new `RR_BRIDGE_PORT`.

## 1.3.0

- macOS builds for Apple Silicon and Intel: all-in-one app like on Windows (experimental, not notarized by Apple).
- Release files are named `<tag>_<os>_<arch>`; the release notes list downloads per OS.

## 1.2.0

- **Photo library**: chosen once in the RapidRAW Web window on the server and always listed first.
- **Folder and file pickers** for the server in the browser (*Add Folder*, export, import, LUTs, presets) instead of typing paths.
- **Copy path** in the Files tab.

## 1.1.0

- Versioned separately from RapidRAW (`rapidraw-v<RapidRAW>-web-v<web>`), so web updates ship without waiting for a RapidRAW release.
- All-in-one Windows installer (includes Node.js; starts the server and opens the browser).
- **Files tab**: download (several files as .zip), upload, new folder, rename, copy, move, delete to the trash; RapidRAW edits travel with their photos.

## 1.0.0 (`v1.6.4-web`)

- First release: the RapidRAW interface in the browser, all processing on the server's GPU. Linux packages and server bundle, Windows bridge.
