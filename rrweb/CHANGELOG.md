# rapidraw-web changelog

Versions of the web layer ([`rrweb/VERSION`](VERSION)). Every release also names the unmodified RapidRAW inside it: `rapidraw-v<RapidRAW>-web-v<web>`. What's new in the editor itself is in [RapidRAW's releases](https://github.com/CyberTimon/RapidRAW/releases).

## 1.9.1

- Fixed: the folder pickers (*Add Folder*) and the Files tab could hang and show nothing while a folder from another computer was shared on demand but not connected (for example from a closed browser tab). Such folders are now shown as *not connected* and are not touched, operations on them fail at once instead of waiting, and RapidRAW's own checks of them no longer block for two minutes.
- The Files tab also lists folders shared from other browsers or tabs, with *Stop* (also on plain-HTTP addresses, where adding folders isn't possible).
- The exact version (`rapidraw-v<RapidRAW>-web-v<web>`, as on GitHub) is shown at the top, linked to its release.

## 1.9.0

- **Editing comes first in every folder**, not only in on-demand ones: thumbnails are handed to RapidRAW by rapidraw-web, none while you edit (and for 15 s after your last change), one at a time while a photo is open, four at a time in the library. Thumbnails of edited photos are rendered from the whole RAW on the GPU and used to slow the sliders down. Test with 60 edited RAFs in a local folder: opening a photo 5.6 → 2.9 s, slider previews 30–50 % faster, no thumbnail work while editing.
- **Fuji RAF EXIF in every folder** comes from the embedded JPEG's header (~65 KB) instead of the whole file, unless the `.rrdata` already holds EXIF.
- **Choose the preview size and live quality yourself** in the connection panel (badge), besides the recommendation.
- The badge shows **download and upload** (↓ ↑).
- Fixed: RapidRAW could crash (*bridge disconnected*) when it read a photo from a folder whose computer had been disconnected for longer than 2 minutes. Such photos now give a clear message, and short read errors are retried.
- The server part keeps a log, `logs/relay.log` in RapidRAW Web's data folder (`RR_LOG`), so problems can be traced afterwards.

## 1.8.0

- **The photo you are editing comes first.** In on-demand folders, opening a photo fetches it whole, in parallel, ahead of thumbnails and the background copy. While you edit (and for a few seconds after each change), thumbnails and the background copy wait; thumbnails of edited photos (RapidRAW renders them from the whole file on the GPU) are made at most two at a time. On a LAN test with 24 RAFs: opening a photo 3.1 → 1.9 s, first slider preview 870 → 230 ms; over a slower connection the difference is much bigger.
- **Connection badge:** measures with several parallel connections without counting the ping, so fast connections are no longer underestimated, and also measures upload (folders from the computer you browse from travel at its upload speed). Background transfers pause during the test.
- Fixed: on Linux, the server part could keep running after the RapidRAW Web window/service had stopped; leftover mounts are cleaned up only once the server owns its port (a second instance no longer detaches the mounts of the first).
- Docs: through a tunnel such as Cloudflare, traffic also passes the server's internet upload; at home the LAN address is faster (and Chrome can treat it as secure for folders from this computer).

## 1.7.0

- **On-demand folders on Windows servers.** *Use a folder from this computer → On demand* now also works when RapidRAW Web runs on Windows: install the free [WinFsp](https://winfsp.dev) once. The folder is mounted as a directory (no drive letter needed) and behaves as on Linux: only what RapidRAW reads travels, edits and exports go straight back, deleted originals go to `.rrweb-trash`, Fuji RAF browsing uses the embedded JPEG. Without WinFsp the dialog says what is missing; copy mode works as before.
- `rrweb-fuse` is included in the Windows installer and in the server bundle (`fuse/x86_64/rrweb-fuse.exe`).
- `RR_VERBOSE=1` also logs the file operations of on-demand folders.

## 1.6.0

- **Fast Fuji RAF browsing in on-demand folders.** Opening a folder of RAF files no longer pulls every whole file (30–45 MB each) from the computer you browse from. The browser sends a finished thumbnail made from the camera's embedded JPEG (about 0.3 MB) and the EXIF header (about 65 KB); RapidRAW uses them as it does for NEF/ARW. In a test with 12 RAFs: 0 MB of RAW data instead of 378 MB until a photo is opened in the editor. Only for photos without edits; edited ones are rendered by RapidRAW as before.
- The build checks that RapidRAW still caches thumbnails and reads EXIF the same way, so a RapidRAW update can't silently break this.

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
