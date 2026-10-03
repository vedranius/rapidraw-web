// rrweb relay: servira web UI, /files (thumbnaili, slike), i spaja browser klijente s bridgeom.
//
// Env:
//   RR_PORT   (8780)        port
//   RR_HOST   (0.0.0.0)     bind adresa
//   RR_ROOTS  (obavezno)    path.delimiter-odvojeni (':' Linux, ';' Windows) direktoriji koje /files smije servirati
//   RR_AUTH   (opcionalno)  "user:pass" → HTTP Basic za UI, /files, /fm i /ipc
//   RR_PHOTOS (opcionalno)  dodatni folder za Files tab (uz foldere otvorene u RapidRAW-u)
//   RR_CONFIG (opcionalno)  JSON s postavkama relaya ({"library": "<photo library folder>"}), piše ga bridge prozor
//   RR_ORIGINS (opcionalno) zarezom odvojeni dodatni dopušteni Origin-i (npr. https://photos.example.com iza proxyja)
//   RR_WORK   (tmp/rrweb-remote) radni folder za foldere s klijenta (mirror, cache, FUSE mountovi)
//   RR_APP_CACHE              RapidRAW-ov cache folder (thumbnails/ za RAF-ove "na zahtjev", rrweb/relay/raf.mjs);
//                             bez njega se nauči iz prvog thumbnaila
//   RR_FUSE_BIN               rrweb-fuse binarka (default ../fuse/<arch>/rrweb-fuse[.exe] ili pored Node.js-a)
//   RR_BRIDGE_PORT (8780)   loopback port na koji se spaja bridge (VITE_RR_RELAY pri buildu bridgea)
//   RR_DIST   (../dist-web)
//   RR_NO_BROWSER=1           bridge ne otvara browser (server bez ekrana; pod xvfb-run se prepozna samo)
//   RR_LOG                    kopija ispisa u fajl (bridge/run.sh: <app data>/logs/relay.log; do 5 MB, pa .1)
// FUSE pozivi iz samog relaya (Files tab na folderu s klijenta) i odgovori na njih dijele libuv threadpool
process.env.UV_THREADPOOL_SIZE ??= '64';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { WebSocketServer } from 'ws';
import { createFiles, validName } from './files.mjs';
import { createRemote, editor } from './remote.mjs';
import { createRaf } from './raf.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Ugrađeni relay piše samo u prozor bridgea: kopija u fajl, da se greške (npr. pad RapidRAW-a) mogu naknadno vidjeti
if (process.env.RR_LOG) {
  try {
    const LOG = process.env.RR_LOG;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (fs.statSync(LOG, { throwIfNoEntry: false })?.size > 5 << 20) fs.renameSync(LOG, `${LOG}.1`);
    const out = fs.createWriteStream(LOG, { flags: 'a' });
    out.on('error', () => {});
    for (const k of ['log', 'warn', 'error']) {
      const orig = console[k].bind(console);
      console[k] = (...a) => { orig(...a); out.write(`${new Date().toISOString()} ${format(...a)}\n`); };
    }
  } catch (e) { console.warn(`[relay] RR_LOG: ${e.message}`); }
}
const PORT = +(process.env.RR_PORT ?? 8780);
const BRIDGE_PORT = +(process.env.RR_BRIDGE_PORT ?? 8780); // = port iz VITE_RR_RELAY u bridge buildu
const HOST = process.env.RR_HOST ?? '0.0.0.0';
const DIST = path.resolve(process.env.RR_DIST ?? path.join(here, '../dist-web'));
const AUTH = process.env.RR_AUTH ? 'Basic ' + Buffer.from(process.env.RR_AUTH).toString('base64') : null;
const ROOTS = (process.env.RR_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((r) => fs.realpathSync(r));
if (!ROOTS.length) { console.error('RR_ROOTS nije postavljen'); process.exit(1); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
const SPEED = randomBytes(16 << 20); // nasumično, da ga proxy/gzip ne smanji
const isLoopback = (a = '') => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const authed = (req) => !AUTH || req.headers.authorization === AUTH;
const underRoots = (p) => ROOTS.some((r) => p === r || p.startsWith(r + path.sep));
// Browser uvijek šalje Origin: prihvati samo vlastiti host (ili RR_ORIGINS), da tuđa stranica ne može do /ipc i /fm
const ORIGINS = (process.env.RR_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o || ORIGINS.includes(o)) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function sendFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': cache, 'Last-Modified': st.mtime.toUTCString() });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RapidRAW"' }).end(); return; }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/files') {
    let real;
    try { real = fs.realpathSync(u.searchParams.get('path') ?? ''); } catch { res.writeHead(404).end(); return; }
    if (!underRoots(real)) { console.warn('[files] 403 izvan RR_ROOTS:', real); res.writeHead(403).end(); return; }
    sendFile(res, real, 'private, max-age=60');
    return;
  }
  if (u.pathname.startsWith('/fm/')) {
    if (req.method !== 'GET' && !sameOrigin(req)) { res.writeHead(403).end(); return; }
    files.http(req, res, u);
    return;
  }
  if (u.pathname === '/rr/speed') { // test brzine veze za preporuku kvalitete previewa (rrweb/files/network.ts)
    editor.touch(); // za vrijeme mjerenja pozadinski prijenosi (folderi s klijenta) miruju
    if (req.method === 'POST') { // upload: browser šalje, relay samo broji
      let n = 0;
      req.on('data', (c) => { n += c.length; });
      req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ bytes: n })));
      return;
    }
    const n = Math.min(Math.max(+u.searchParams.get('bytes') || 0, 1 << 16), SPEED.length);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': n, 'Cache-Control': 'no-store' });
    res.end(SPEED.subarray(0, n));
    return;
  }
  if (u.pathname.startsWith('/rfs/')) {
    if (!sameOrigin(req)) { res.writeHead(403).end(); return; }
    remote.http(req, res, u);
    return;
  }
  const rel = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) sendFile(res, file, rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    else sendFile(res, path.join(DIST, 'index.html'), 'no-cache');
  });
});

