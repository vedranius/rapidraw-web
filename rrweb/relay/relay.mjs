// rrweb relay: servira web UI, /files (thumbnaili, slike), i spaja browser klijente s bridgeom.
//
// Env:
//   RR_PORT   (8780)        port
//   RR_HOST   (0.0.0.0)     bind adresa
//   RR_ROOTS  (obavezno)    path.delimiter-odvojeni (':' Linux, ';' Windows) direktoriji koje /files smije servirati
//   RR_AUTH   (opcionalno)  "user:pass" → HTTP Basic za UI, /files, /fm i /ipc
//   RR_PHOTOS (opcionalno)  dodatni folder za Files tab (uz foldere otvorene u RapidRAW-u)
//   RR_ORIGINS (opcionalno) zarezom odvojeni dodatni dopušteni Origin-i (npr. https://photos.example.com iza proxyja)
//   RR_DIST   (../dist-web)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createFiles } from './files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.RR_PORT ?? 8780);
const BRIDGE_PORT = 8780;
const HOST = process.env.RR_HOST ?? '0.0.0.0';
const DIST = path.resolve(process.env.RR_DIST ?? path.join(here, '../dist-web'));
const AUTH = process.env.RR_AUTH ? 'Basic ' + Buffer.from(process.env.RR_AUTH).toString('base64') : null;
const ROOTS = (process.env.RR_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((r) => fs.realpathSync(r));
if (!ROOTS.length) { console.error('RR_ROOTS nije postavljen'); process.exit(1); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
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
const files = createFiles({
  settings: () => bridgeCall('load_settings', {}),
  bridge: bridgeCall,
  extraRoots: process.env.RR_PHOTOS ? [process.env.RR_PHOTOS] : [],
});
const LOCAL = { __rr_home: () => os.homedir(), ...files.commands };

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

const upgrade = (bridgeOnly) => (req, sock, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/bridge' && isLoopback(req.socket.remoteAddress)) wssBridge.handleUpgrade(req, sock, head, (ws) => wssBridge.emit('connection', ws));
  else if (p === '/ipc' && !bridgeOnly && authed(req) && sameOrigin(req)) wssClient.handleUpgrade(req, sock, head, (ws) => wssClient.emit('connection', ws));
  else sock.destroy();
};
server.on('upgrade', upgrade(false));
// Bridge se uvijek spaja na 127.0.0.1:8780 (VITE_RR_RELAY u bridge buildu), pa uz drugi RR_PORT slušaj i tamo
if (PORT !== BRIDGE_PORT) {
  http.createServer((_req, res) => res.writeHead(404).end()).on('upgrade', upgrade(true))
    .on('error', (e) => console.error(`[relay] bridge port ${BRIDGE_PORT}: ${e.message}`))
    .listen(BRIDGE_PORT, '127.0.0.1');
}

wssBridge.on('connection', (ws) => {
  if (bridge) bridge.close();
  bridge = ws;
  console.log('[relay] bridge connected');
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const r = data.readUInt32LE(0);
      const f = inflight.get(r); inflight.delete(r);
      if (!f) return;
      data.writeUInt32LE(f.id, 0);           // prepiši relayId → id klijenta
      f.client.send(data, { binary: true });
      log(f, data.length - 4);
      return;
    }
    const msg = JSON.parse(data);
    if (msg.event !== undefined) { const s = JSON.stringify(msg); clients.forEach((c) => c.send(s)); return; }
    const f = inflight.get(msg.id); inflight.delete(msg.id);
    if (!f) return;
    msg.id = f.id;
    f.client.send(JSON.stringify(msg));
    log(f);
  });
  ws.on('close', () => {
    if (bridge === ws) bridge = null;
    console.log('[relay] bridge disconnected');
    for (const [r, f] of inflight) { f.client.send(JSON.stringify({ id: f.id, error: 'bridge disconnected' })); inflight.delete(r); }
  });
});

wssClient.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[relay] client +1 (${clients.size})`);
  ws.on('message', async (data) => {
    const { id, cmd, args } = JSON.parse(data);
    if (LOCAL[cmd]) {
      try { ws.send(JSON.stringify({ id, result: (await LOCAL[cmd](args ?? {})) ?? null })); }
      catch (e) { ws.send(JSON.stringify({ id, error: e.message ?? String(e) })); }
      return;
    }
    if (!bridge) { ws.send(JSON.stringify({ id, error: 'RapidRAW bridge nije spojen' })); return; }
    rid = (rid + 1) >>> 0 || 1;
    inflight.set(rid, { client: ws, id, cmd, t0: process.hrtime.bigint() });
    bridge.send(JSON.stringify({ id: rid, cmd, args }));
  });
  ws.on('close', () => {
    clients.delete(ws);
    for (const [r, f] of inflight) if (f.client === ws) inflight.delete(r);
  });
});

const VERBOSE = !!process.env.RR_VERBOSE;
function log(f, bytes) {
  if (!VERBOSE && bytes === undefined) return;
  const ms = Number(process.hrtime.bigint() - f.t0) / 1e6;
  console.log(`[ipc] ${f.cmd} ${ms.toFixed(1)}ms${bytes !== undefined ? ` ${(bytes / 1024).toFixed(0)}KB` : ''}`);
}

// Relay koji je pokrenuo bridge (Windows installer) gasi se s njim. RapidRAW izlazi mimo Tauri Exit eventa,
// pa shell plugin ne stigne ubiti child proces; ovo pokriva i rušenje bridgea.
if (process.env.RR_EXIT_WITH_PARENT) {
  setInterval(() => { try { process.kill(process.ppid, 0); } catch { console.log('[relay] bridge exited, stopping'); process.exit(0); } }, 2000).unref();
}

server.on('error', (e) => { console.error(`[relay] ${e.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => {
  console.log(`[relay] http://${HOST}:${PORT}  dist=${DIST}  roots=${ROOTS.join(',')}  auth=${AUTH ? 'on' : 'off'}`);
  // "[relay] url …" linije čita bridge (prozor s adresama za otvaranje u browseru)
  const lan = HOST === '0.0.0.0' || HOST === '::'
    ? Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)
    : HOST === '127.0.0.1' || HOST === 'localhost' ? [] : [HOST];
  for (const h of ['localhost', ...lan]) console.log(`[relay] url http://${h}:${PORT}`);
});
