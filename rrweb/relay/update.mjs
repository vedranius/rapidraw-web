// One-click updates for the installed RapidRAW Web: the relay checks GitHub for a newer rapidraw-web release, and on
// request downloads the matching installer and installs it, then RapidRAW Web restarts by itself.
//   Windows   …_windows_x64-setup.exe   run with /P /R /UPDATE (passive NSIS: closes the app, installs, starts it again)
//   macOS     …_macos_<arch>.dmg        mounted, the .app replaced in place, quarantine removed, started again
//   Linux     …_linux_<arch>.AppImage   the AppImage file replaced in place and started again
//             …_linux_<arch>.deb/.rpm   installed with pkexec (desktop) or passwordless sudo (server), then restarted
//                                       (the systemd user service with systemctl --user restart)
// Only the bundled relay (started by the bridge, which passes RR_TAG) installs; run.sh/run.ps1 only report updates.
// Env: RR_UPDATE_REPO (vedranius/rapidraw-web), RR_NO_UPDATE=1 (no checks at all).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

export const TAG_RE = /^rapidraw-v(\d+\.\d+\.\d+)-web-v(\d+\.\d+\.\d+)$/;
const cmpVer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
export function parseTag(tag) {
  const m = TAG_RE.exec(tag ?? '');
  return m ? { up: m[1], web: m[2] } : null;
}
// A release is newer when its web layer is newer, or the same web layer ships on a newer RapidRAW
export function isNewer(candidate, current) {
  const c = parseTag(candidate), n = parseTag(current);
  if (!c || !n) return false;
  const w = cmpVer(c.web, n.web);
  return w > 0 || (w === 0 && cmpVer(c.up, n.up) > 0);
}

// How this copy was installed: decides which release file replaces it and how
export function installKind({ platform = process.platform, env = process.env, execPath = process.execPath,
  exists = fs.existsSync } = {}) {
  if (platform === 'win32') return { kind: 'nsis', dir: path.win32.dirname(execPath) };
  if (platform === 'darwin') {
    const m = /^(.*?\.app)\/Contents\//.exec(execPath);
    return m ? { kind: 'dmg', app: m[1] } : null;
  }
  if (platform === 'linux') {
    if (env.APPIMAGE) return { kind: 'appimage', file: env.APPIMAGE };
    if (execPath.startsWith('/usr/')) return { kind: exists('/etc/debian_version') ? 'deb' : 'rpm' };
  }
  return null;
}

export function pickAsset(assets, { kind }, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  const suffix = {
    nsis: '_windows_x64-setup.exe',
    dmg: `_macos_${a}.dmg`,
    appimage: `_linux_${a}.AppImage`,
    deb: `_linux_${a}.deb`,
    rpm: `_linux_${a}.rpm`,
  }[kind];
  return suffix ? assets.find((x) => x.name.endsWith(suffix)) ?? null : null;
}

const sh = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

