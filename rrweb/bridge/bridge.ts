// Radi UNUTAR pravog RapidRAW (Tauri) procesa, umjesto UI-ja.
// Prima pozive s relaya, zove pravi invoke(), vraća rezultat; prosljeđuje sve evente.
// Ako relay ne radi (npr. pokrenut iz menija), pokreće ugrađeni (all-in-one paket) i otvara browser.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appCacheDir, appDataDir, delimiter, join, resourceDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import { Command, open } from '@tauri-apps/plugin-shell';
import { EVENTS } from './events';

declare const __RR_VERSION__: string;
declare const __RR_WEB_VERSION__: string;
const RELAY: string = import.meta.env.VITE_RR_RELAY ?? 'ws://127.0.0.1:8780/bridge';
const DEFAULT_UI = `http://localhost:${new URL(RELAY).port || 80}`; // relay s drugim RR_PORT-om ispiše svoje adrese
const NODE = '../rrweb/bundle/bin/rrweb-node'; // sidecar iz rrweb/bundle/prepare.mjs
const el = (id: string) => document.getElementById(id)!;
let ws: WebSocket | undefined;
let calls = 0;
let failures = 0;
let relay: 'external' | 'bundled' | 'none' | undefined; // tko je pokrenuo relay
let opened = false;
let relayExited = false;
let quickExits = 0; // ugrađeni relay koji pada odmah nakon pokretanja (npr. zauzet port) ne pokrećemo beskonačno
let library: string | null | undefined; // undefined = relay još nije javio
const urls = new Set<string>(); // "[relay] url …" linije ugrađenog relaya

const send = (o: unknown) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
EVENTS.forEach((ev) => listen(ev, (e) => send({ event: ev, payload: e.payload })));

// Na Windowsu/macOS-u RapidRAW po defaultu crta preview izravno u nativni prozor (wgpu surface)
// i vraća "WGPU_RENDER" umjesto slike → browser ništa ne vidi. Bridge ga zato uvijek drži isključenim.
// Mora prije prvog obrade slike: GPU kontekst (i surface) se stvara lijeno.
type Settings = Record<string, unknown>;
async function disableNativeRenderer() {
  const s = await invoke<Settings>('load_settings');
  if (s.useWgpuRenderer !== false) await invoke('save_settings', { settings: { ...s, useWgpuRenderer: false } });
}

function status(text: string, ok = false) {
  el('s').textContent = text;
  el('s').className = ok ? 'ok' : '';
}
function log(line: string) {
  const l = el('log');
  l.textContent = (l.textContent + line.trimEnd() + '\n').split('\n').slice(-30).join('\n');
}
function showUrls() {
  el('urls').replaceChildren(...(urls.size ? [...urls] : [DEFAULT_UI]).map((url) => {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.onclick = (e) => { e.preventDefault(); open(url); };
    return a;
  }));
}

async function startBundledRelay() {
  relay = 'bundled';
  status('Starting server…');
  const started = Date.now();
  try {
    const script = await join(await resourceDir(), '_up_', 'rrweb', 'relay', 'relay.mjs');
    const env = {
      RR_ROOTS: [await appDataDir(), await appCacheDir()].join(delimiter()),
      RR_CONFIG: await join(await appDataDir(), 'rrweb.json'),
      RR_WORK: await join(await appCacheDir(), 'remote'),
      RR_APP_CACHE: await appCacheDir(),
      RR_LOG: await join(await appDataDir(), 'logs', 'relay.log'),
      RR_EXIT_WITH_PARENT: '1',
    };
    const cmd = Command.sidecar(NODE, [script], { env });
    const line = (l: string) => {
      log(l);
      const m = /^\[relay\] url (\S+)/.exec(l);
      if (m) { urls.add(m[1]); showUrls(); }
    };
    cmd.stdout.on('data', line);
    cmd.stderr.on('data', line);
    cmd.on('close', ({ code }) => {
      log(`[relay] stopped (exit ${code})`);
      // pad relaya: pokreni ga ponovno, browser i bridge se sami ponovno spoje
      quickExits = Date.now() - started < 10000 ? quickExits + 1 : 0;
      if (quickExits < 3) { status('Server stopped, restarting…'); setTimeout(startBundledRelay, 2000); return; }
      relayExited = true;
      status('Server stopped, see the log below. Restart the app.');
    });
    await cmd.spawn();
    el('hint').textContent = 'Open RapidRAW in your browser (other devices: use your network address). Close this window to stop the server.';
  } catch (e) {
    // Nema ugrađenog relaya (ručni build bez rrweb/bundle overlaya): relay pokreće run.sh / run.ps1
    relay = 'none';
    log(String(e));
    el('hint').textContent = 'No bundled server in this build. Start rapidraw-web with run.sh / run.ps1 from the server bundle.';
  }
}

function connect() {
  const sock = new WebSocket(RELAY);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    failures = 0;
    relay ??= 'external';
    status('Running', true);
    if (relay !== 'bundled') el('hint').textContent = '';
  };
  sock.onclose = () => {
    if (relay === undefined && ++failures >= 2) startBundledRelay(); // ~1 s čekanja da run.sh/run.ps1 stigne pokrenuti svoj relay
    else if (!relayExited && (relay !== 'bundled' || opened)) status(`Server offline, retrying… (${RELAY})`);
    setTimeout(connect, 1000);
  };
  sock.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.rr === 'library') {
      // prva poruka ugrađenog relaya: otvori RapidRAW u browseru, osim na serveru bez ekrana
      if (relay === 'bundled' && !opened) {
        opened = true;
        if (!msg.headless) open([...urls][0] ?? DEFAULT_UI).catch(() => {});
      }
      showLibrary(msg.path ?? msg.env); // s odabranim libraryjem prozor se minimizira, bez njega ostaje otvoren
      return;
    }
    const { id, cmd, args } = msg;
    if (cmd === 'save_settings' && args?.settings) args.settings.useWgpuRenderer = false;
    try {
      const result: unknown = await invoke(cmd, args);
      const bytes = result instanceof ArrayBuffer ? new Uint8Array(result)
        : result instanceof Uint8Array ? result : null;
      if (bytes) {
        const frame = new Uint8Array(4 + bytes.byteLength);
        new DataView(frame.buffer).setUint32(0, id, true);
        frame.set(bytes, 4);
        sock.send(frame);
      } else send({ id, result: result ?? null });
    } catch (error) {
      send({ id, error: String(error) });
    }
    el('calls').textContent = `${++calls} calls · last: ${cmd}`;
  };
}

// Photo library: folder s fotografijama na OVOM računalu, uvijek prvi u Files tabu i dijalozima u browseru
function showLibrary(path: string | null) {
  const first = library === undefined;
  library = path;
  el('libpath').textContent = path ?? 'not chosen yet';
  el('lib').className = path ? '' : 'todo';
  if (first && path && relay === 'bundled' && opened) getCurrentWindow().minimize();
}
el('libpick').onclick = async () => {
  const p = await pickFolder({ directory: true, title: 'Photo library folder', defaultPath: library ?? undefined });
  if (typeof p === 'string') send({ rr: 'set-library', path: p });
};

el('ver').textContent = `RapidRAW ${__RR_VERSION__} · web ${__RR_WEB_VERSION__}`;
el('min').onclick = () => getCurrentWindow().minimize();
el('close').onclick = () => getCurrentWindow().close();
showUrls();
disableNativeRenderer().catch((e) => console.error('rrweb: useWgpuRenderer', e)).finally(connect);
