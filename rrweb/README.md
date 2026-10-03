# rrweb — RapidRAW web layer

Everything rapidraw-web adds to RapidRAW lives here. Full documentation: https://github.com/vedranius/rapidraw-web

| Path | What |
|---|---|
| `shim/` | Browser replacements for `@tauri-apps/*` (invoke/listen over WebSocket, dialogs, window stubs) |
| `bridge/` | 3 KB page loaded by the real RapidRAW backend instead of its UI; forwards IPC + events to the relay |
| `relay/relay.mjs` | Node server: serves the web UI and `/files`, routes browser ⇄ bridge |
| `relay/files.mjs`, `files/` | Files tab and server-side folder/file pickers (`files/picker.ts`, used by `shim/dialog.ts`): server side (list, zip download, upload, copy/move with sidecars) and the browser UI injected next to RapidRAW |
| `bundle/prepare.mjs` | All-in-one bridge (Windows, macOS): fetches Node.js (SHA256-checked) as a sidecar and generates the Tauri overlay that bundles relay + web UI |
| `gen-events.mjs` | Extracts every event name the UI listens to (runs on each bridge build) |
| `check-shims.mjs` | Fails the build if the UI imports a Tauri module/function the shims don't cover |
| `vite.web.config.mjs` / `vite.bridge.config.mjs` | Builds for the browser UI and the bridge page |
| `tauri.bridge.json` | Tauri config overlay: separate identifier/binary name, no file associations, bridge frontend |
| `build.sh`, `run.sh`, `run.ps1` | Build and start scripts |
| `VERSION`, `version.mjs` | Web-layer version (raise it on `main` to release); release tag `rapidraw-v<RapidRAW>-web-v<web>`, package version `<RapidRAW>+web.<web>` |
| `release-notes.mjs`, `RELEASE_NOTES.md` | Release notes: upstream title + web-layer commits since the previous web version |

Run: `RR_PHOTOS=/path/to/photos ./run.sh`, open `http://<host>:8780`.
