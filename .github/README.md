# rapidraw-web

**Use [RapidRAW](https://github.com/CyberTimon/RapidRAW) in your browser, with all processing on a server in your network.**

> Unofficial fork. RapidRAW is created and maintained by **[Timon Käch (CyberTimon)](https://github.com/CyberTimon)**. This project only adds a thin web layer around it. For the desktop editor, go to the [original repository](https://github.com/CyberTimon/RapidRAW) or [getrapidraw.com](https://www.getrapidraw.com).

## The idea

I wanted one machine on my LAN that stores my photos (NAS) and has a GPU, and to edit those photos from any computer in the house, in a browser, with **exactly** the RapidRAW interface I already know: no VNC/RDP, no video stream of a remote desktop, no reimplemented "web version" with half the features.

RapidRAW makes this possible because it is a [Tauri](https://tauri.app) app: its interface is a React web app that talks to a Rust backend over IPC. rapidraw-web moves that IPC onto the network:

```
Browser (original RapidRAW UI + shim)
    │  WebSocket /ipc   JSON calls ↑   rendered previews (JPEG bytes) / events ↓
    ▼
Relay (Node.js)  ─ serves the UI, thumbnails, routes calls
    │  WebSocket /bridge (loopback only)
    ▼
RapidRAW Web Bridge  ─ the real RapidRAW backend, unmodified, rendering on the server GPU (wgpu)
    │
    ▼
GPU + photo storage
```

- **The browser shows the real RapidRAW UI.** Same React code, same panels, same sliders. Only the `@tauri-apps/*` imports are swapped for small shims at build time, so every feature that exists in RapidRAW exists here.
- **Rendering happens in RapidRAW on the server.** Moving a slider sends the adjustment; the server's GPU renders it and sends back a compressed preview — a few hundred KB, a few milliseconds on a gigabit LAN.
- **Zero changes to RapidRAW's code.** Everything lives in new files (`rrweb/`, `.github/`). The bridge is the regular RapidRAW backend that loads a 3 KB relay page instead of its UI. Upstream updates merge cleanly.

## Quick start

Download from the [Releases](https://github.com/vedranius/rapidraw-web/releases) page. Any GPU with Vulkan, DX12 or Metal works, including integrated Intel graphics.

### Windows x64: all-in-one installer

1. Run `rapidraw-v*-web-v*_windows_x64-setup.exe`. It contains everything (RapidRAW, the web UI and Node.js), nothing else to install.
2. Start **RapidRAW Web Bridge** from the Start menu. It starts the server and opens RapidRAW in your browser.
3. In the small RapidRAW Web window, choose your **photo library**: the folder on this computer that holds your photo folders. The window also lists the addresses for other devices on your network (`http://<this-pc>:8780`). Closing it stops the server.

The first time, Windows Firewall asks about *Node.js JavaScript Runtime*: allow **Private networks** to reach it from other devices.

### Linux

On the server you need **Node.js 20+**, one **bridge** package (`*_bridge_*`) and the **server bundle** (`*_server.tar.gz`).

```bash
# 1. Bridge — pick one
sudo apt install ./*_bridge_amd64.deb                    # Debian / Ubuntu (arm64: *_bridge_arm64.deb)
sudo dnf install ./*_bridge_x86_64.rpm                   # Fedora / openSUSE (aarch64: *_bridge_aarch64.rpm)
chmod +x ./*_bridge_*.AppImage                           # any distro: put it next to run.sh

# 2. Server bundle
tar xzf rapidraw-v*_server.tar.gz && cd rapidraw-v*-web-v*/
RR_PHOTOS=/mnt/photos ./run.sh
```

Updating: install the newer packages the same way. Their version is `<RapidRAW>+web.<web>` (e.g. `1.6.4+web.1.1.0`), so a new web release upgrades the bridge even when RapidRAW itself is unchanged.

Open `http://<server>:8780`.

On a headless server (no `DISPLAY`/`WAYLAND_DISPLAY`) `run.sh` starts the bridge under `xvfb-run`, so install `xvfb`. The GPU is used through Vulkan and doesn't need a display.

The server bundle and `run.ps1` also work on Windows (`powershell -ExecutionPolicy Bypass -File .\run.ps1`) if you prefer starting it with the variables below.

## Photo library and folder pickers

The **photo library** is the top folder of your photos on the server. Choose it in the RapidRAW Web window on the server (*Choose…*, a normal folder dialog of that computer); with `run.sh`/`run.ps1`, `RR_PHOTOS` does the same. You can change it any time.

In the browser, every place where RapidRAW asks for a folder or file (*Add Folder*, export destination, import, LUTs, presets) opens a picker for the server that starts in the photo library, so you never need to know a server path. *Type a path…* in the picker still accepts any path.

## Files tab

Next to the editor there is a **Files** tab (top centre): a file manager for the photo folders on the server, so you can get your exports out and organise shoots without another tool.

- Browse the photo library and the folders you opened in RapidRAW, with breadcrumbs, sorting and multi-select (Ctrl/Shift-click, Ctrl+A).
- **Download** a file, or several files and folders as one `.zip`; **Upload** files with the button or drag & drop.
- **New folder**, **Rename** (F2), **Copy/Cut → Paste** (Ctrl+C/X/V) between folders, **Delete** to the server's trash.
- **Copy path** copies the server path of the selected item or of the current folder.
- A photo's RapidRAW edits (`.rrdata`, virtual copies, `.rrexif`) move, copy, rename and delete together with it. *Show edit files* reveals them.
- When you switch back to **Editor**, RapidRAW reloads the current folder.

The Files tab only reaches inside those photo folders, and deleting goes to the trash, so it can be recovered.

### Configuration

| Variable | Default | |
|---|---|---|
| `RR_PHOTOS` | — (required by `run.sh`/`run.ps1`) | Photo library root on the server, also shown in the Files tab |
| `RR_PORT` / `RR_HOST` | `8780` / `0.0.0.0` | Listen address |
| `RR_AUTH` | off | `user:pass` → HTTP Basic auth for UI, files and IPC |
| `RR_CONFIG` | `<bridge data dir>/rrweb.json` | Where the photo library chosen in the RapidRAW Web window is stored |
| `RR_ORIGINS` | — | Extra allowed browser origins, comma-separated, e.g. `https://photos.example.com` behind a reverse proxy that changes the `Host` header |
| `RR_ROOTS` | photos + bridge data/cache dirs | Directories `/files` is allowed to serve |
| `RR_BRIDGE_BIN` | auto-detect | Path to `rapidraw-web-bridge` |
| `RR_VERBOSE` | off | Log every IPC call with timing |

### GPU in Docker (NVIDIA)

Vulkan inside a container needs the `graphics` driver capability, not just `compute`:

```yaml
runtime: nvidia
environment:
  NVIDIA_VISIBLE_DEVICES: all
  NVIDIA_DRIVER_CAPABILITIES: graphics,compute,utility
```

## Security

The IPC channel can do everything RapidRAW can do on the server (browse and write files, export, delete). **Do not expose it to the internet without `RR_AUTH` and a TLS reverse proxy**, or keep it behind a VPN. The bridge port accepts loopback connections only, `/files` serves only `RR_ROOTS`, the Files tab stays inside the photo folders, and requests from other websites (a foreign `Origin`) are refused.

## Limitations

- One active editing session at a time: RapidRAW's backend state is global, so two browsers editing different photos at once will interfere.
- The folder/file pickers browse only the photo folders; other server paths can be typed in with *Type a path…*.
- Desktop-only window features (window controls, native drag & drop from your OS) are no-ops. Tethering is not included.
- RapidRAW's folder tree shows folders created in the Files tab after you reopen the parent folder. Uploading whole folders (as opposed to files) is not supported yet.

## Building from source

```bash
git clone https://github.com/vedranius/rapidraw-web.git && cd rapidraw-web
./rrweb/build.sh                                  # needs Rust, Node 20+, webkit2gtk-4.1 dev
BUNDLES=deb,rpm,appimage ./rrweb/build.sh         # also build installer packages
RR_PHOTOS=~/Pictures RR_VERBOSE=1 ./rrweb/run.sh
```

## Versioning and staying in sync with RapidRAW

This repository is a GitHub fork of [CyberTimon/RapidRAW](https://github.com/CyberTimon/RapidRAW). A release carries two versions: **`rapidraw-v<RapidRAW>-web-v<rapidraw-web>`**, e.g. `rapidraw-v1.6.4-web-v1.1.0` is the unmodified RapidRAW `v1.6.4` with version `1.1.0` of this web layer. The web layer has its own version in [`rrweb/VERSION`](../rrweb/VERSION), so it can ship several updates for the same RapidRAW release.

Every release is **exactly an upstream release's code** plus one commit with the `rrweb/` layer, built and published by `rrweb-release.yml`. Releases come from two places (`rrweb-sync.yml`):
- **A new web version**: raising `rrweb/VERSION` on `main` (e.g. `1.1.0` → `1.1.1`) releases the current web layer on the latest RapidRAW release right away. The release notes list the web-layer commits since the previous web version.
- **A new RapidRAW release**: a daily job merges upstream `main` and, when RapidRAW publishes a release, releases it with the latest *published* web version (unreleased work on `main` waits for the next version bump).

Because rapidraw-web only adds files, upstream changes merge without conflicts. Before every build, `rrweb/check-shims.mjs` verifies that every Tauri API the RapidRAW UI imports is covered by the browser shims, and the list of forwarded backend events is regenerated from RapidRAW's source. If something new appears upstream, the build fails loudly and opens an issue instead of shipping a broken release.

## Thank you, Timon

RapidRAW is a beautiful, fast, genuinely free and open-source alternative to commercial RAW editors, built with remarkable care and pace. None of this would exist without it. If you use rapidraw-web, please ⭐ [star RapidRAW](https://github.com/CyberTimon/RapidRAW) and consider supporting its author on [Ko-fi](https://ko-fi.com/cybertimon).

## License

[AGPL-3.0](https://github.com/vedranius/rapidraw-web/blob/main/LICENSE), same as RapidRAW. If you run a modified version as a network service for others, the AGPL requires you to offer them its source code.
