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

1. Run `RapidRAW.Web.Bridge_*_x64-setup.exe`. It contains everything (RapidRAW, the web UI and Node.js), nothing else to install.
2. Start **RapidRAW Web Bridge** from the Start menu. It starts the server and opens RapidRAW in your browser.
3. The small RapidRAW Web window lists the addresses for other devices on your network (`http://<this-pc>:8780`). Closing it stops the server.

The first time, Windows Firewall asks about *Node.js JavaScript Runtime*: allow **Private networks** to reach it from other devices.

### Linux

On the server you need **Node.js 20+**, one **bridge** package and the **server bundle** (`rapidraw-web-server-*.tar.gz`).

```bash
# 1. Bridge — pick one
sudo apt install ./*.deb                                 # Debian / Ubuntu
sudo dnf install ./*.rpm                                 # Fedora / openSUSE (zypper)
chmod +x ./*.AppImage                                    # any distro: put it next to run.sh

# 2. Server bundle
tar xzf rapidraw-web-server-*.tar.gz && cd rapidraw-web-server-*
RR_PHOTOS=/mnt/photos ./run.sh
```

Open `http://<server>:8780`.

On a headless server (no `DISPLAY`/`WAYLAND_DISPLAY`) `run.sh` starts the bridge under `xvfb-run`, so install `xvfb`. The GPU is used through Vulkan and doesn't need a display.

The server bundle and `run.ps1` also work on Windows (`powershell -ExecutionPolicy Bypass -File .\run.ps1`) if you prefer starting it with the variables below.

## Files tab

Next to the editor there is a **Files** tab (top centre): a file manager for the photo folders on the server, so you can get your exports out and organise shoots without another tool.

- Browse the folders you opened in RapidRAW (plus `RR_PHOTOS`), with breadcrumbs, sorting and multi-select (Ctrl/Shift-click, Ctrl+A).
- **Download** a file, or several files and folders as one `.zip`; **Upload** files with the button or drag & drop.
- **New folder**, **Rename** (F2), **Copy/Cut → Paste** (Ctrl+C/X/V) between folders, **Delete** to the server's trash.
- A photo's RapidRAW edits (`.rrdata`, virtual copies, `.rrexif`) move, copy, rename and delete together with it. *Show edit files* reveals them.
- When you switch back to **Editor**, RapidRAW reloads the current folder.

The Files tab only reaches inside those photo folders, and deleting goes to the trash, so it can be recovered.

### Configuration

| Variable | Default | |
|---|---|---|
| `RR_PHOTOS` | — (required by `run.sh`/`run.ps1`) | Photo library root on the server, also shown in the Files tab |
| `RR_PORT` / `RR_HOST` | `8780` / `0.0.0.0` | Listen address |
| `RR_AUTH` | off | `user:pass` → HTTP Basic auth for UI, files and IPC |
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
- Open/Save dialogs are currently a text prompt with a server path.
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

This repository is a GitHub fork of [CyberTimon/RapidRAW](https://github.com/CyberTimon/RapidRAW), and its releases follow RapidRAW's exactly: **RapidRAW `v1.6.4` → rapidraw-web `v1.6.4-web`**.

A daily workflow (`rrweb-sync.yml`) merges upstream `main` and, when RapidRAW publishes a new release, tags `vX.Y.Z-web` on **exactly that upstream release's code** plus the `rrweb/` layer. That tag builds and publishes the matching rapidraw-web release. Because rapidraw-web only adds files, upstream changes merge without conflicts. Before every build, `rrweb/check-shims.mjs` verifies that every Tauri API the RapidRAW UI imports is covered by the browser shims, and the list of forwarded backend events is regenerated from RapidRAW's source. If something new appears upstream, the build fails loudly and opens an issue instead of shipping a broken release.

## Thank you, Timon

RapidRAW is a beautiful, fast, genuinely free and open-source alternative to commercial RAW editors, built with remarkable care and pace. None of this would exist without it. If you use rapidraw-web, please ⭐ [star RapidRAW](https://github.com/CyberTimon/RapidRAW) and consider supporting its author on [Ko-fi](https://ko-fi.com/cybertimon).

## License

[AGPL-3.0](https://github.com/vedranius/rapidraw-web/blob/main/LICENSE), same as RapidRAW. If you run a modified version as a network service for others, the AGPL requires you to offer them its source code.
