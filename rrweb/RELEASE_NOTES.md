**[{{UPSTREAM_TITLE}}](https://github.com/CyberTimon/RapidRAW/releases/tag/{{UPSTREAM_TAG}})**, unmodified, running on a machine on your network and used from your browser. For what's new in the editor itself, see the RapidRAW release linked above.

### What's new in rapidraw-web
{{RRWEB_CHANGES}}

### Downloads
- **Windows x64**: `RapidRAW.Web.Bridge_*_x64-setup.exe` is all-in-one (RapidRAW, web UI, Node.js). Install, start *RapidRAW Web Bridge* from the Start menu, and it opens in your browser.
- **Linux**: one bridge package plus the server bundle (needs Node.js 20+):
  - Bridge (RapidRAW in bridge mode, all processing on the server's GPU), x86_64 / aarch64: `.deb` (Debian/Ubuntu), `.rpm` (Fedora/openSUSE), `.AppImage` (any distro)
  - Server bundle `rapidraw-web-server-*.tar.gz` / `.zip`: the RapidRAW UI built for the browser, the relay and start scripts

Setup: [README → Quick start](https://github.com/vedranius/rapidraw-web#quick-start)

### Features
**Editor**: the real RapidRAW interface, every slider rendered by the server's GPU. **Files**: download exports (several files as .zip), upload, create folders, rename, copy, move and delete (to the trash) inside your photo folders; RapidRAW edits travel with their photos.

### Known limitations
One active editing session at a time · Open/Save dialogs are a path prompt · desktop-only window features and tethering are not available.

All credit for the editor goes to [Timon Käch (CyberTimon)](https://github.com/CyberTimon) and the RapidRAW contributors. If you like it, ⭐ [RapidRAW](https://github.com/CyberTimon/RapidRAW) and support it on [Ko-fi](https://ko-fi.com/cybertimon).