export function createUpdater({ work, headless = false, quitBridge = () => {}, notify = () => {} }) {
  const REPO = process.env.RR_UPDATE_REPO ?? 'vedranius/rapidraw-web';
  const current = process.env.RR_TAG ?? null;
  const install = current ? installKind() : null;
  const dir = path.join(path.dirname(work), 'rrweb-updates'); // next to RR_WORK, which remote.mjs manages
  const state = { current, latest: null, available: false, notes: '', url: null, publishedAt: null,
    canInstall: false, phase: 'idle', progress: 0, error: null, manual: null, checkedAt: 0 };
  let asset = null;
  let checking = null;

  const view = () => ({ ...state });
  const set = (patch) => { Object.assign(state, patch); notify(view()); };

  async function check(force = false) {
    if (process.env.RR_NO_UPDATE || !current) return view();
    if (!force && Date.now() - state.checkedAt < 30 * 60000) return view();
    checking ??= (async () => {
      try {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'rapidraw-web-updater' },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
        const rel = await r.json();
        asset = install ? pickAsset(rel.assets ?? [], install) : null;
        const available = isNewer(rel.tag_name, current);
        set({ latest: rel.tag_name, available, notes: String(rel.body ?? '').slice(0, 20000), url: rel.html_url,
          publishedAt: rel.published_at, canInstall: available && !!asset, checkedAt: Date.now(),
          error: state.phase === 'error' ? state.error : null });
        if (available) console.log(`[update] ${rel.tag_name} is available (this is ${current})`);
      } catch (e) {
        state.checkedAt = Date.now() - 25 * 60000; // try again in ~5 min
        console.warn(`[update] check failed: ${e.message}`);
      } finally { checking = null; }
      return view();
    })();
    return checking;
  }

  async function download() {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, recursive: true }); // older updates
    const file = path.join(dir, asset.name);
    const r = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'rapidraw-web-updater' } });
    if (!r.ok || !r.body) throw new Error(`download: HTTP ${r.status}`);
    const total = +(r.headers.get('content-length') ?? asset.size ?? 0);
    const hash = createHash('sha256');
    const out = fs.createWriteStream(file);
    let got = 0, last = 0;
    try {
      for await (const chunk of r.body) {
        got += chunk.length;
        hash.update(chunk);
        if (total && Date.now() - last > 250) { last = Date.now(); set({ progress: got / total }); }
        if (!out.write(chunk)) await once(out, 'drain');
      }
    } finally { out.end(); }
    await once(out, 'close');
    if (asset.size && got !== asset.size) throw new Error(`download incomplete (${got} of ${asset.size} bytes)`);
    const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
    if (want && hash.digest('hex') !== want) throw new Error('download is damaged (SHA-256 does not match)');
    return file;
  }

  // A detached helper survives the bridge (and this relay) exiting, then puts the new version in place
  const detached = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const helper = (script) => {
    const f = path.join(dir, 'update.sh');
    fs.writeFileSync(f, `#!/bin/sh\n# rapidraw-web update helper\nwhile kill -0 ${process.ppid} 2>/dev/null; do sleep 1; done\nsleep 2\n${script}\n`, { mode: 0o755 });
    detached('/bin/sh', [f]);
  };

  function linuxPackage(file) {
    const cmd = install.kind === 'deb' ? ['apt-get', 'install', '-y', file]
      : has('dnf') ? ['dnf', 'install', '-y', file] : has('zypper') ? ['zypper', '--non-interactive', 'install', '--allow-unsigned-rpm', file]
        : ['rpm', '-U', file];
    const manual = `sudo ${cmd.join(' ')}${headless ? ' && systemctl --user restart rapidraw-web' : ''}`;
    const graphical = !headless && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && has('pkexec');
    const elevate = process.getuid?.() === 0 ? [] : graphical ? ['pkexec'] : spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0 ? ['sudo', '-n'] : null;
    if (!elevate) { const e = new Error('installing needs administrator rights'); e.manual = manual; throw e; }
    set({ phase: 'installing' });
    const [bin, ...args] = [...elevate, ...cmd];
    const r = spawnSync(bin, args, { stdio: 'inherit' });
    if (r.status !== 0) { const e = new Error(`${cmd[0]} failed (exit ${r.status})`); e.manual = manual; throw e; }
    if (headless && process.env.INVOCATION_ID) { // systemd service: it restarts the whole unit, relay included
      detached('systemctl', ['--user', 'restart', '--no-block', 'rapidraw-web']);
    } else {
      helper(`setsid /usr/bin/rapidraw-web-bridge >/dev/null 2>&1 &`);
      quitBridge();
    }
  }

  async function apply() {
    if (!state.canInstall || !asset || !install) throw new Error('no update to install');
    if (['downloading', 'installing', 'restarting'].includes(state.phase)) return view();
    set({ phase: 'downloading', progress: 0, error: null, manual: null });
    (async () => {
      try {
        const file = await download();
        set({ phase: 'installing', progress: 1 });
        console.log(`[update] installing ${asset.name} (${install.kind})`);
        if (install.kind === 'nsis') {
          detached(file, ['/P', '/R', '/UPDATE']); // passive installer closes RapidRAW Web itself and starts it again
          set({ phase: 'restarting' });
          setTimeout(quitBridge, 4000);
        } else if (install.kind === 'dmg') {
          const mnt = path.join(dir, 'mnt');
          helper([
            `mkdir -p ${sh(mnt)} && hdiutil attach -nobrowse -readonly -mountpoint ${sh(mnt)} ${sh(file)} || exit 1`,
            `src=$(ls -d ${sh(mnt)}/*.app | head -1)`,
            `rm -rf ${sh(install.app + '.new')} && ditto "$src" ${sh(install.app + '.new')} && rm -rf ${sh(install.app)} && mv ${sh(install.app + '.new')} ${sh(install.app)}`,
            `hdiutil detach ${sh(mnt)} -quiet`,
            `xattr -dr com.apple.quarantine ${sh(install.app)} 2>/dev/null`,
            `open ${sh(install.app)}`,
          ].join('\n'));
          set({ phase: 'restarting' });
          quitBridge();
        } else if (install.kind === 'appimage') {
          fs.chmodSync(file, 0o755);
          helper(`mv -f ${sh(file)} ${sh(install.file)} && chmod +x ${sh(install.file)}\nsetsid ${sh(install.file)} >/dev/null 2>&1 &`);
          set({ phase: 'restarting' });
          quitBridge();
        } else {
          linuxPackage(file);
          set({ phase: 'restarting' });
        }
      } catch (e) {
        console.warn(`[update] ${e.message}`);
        set({ phase: 'error', error: e.message, manual: e.manual ?? null });
      }
    })();
    return view();
  }

  if (current && !process.env.RR_NO_UPDATE) {
    setTimeout(() => check(true), 15000).unref(); // not while RapidRAW is still starting
    setInterval(() => check(true), 6 * 3600000).unref();
  }
  return { check, apply, view, install };
}