// --- IPC routing ---
let bridge = null;
const clients = new Set();
const inflight = new Map(); // relayId -> { client, id, cmd, t0 }
let rid = 0;
// Photo library folder: bira se u RapidRAW Web prozoru na serveru (nativni dijalog), sprema u RR_CONFIG
const CONFIG = process.env.RR_CONFIG;
let config = {};
try { if (CONFIG && fs.existsSync(CONFIG)) config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { console.warn(`[relay] ${CONFIG}: ${e.message}`); }
function setLibrary(p) {
  if (!fs.statSync(p).isDirectory()) throw new Error('not a folder');
  config.library = fs.realpathSync(p);
  if (CONFIG) fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  files.invalidate();
  console.log(`[relay] photo library: ${config.library}`);
}
// Server bez ekrana (systemd servis, xvfb-run): bridge ne otvara browser (xdg-open/kde-open bez ekrana samo padne)
const HEADLESS = !!process.env.RR_NO_BROWSER || /xvfb-run/.test(process.env.XAUTHORITY ?? '');
const libraryState = () => ({ rr: 'library', path: config.library ?? null, env: process.env.RR_PHOTOS ?? null, headless: HEADLESS });

const files = createFiles({
  settings: () => bridgeCall('load_settings', {}),
  bridge: bridgeCall,
  library: () => config.library ?? null,
  extraRoots: () => [...(process.env.RR_PHOTOS ? [process.env.RR_PHOTOS] : []), ...remote.roots()],
  labels: () => remote.labels(),
});
// Folderi s klijentskog računala (browser je pohrana): rrweb/relay/remote.mjs
const remote = createRemote({ validName, insideRoots: (p) => files.within(p), onChange: () => files.invalidate() });
// Fuji RAF iz foldera "na zahtjev": thumbnail i EXIF iz ugrađenog JPEG-a umjesto cijelog fajla (rrweb/relay/raf.mjs)
const raf = createRaf({
  locate: (p) => remote.locate(p),
  offline: (p) => remote.offline(p),
  settings: () => bridgeCall('load_settings', {}),
  bridge: bridgeCall,
  work: remote.work,
});
const LOCAL = { __rr_home: () => os.homedir(), __rr_ping: () => Date.now(), ...files.commands, ...remote.commands };

// Poziv RapidRAW komande iz samog relaya (Files tab: postavke, brisanje u koš)
function bridgeCall(cmd, args) {
  return new Promise((resolve, reject) => {
    if (!bridge) { reject(new Error('RapidRAW bridge nije spojen')); return; }
    rid = (rid + 1) >>> 0 || 1;
    const client = { send: (data, opts) => {
      if (opts?.binary) { resolve(data.subarray(4)); return; }
      const m = JSON.parse(data);
      'error' in m ? reject(new Error(String(m.error))) : resolve(m.result);
    } };
    inflight.set(rid, { client, id: 0, cmd, t0: process.hrtime.bigint() });
    bridge.send(JSON.stringify({ id: rid, cmd, args }));
  });
}

const wssClient = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 << 20 });
const wssBridge = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 30 });
const wssRfs = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 << 20 });

