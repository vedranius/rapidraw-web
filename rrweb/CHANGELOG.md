# rapidraw-web changelog

Versions of the web layer ([`rrweb/VERSION`](VERSION)). Every release also names the unmodified RapidRAW inside it: `rapidraw-v<RapidRAW>-web-v<web>`. What's new in the editor itself is in [RapidRAW's releases](https://github.com/CyberTimon/RapidRAW/releases).

## 1.5.1

- Servers without a screen: the bridge no longer tries to open a browser when it runs under `xvfb-run` (or with `RR_NO_BROWSER=1`); on KDE that started `kde-open`, which crashed.

## 1.5.0

- **Linux: one file.** The `.deb`, `.rpm` and `.AppImage` are now all-in-one like on Windows and macOS: RapidRAW, the web UI, Node.js and the on-demand folder helper in one package. On a desktop, start *RapidRAW Web Bridge* from the menu; it starts the server, opens the browser and asks for your photo library.
- **Linux servers without a screen:** the `.deb`/`.rpm` install a systemd user service: `systemctl --user enable --now rapidraw-web`. The photo folder is `~/Pictures`, or set `RR_PHOTOS` with `systemctl --user edit rapidraw-web`.
- The server bundle (`…_linux_server.tar.gz` with `run.sh`) is now optional, for Docker or starting the parts yourself.
- The bundled Node.js is called `rrweb-node` (on Linux it is installed in `/usr/bin` and must not clash with a system Node.js). On Windows the firewall still asks about *Node.js JavaScript Runtime*.

## 1.4.1

- **Folders from this computer, on demand: much more robust.**
  - The server no longer stops when a connection breaks in an unusual way (for example through a Cloudflare tunnel). If it ever stops anyway, `run.sh` and the Windows/macOS app start it again, and the browser registers its folders again by itself, at the same path, so RapidRAW keeps working.
  - When the connection to the browser drops, RapidRAW waits up to 2 minutes for it to come back instead of getting read errors, which could crash it.
  - Mounts left behind by a crash (*Transport endpoint is not connected*) are cleaned up automatically.
  - Data travels in pieces of at most 1 MB with a keepalive, so tunnels and proxies don't cut the connection.
  - New option **Meanwhile copy the rest to the server in the background** (on by default): while RapidRAW isn't reading, the rest of the folder is copied to the server, so browsing gets fast. It stops when less than 5 GB is left on the server's disk.
- Corrected: thumbnails of Fuji RAF and Canon CR3 files need the whole file in on-demand mode (RapidRAW can't read their embedded preview), not about 1 MB.
- Linux: run the server as your normal user, not with `sudo`; how to keep it running in the background with `systemd-run`.

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
