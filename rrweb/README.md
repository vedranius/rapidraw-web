# rrweb — RapidRAW web layer

Everything rapidraw-web adds to RapidRAW lives here. Full documentation: https://github.com/vedranius/rapidraw-web

| Path | What |
|---|---|
| `shim/` | Browser replacements for `@tauri-apps/*` (invoke/listen over WebSocket, dialogs, window stubs) |
| `bridge/` | 3 KB page loaded by the real RapidRAW backend instead of its UI; forwards IPC + events to the relay |
| `relay/relay.mjs` | Node server: serves the web UI and `/files`, routes browser ⇄ bridge |
| `relay/files.mjs`, `files/` | Files tab and server-side folder/file pickers (`files/picker.ts`, used by `shim/dialog.ts`): server side (list, zip download, upload, copy/move with sidecars) and the browser UI injected next to RapidRAW |
| `relay/remote.mjs`, `files/remote.ts`, `fuse/` | *This computer*: a folder on the browsing computer as storage (copy mode with write-back; on-demand mode via the `rrweb-fuse` FUSE helper on Linux) |
| `relay/raf.mjs` | Fuji RAF in on-demand folders: thumbnails and EXIF from the embedded JPEG instead of the whole file (seeds RapidRAW's thumbnail cache) |
| `files/network.ts` | Connection badge: speed/ping test and preview quality recommendation |
| `CHANGELOG.md` | What changed in each web version (used in the release notes) |
| `bundle/prepare.mjs` | All-in-one bridge (Windows, macOS, Linux): fetches Node.js (SHA256-checked) as the `rrweb-node` sidecar (Linux: also `rrweb-fuse`) and generates the Tauri overlay that bundles relay + web UI |
| `linux/rapidraw-web.service` | systemd user service in the `.deb`/`.rpm` for servers without a screen (`xvfb-run`) |
| `gen-events.mjs` | Extracts every event name the UI listens to (runs on each bridge build) |
| `check-shims.mjs` | Fails the build if the UI imports a Tauri module/function the shims don't cover, or RapidRAW's thumbnail cache / EXIF reading changes (`relay/raf.mjs`) |
| `vite.web.config.mjs` / `vite.bridge.config.mjs` | Builds for the browser UI and the bridge page |
| `tauri.bridge.json` | Tauri config overlay: separate identifier/binary name, no file associations, bridge frontend |
| `build.sh`, `run.sh`, `run.ps1` | Build and start scripts |
| `VERSION`, `version.mjs` | Web-layer version (raise it on `main` to release); release tag `rapidraw-v<RapidRAW>-web-v<web>`, package version `<RapidRAW>+web.<web>` |
| `release-notes.mjs`, `RELEASE_NOTES.md` | Release notes: upstream title + web-layer commits since the previous web version |

Run: `RR_PHOTOS=/path/to/photos ./run.sh`, open `http://<host>:8780`.