const upgrade = (bridgeOnly) => (req, sock, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/bridge' && isLoopback(req.socket.remoteAddress)) wssBridge.handleUpgrade(req, sock, head, (ws) => wssBridge.emit('connection', ws));
  else if (p === '/ipc' && !bridgeOnly && authed(req) && sameOrigin(req)) wssClient.handleUpgrade(req, sock, head, (ws) => wssClient.emit('connection', ws));
  else if (p === '/rfs' && !bridgeOnly && authed(req) && sameOrigin(req)) {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    wssRfs.handleUpgrade(req, sock, head, (ws) => remote.attach(ws, id));
  }
  else sock.destroy();
};
server.on('upgrade', upgrade(false));
// Bridge se uvijek spaja na 127.0.0.1:8780 (VITE_RR_RELAY u bridge buildu), pa uz drugi RR_PORT slušaj i tamo
// (samo ako 8780 nitko ne koristi: Windows inače dopusti 127.0.0.1:8780 pored tuđeg 0.0.0.0:8780 i preotme mu promet)
if (PORT !== BRIDGE_PORT) {
  const probe = net.connect(BRIDGE_PORT, '127.0.0.1');
  probe.on('connect', () => {
    probe.destroy();
    console.error(`[relay] port ${BRIDGE_PORT} is used by another program: the RapidRAW bridge cannot reach this relay`);
  });
  probe.on('error', () => {
    http.createServer((_req, res) => res.writeHead(404).end()).on('upgrade', upgrade(true))
      .on('error', (e) => console.error(`[relay] bridge port ${BRIDGE_PORT}: ${e.message}`))
      .listen(BRIDGE_PORT, '127.0.0.1');
  });
}

// WebSocket bez 'error' listenera baca grešku (neispravan okvir, prekinuta veza kroz tunel) i ruši cijeli relay
const quiet = (ws, what) => ws.on('error', (e) => console.warn(`[relay] ${what}: ${e.message}`));
// tuneli i proxyji (Cloudflare: 100 s) zatvaraju WebSocket koji miruje
const keepalive = (ws) => {
  const t = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 20000);
  ws.on('close', () => clearInterval(t));
};

wssBridge.on('connection', (ws) => {
  if (bridge) bridge.close();
  bridge = ws;
  quiet(ws, 'bridge');
  console.log('[relay] bridge connected');
  ws.send(JSON.stringify(libraryState()));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const r = data.readUInt32LE(0);
      const f = inflight.get(r); inflight.delete(r);
      if (!f) return;
      if (f.cmd === 'load_image') editor.loaded(r);
      data.writeUInt32LE(f.id, 0);           // prepiši relayId → id klijenta
      f.client.send(data, { binary: true });
      log(f, data.length - 4);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.rr === 'set-library') {
      try { setLibrary(msg.path); } catch (e) { console.error(`[relay] photo library ${msg.path}: ${e.message}`); }
      ws.send(JSON.stringify(libraryState()));
      return;
    }
    if (msg.event !== undefined) {
      if (msg.event === 'thumbnail-generated') {
        raf.learn(msg.payload?.thumbnailPath);
        raf.generated(msg.payload?.path);
      }
      // thumbnaile RapidRAW-u dozira relay (raf.mjs): dok ih još ima, UI vidi relayev napredak
      if (msg.event === 'thumbnail-progress' || msg.event === 'thumbnail-generation-complete') {
        if (msg.event === 'thumbnail-generation-complete') raf.drained();
        const p = raf.progress();
        if (p) {
          if (msg.event === 'thumbnail-generation-complete') return;
          msg.payload = p;
        }
      }
      const s = JSON.stringify(msg);
      clients.forEach((c) => c.send(s));
      return;
    }
    const f = inflight.get(msg.id); inflight.delete(msg.id);
    if (!f) return;
    if (f.cmd === 'load_image') editor.loaded(msg.id);
    msg.id = f.id;
    f.client.send(JSON.stringify(msg));
    log(f);
  });
  ws.on('close', () => {
    if (bridge === ws) bridge = null;
    console.log('[relay] bridge disconnected');
    for (const [r, f] of inflight) { f.client.send(JSON.stringify({ id: f.id, error: 'bridge disconnected' })); inflight.delete(r); }
    editor.loads.clear();
  });
});

