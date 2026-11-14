**[{{UPSTREAM_TITLE}}](https://github.com/CyberTimon/RapidRAW/releases/tag/{{UPSTREAM_TAG}})**, with **rapidraw-web v{{WEB_VERSION}}** and this fork's AI layer: it runs on a machine on your network and you use it from your browser. For what's new in the editor itself, see the RapidRAW release linked above.

### What's new in rapidraw-web v{{WEB_VERSION}}
{{RRWEB_CHANGES}}

### Downloads
Install on the computer that has your photos and the GPU; open it from any browser on your network.

| OS | Download | |
|---|---|---|
| **Windows** 10/11, x64 | `…_windows_x64-setup.exe` | All-in-one installer. Start *RapidRAW Web Bridge* from the Start menu. For on-demand folders also install [WinFsp](https://winfsp.dev). |
| **macOS**, Apple Silicon | `…_macos_arm64.dmg` | All-in-one app (experimental). Not notarized: the first time, right-click the app → *Open* (or *System Settings → Privacy & Security → Open Anyway*). |
| **macOS**, Intel | `…_macos_x64.dmg` | Same as above. |
| **Linux**, x64 | `…_linux_x64.deb` (Debian/Ubuntu), `.rpm` (Fedora/openSUSE) **or** `.AppImage` (any distro) | All-in-one, one file. Desktop: start *RapidRAW Web Bridge* from the menu. Server without a screen: `systemctl --user enable --now rapidraw-web`. |
| **Linux**, arm64 | `…_linux_arm64.deb` / `.rpm` / `.AppImage` | Same as above. |
| Linux, optional | `…_linux_server.tar.gz` | Relay + web UI with `run.sh`, for Docker or starting the parts yourself (needs Node.js 20+ and a bridge package). |

Package version: `{{PKG_VERSION}}`, so installing a newer web release over an older one upgrades it, also on the same RapidRAW version.

**Updating:** from v1.16.0 on, RapidRAW Web updates itself: click the green *Update* badge at the top of the page (or *Update now* in the RapidRAW Web window on the server). Older versions: install the new package over the old one once.

Setup: [README → Quick start](https://github.com/vedranius/rapidraw-web/blob/main/.github/README.md#quick-start)

### Features
**Editor**: the real RapidRAW interface, every slider rendered by the server's GPU. **Photo library**: chosen once on the server; folder and file pickers in the browser start there. **This computer**: edit photos that stay in a folder on the computer you browse from (copied in the background, or on demand with a Linux or Windows server; Chrome/Edge over HTTPS). **Connection badge**: recommends the preview quality for your connection. **Files**: download exports (several files as .zip), upload, create folders, rename, copy, move and delete (to the trash) inside your photo folders; RapidRAW edits travel with their photos.

**AI layer in this fork**: content-aware AI culling (composition, light, scene and subject), AI Style profiles with per-image adaptation and histogram protection, and an AI Editor that turns natural-language requests into auditable plans across 37 RapidRAW commands. Use a local Ollama model, any OpenAI-compatible endpoint or Anthropic Claude; the deterministic local planner stays available. See [AI_EDITOR.md](https://github.com/vedranius/rapidraw-web/blob/main/AI_EDITOR.md).

### Known limitations
One active editing session at a time · pickers only browse the photo folders (other paths can be typed) · desktop-only window features and tethering are not available.

All credit for the editor goes to [Timon Käch (CyberTimon)](https://github.com/CyberTimon) and the RapidRAW contributors. If you like it, ⭐ [RapidRAW](https://github.com/CyberTimon/RapidRAW) and support it on [Ko-fi](https://ko-fi.com/cybertimon).