wssClient.on('connection', (ws, req) => {
  clients.add(ws);
  quiet(ws, 'client');
  keepalive(ws);
  console.log(`[relay] client +1 (${clients.size})`);
  ws.on('message', async (data) => {
    let id, cmd, args;
    try { ({ id, cmd, args } = JSON.parse(data)); } catch { return; }
    if (LOCAL[cmd]) {
      try { ws.send(JSON.stringify({ id, result: (await LOCAL[cmd](args ?? {})) ?? null })); }
      catch (e) { ws.send(JSON.stringify({ id, error: e.message ?? String(e) })); }
      return;
    }
    if (!bridge) { ws.send(JSON.stringify({ id, error: 'RapidRAW bridge nije spojen' })); return; }
    // Fotka iz foldera s računala koje nije spojeno: RapidRAW je ne smije čitati (greška čitanja kroz mmap ga sruši)
    if (typeof args?.path === 'string' && remote.offline(args.path)) {
      ws.send(JSON.stringify({ id, error: 'The folder on the computer you are browsing from is not connected. Open RapidRAW Web in Chrome or Edge on that computer (Files → This computer → Reconnect).' }));
      return;
    }
    if (cmd === 'read_exif_for_paths' && Array.isArray(args?.paths)) {
      raf.readExif(args.paths).then(
        (result) => ws.send(JSON.stringify({ id, result: result ?? null })),
        (e) => ws.send(JSON.stringify({ id, error: e.message ?? String(e) })));
      return;
    }
    // thumbnaile RapidRAW-u predaje relay (raf.mjs), tako da fotka u editoru ima prednost; prazna lista (poništi) ide dalje
    if (cmd === 'update_thumbnail_queue' && Array.isArray(args?.paths) && !raf.takeThumbs(args.paths)) {
      ws.send(JSON.stringify({ id, result: null }));
      return;
    }
    rid = (rid + 1) >>> 0 || 1;
    if (EDIT_CMDS.has(cmd)) editor.touch();
    if (cmd === 'load_image') { // otvorena fotka ima prednost pred svim pozadinskim prijenosima i thumbnailima
      editor.loading(rid);
      remote.focus(args?.path);
    }
    inflight.set(rid, { client: ws, id, cmd, t0: process.hrtime.bigint() });
    bridge.send(JSON.stringify({ id: rid, cmd, args }));
  });
  ws.on('close', () => {
    clients.delete(ws);
    for (const [r, f] of inflight) if (f.client === ws) { inflight.delete(r); editor.loaded(r); }
  });
});

const VERBOSE = !!process.env.RR_VERBOSE;
// Rad u editoru: dok traje (i par sekundi nakon), pozadina (thumbnaili, folderi s klijenta) miruje (remote.mjs: editor)
const EDIT_CMDS = new Set(['load_image', 'apply_adjustments', 'generate_uncropped_preview', 'generate_mask_overlay',
  'generate_preset_preview', 'apply_denoising', 'generate_ai_foreground_mask', 'generate_ai_sky_mask', 'generate_ai_subject_mask']);
function log(f, bytes) {
  if (!VERBOSE && bytes === undefined) return;
  const ms = Number(process.hrtime.bigint() - f.t0) / 1e6;
  console.log(`[ipc] ${f.cmd} ${ms.toFixed(1)}ms${bytes !== undefined ? ` ${(bytes / 1024).toFixed(0)}KB` : ''}`);
}

// Relay koji je pokrenuo bridge (Windows installer) gasi se s njim. RapidRAW izlazi mimo Tauri Exit eventa,
// pa shell plugin ne stigne ubiti child proces; ovo pokriva i rušenje bridgea.
// Na Linuxu siroče dobije novog roditelja (systemd, init), pa se provjerava i promjena roditelja.
if (process.env.RR_EXIT_WITH_PARENT) {
  const parent = process.ppid;
  setInterval(() => {
    let alive = process.ppid === parent;
    try { process.kill(parent, 0); } catch { alive = false; }
    if (!alive) { console.log('[relay] bridge exited, stopping'); shutdown(); }
  }, 2000).unref();
}
// Na izlazu odmontiraj FUSE foldere s klijenta (inače ostaje "Transport endpoint is not connected")
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 10000).unref(); // gašenje ne smije zapeti (npr. na mrtvom FUSE mountu) i držati port
  await remote.shutdown();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
// Greška u jednom zahtjevu ne smije srušiti relay: RapidRAW bi ostao bez veze, a FUSE mountovi mrtvi
process.on('uncaughtException', (e) => console.error('[relay] uncaught exception:', e));
process.on('unhandledRejection', (e) => console.error('[relay] unhandled rejection:', e));

server.on('error', (e) => { console.error(`[relay] ${e.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => {
  remote.sweep();
  console.log(`[relay] http://${HOST}:${PORT}  dist=${DIST}  roots=${ROOTS.join(',')}  auth=${AUTH ? 'on' : 'off'}`);
  // "[relay] url …" linije čita bridge (prozor s adresama za otvaranje u browseru)
  const lan = HOST === '0.0.0.0' || HOST === '::'
    ? Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)
    : HOST === '127.0.0.1' || HOST === 'localhost' ? [] : [HOST];
  for (const h of ['localhost', ...lan]) console.log(`[relay] url http://${h}:${PORT}`);
});
