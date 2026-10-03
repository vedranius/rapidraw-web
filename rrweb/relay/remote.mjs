// "From this computer": folder na klijentskom računalu (browser, File System Access API) kao izvor i pohrana
// fotografija za RapidRAW na serveru. Browser je "agent" (WebSocket /rfs) koji čita i piše u taj folder.
//  - transfer: browser uploada cijeli folder u mirror na serveru (radi na svim OS-ovima). RapidRAW radi na mirroru,
//              a novi i izmijenjeni fajlovi (editi .rrdata, exporti) automatski se vraćaju u folder na klijentu.
//  - ondemand: Linux + FUSE (rrweb/fuse): folder klijenta je disk na serveru, bajtovi se dohvaćaju tek kad ih
//              RapidRAW čita (chunk cache + read-ahead), a sve što RapidRAW zapiše ide ravno na klijenta.
//  - keep:     kopija (dohvaćeni originali + editi) ostaje u odabranom folderu na serveru; inače privremeni
//              cache u RR_WORK koji se briše na Stop.
// Okvir na /rfs u oba smjera: [u32 LE q][u32 LE duljina JSON zaglavlja][zaglavlje][podaci].
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(process.env.RR_WORK ?? path.join(os.tmpdir(), 'rrweb-remote'));
const CHUNK = 1 << 20;          // jedinica cachea i dohvaćanja
const MAX_RUN = 8;              // najviše chunkova u jednom zahtjevu klijentu
const PUSH = 4 << 20;           // veličina komada kod slanja fajla na klijenta
const LIST_TTL = 3000;
const ERRNO = { ENOENT: 2, EIO: 5, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTEMPTY: 39, EACCES: 13 };

const FUSE_BIN = process.env.RR_FUSE_BIN
  ?? path.join(here, '..', 'fuse', { x64: 'x86_64', arm64: 'aarch64' }[process.arch] ?? process.arch, 'rrweb-fuse');

export function capabilities() {
  if (process.platform !== 'linux') return { ondemand: false, reason: 'On-demand mode needs a Linux server (FUSE). Transfer mode works.' };
  if (!fs.existsSync('/dev/fuse')) return { ondemand: false, reason: '/dev/fuse is missing on the server (install fuse3).' };
  if (!fs.existsSync(FUSE_BIN)) return { ondemand: false, reason: `rrweb-fuse not found (${FUSE_BIN}).` };
  if (!['/usr/bin/fusermount3', '/bin/fusermount3', '/usr/local/bin/fusermount3'].some((p) => fs.existsSync(p))) {
    return { ondemand: false, reason: 'fusermount3 is missing on the server (install the fuse3 package).' };
  }
  return { ondemand: true };
}

const fail = (code, msg) => Object.assign(new Error(msg ?? code), { code });
function checkRel(rel) {
  if (typeof rel !== 'string') throw fail('EINVAL', 'bad path');
  if (rel === '') return rel;
  if (rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((s) => !s || s === '.' || s === '..')) throw fail('EINVAL', `bad path: ${rel}`);
  return rel;
}
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const exists = (p) => fsp.lstat(p).then(() => true, () => false);

async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try { await fsp.rename(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

function frame(q, head, data) {
  const h = Buffer.from(JSON.stringify(head));
  const out = Buffer.allocUnsafe(8 + h.length + (data?.length ?? 0));
  out.writeUInt32LE(q, 0);
  out.writeUInt32LE(h.length, 4);
  h.copy(out, 8);
  if (data?.length) (Buffer.isBuffer(data) ? data : Buffer.from(data)).copy(out, 8 + h.length);
  return out;
}

// Djelomično dohvaćen fajl s klijenta: rijetki (sparse) fajl u stageu + bitmapa chunkova
class Cached {
  constructor(share, rel, size, mtime) {
    Object.assign(this, { share, rel, size, mtime });
    this.n = Math.max(1, Math.ceil(size / CHUNK));
    this.have = new Uint8Array(this.n);
    this.inflight = new Map();
    this.lastEnd = -1;
    this.seq = 0;        // koliko je zaredom (slijedno) pročitano
    this.file = path.join(share.stage, rel);
    this.fd = null;      // stage fajl (čitanje + pisanje dok se puni)
    this.rfd = null;     // promise: gotov fajl u mirroru (otvara se jednom)
    this.done = false;
    this.completing = null;
  }

  // jedan stage fd i kad više dohvata krene istodobno
  open() {
    if (this.done) return Promise.reject(fail('EIO', 'internal: stage reopened after completion'));
    this.opening ??= (async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const fd = await fsp.open(this.file, 'w+');
      await fd.truncate(this.size);
      this.fd = fd;
      return fd;
    })();
    return this.opening;
  }

  async fetchRun(start, count) {
    const off = start * CHUNK;
    const len = Math.min(count * CHUNK, this.size - off);
    const { data } = await this.share.request({ op: 'read', path: this.rel, off, len });
    const fd = await this.open();
    await fd.write(data, 0, data.length, off);
    this.share.stats.fetched += data.length;
    for (let i = start; i < start + count; i++) this.have[i] = 1;
  }

  async ensure(off, len) {
    if (this.done || this.size === 0) return;
    const first = Math.floor(off / CHUNK);
    const last = Math.min(this.n - 1, Math.floor((off + Math.max(len, 1) - 1) / CHUNK));
    // Read-ahead raste tek uz dulje slijedno čitanje (dekodiranje cijelog RAW-a); thumbnail treba samo
    // početak fajla i ugrađeni JPEG, pa tada ne dohvaćamo unaprijed ništa.
    this.seq = off === this.lastEnd ? this.seq + len : len;
    this.lastEnd = off + len;
    const ahead = this.seq < (2 << 20) ? 0 : this.seq < (8 << 20) ? 2 : 8;
    const end = Math.min(this.n - 1, last + ahead);
    const waits = [];
    for (let i = first; i <= end;) {
      if (this.have[i]) { i++; continue; }
      if (this.inflight.has(i)) { if (i <= last) waits.push(this.inflight.get(i)); i++; continue; }
      let count = 1;
      while (i + count <= end && count < MAX_RUN && !this.have[i + count] && !this.inflight.has(i + count)) count++;
      const start = i;
      const p = this.fetchRun(start, count).finally(() => { for (let k = start; k < start + count; k++) this.inflight.delete(k); });
      for (let k = start; k < start + count; k++) this.inflight.set(k, p);
      if (start <= last) waits.push(p); else p.catch(() => {}); // read-ahead u pozadini
      i += count;
    }
    await Promise.all(waits);
    if (!this.done && this.have.every(Boolean)) await this.complete();
  }

  // Cijeli fajl je dohvaćen: premjesti ga u mirror (keep: folder na serveru). Otvoreni stage fd ostaje
  // valjan i nakon premještanja, pa čitanja u tijeku ne smetaju; zatvara se tek malo kasnije.
  complete() {
    this.completing ??= (async () => {
      const dest = path.join(this.share.mirror, this.rel);
      await moveFile(this.file, dest);
      await fsp.utimes(dest, new Date(), new Date(this.mtime)).catch(() => {});
      this.file = dest;
      this.done = true;
      const old = this.fd;
      this.fd = null;
      setTimeout(() => old?.close().catch(() => {}), 5000);
      this.share.stats.complete++;
    })();
    return this.completing;
  }

  async read(off, len) {
    len = Math.max(0, Math.min(len, this.size - off));
    if (len === 0) return Buffer.alloc(0);
    await this.ensure(off, len);
    const fd = this.done ? await (this.rfd ??= fsp.open(this.file, 'r')) : this.fd ?? await this.open();
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fd.read(buf, 0, len, off);
    return buf.subarray(0, bytesRead);
  }

  async dispose() {
    const handles = [this.opening, this.rfd];
    this.fd = this.rfd = this.opening = null;
    for (const h of handles) await (await h?.catch(() => null))?.close().catch(() => {});
  }
}

class Share {
  constructor(opts, registry) {
    Object.assign(this, opts);
    this.registry = registry;
    this.agent = null;
    this.q = 0;
    this.pending = new Map();
    this.lists = new Map();        // rel dir → { at, entries: Map }
    this.files = new Map();        // rel → Cached (ondemand)
    this.local = new Set();        // rel fajlova napisanih na serveru (ondemand overlay)
    this.created = new Set();      // rel fajlova koje je RapidRAW stvorio u ovoj sesiji (smiju se stvarno obrisati)
    this.dirty = new Set();
    this.known = new Map();        // transfer: rel → "size:mtime" već usklađeno s klijentom
    this.timers = new Map();
    this.pushing = new Map();      // rel → red slanja na klijenta (jedno po jedno, zadnji sadržaj pobjeđuje)
    this.started = Date.now();
    this.stats = { fetched: 0, complete: 0, uploaded: 0, pushed: 0 };
    this.stage = path.join(WORK, 'stage', this.id);
  }

  get view() { return this.mode === 'ondemand' ? this.mount : this.mirror; }

  info() {
    return { id: this.id, name: this.name, mode: this.mode, keep: this.keep, view: this.view, mirror: this.mirror,
      online: !!this.agent, stats: this.stats };
  }

  // --- agent (browser) ---
  attach(ws) {
    this.agent?.close();
    this.agent = ws;
    ws.on('message', (data, isBinary) => {
      if (!isBinary || data.length < 8) return;
      const q = data.readUInt32LE(0);
      const hlen = data.readUInt32LE(4);
      const head = JSON.parse(data.subarray(8, 8 + hlen));
      const p = this.pending.get(q);
      if (!p) return;
      this.pending.delete(q);
      if (head.err) p.reject(fail(head.err in ERRNO ? head.err : 'EIO', head.err));
      else p.resolve({ head, data: data.subarray(8 + hlen) });
    });
    ws.on('close', () => {
      if (this.agent !== ws) return;
      this.agent = null;
      for (const p of this.pending.values()) p.reject(fail('EIO', 'client folder disconnected'));
      this.pending.clear();
    });
    console.log(`[remote] ${this.name}: client connected`);
  }

  request(head, data) {
    if (!this.agent) return Promise.reject(fail('EIO', 'client folder is not connected'));
    this.q = (this.q + 1) >>> 0 || 1;
    const q = this.q;
    return new Promise((resolve, reject) => {
      this.pending.set(q, { resolve, reject });
      this.agent.send(frame(q, head, data));
    });
  }

  async list(rel) {
    const c = this.lists.get(rel);
    if (c && Date.now() - c.at < LIST_TTL) return c.entries;
    const { head } = await this.request({ op: 'list', path: rel });
    const entries = new Map(head.entries.map((e) => [e.name, e]));
    this.lists.set(rel, { at: Date.now(), entries });
    return entries;
  }

  invalidate(rel) { this.lists.delete(rel); }

  // Fajl napisan/izmijenjen na serveru → u folder na klijentu (u komadima)
  async push(rel, file) {
    const st = await fsp.stat(file);
    const fd = await fsp.open(file, 'r');
    try {
      let off = 0;
      do {
        const buf = Buffer.allocUnsafe(Math.min(PUSH, st.size - off));
        const { bytesRead } = await fd.read(buf, 0, buf.length, off);
        await this.request({ op: 'write', path: rel, off, trunc: off === 0, done: off + bytesRead >= st.size, mtime: st.mtimeMs }, buf.subarray(0, bytesRead));
        off += bytesRead;
      } while (off < st.size);
    } finally { await fd.close(); }
    this.known.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`);
    this.stats.pushed++;
    this.invalidate(parentOf(rel));
  }

  // Slanja istog fajla idu jedno za drugim (FUSE release stiže asinkrono, nakon close), a brisanje i
  // preimenovanje čekaju da slanje završi, inače bi obrisani ili stari sadržaj ipak stigao na klijenta.
  queuePush(rel, file = this.localPath(rel)) {
    const p = (this.pushing.get(rel) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (await exists(file)) await this.push(rel, file);
    });
    this.pushing.set(rel, p);
    p.finally(() => { if (this.pushing.get(rel) === p) this.pushing.delete(rel); }).catch(() => {});
    return p;
  }

  async settled(rel) { await this.pushing.get(rel)?.catch(() => {}); }

  async remoteRemove(rel) {
    await this.request({ op: 'remove', path: rel, recursive: false }).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  // Original s klijenta se nikad ne briše trajno: ide u skriveni .rrweb-trash/ u istom folderu (RapidRAW na FUSE disku
  // ponekad ne može u svoj koš i tada briše trajno)
  async remoteTrash(rel) {
    await this.request({ op: 'rename', from: rel, to: `.rrweb-trash/${Date.now()}-${rel.replaceAll('/', '__')}` })
      .catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  // --- ondemand: operacije iz rrweb-fuse ---
  localPath(rel) { return path.join(this.mirror, rel); }

  async attr(rel) {
    if (rel === '') return { kind: 'dir', size: 0, mtime: Date.now() };
    if (this.local.has(rel)) {
      const st = await fsp.stat(this.localPath(rel));
      return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: Math.round(st.mtimeMs) };
    }
    const e = (await this.list(parentOf(rel))).get(nameOf(rel));
    if (!e) throw fail('ENOENT');
    return { kind: e.kind, size: e.size ?? 0, mtime: e.mtime ?? this.started }; // folderi s klijenta nemaju datum
  }

  async cached(rel) {
    const a = await this.attr(rel);
    if (a.kind === 'dir') throw fail('EISDIR');
    let c = this.files.get(rel);
    if (c && (c.size !== a.size || c.mtime !== a.mtime)) { await c.dispose(); c = null; } // promijenjen na klijentu
    if (!c) {
      c = new Cached(this, rel, a.size, a.mtime);
      const kept = this.localPath(rel); // keep: već cijeli na serveru od prije?
      const st = await fsp.stat(kept).catch(() => null);
      if (st?.isFile() && st.size === a.size) { c.done = true; c.file = kept; }
      this.files.set(rel, c);
    }
    return c;
  }

  // Lokalna (overlay) kopija fajla za pisanje; postojeći sadržaj prvo cijeli s klijenta
  async materialize(rel, keepContent) {
    if (this.local.has(rel)) return this.localPath(rel);
    const dest = this.localPath(rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (keepContent) {
      const c = await this.cached(rel);
      await c.ensure(0, c.size);
      if (c.file !== dest) await fsp.copyFile(c.file, dest);
    } else await fsp.writeFile(dest, '');
    this.local.add(rel);
    return dest;
  }

  async fuseOp(h, data) {
    const rel = h.path === undefined ? undefined : checkRel(h.path);
    switch (h.op) {
      case 'getattr': return this.attr(rel);
      case 'readdir': {
        const entries = new Map(await this.list(rel));
        for (const l of this.local) if (parentOf(l) === rel && !entries.has(nameOf(l))) entries.set(nameOf(l), { name: nameOf(l), kind: 'file' });
        return { entries: [...entries.values()].map((e) => ({ name: e.name, kind: e.kind })) };
      }
      case 'read': {
        if (this.local.has(rel)) {
          const fd = await fsp.open(this.localPath(rel), 'r');
          try {
            const buf = Buffer.allocUnsafe(h.len);
            const { bytesRead } = await fd.read(buf, 0, h.len, h.off);
            return [{}, buf.subarray(0, bytesRead)];
          } finally { await fd.close(); }
        }
        return [{}, await (await this.cached(rel)).read(h.off, h.len)];
      }
      case 'create': {
        await this.materialize(rel, false);
        this.created.add(rel);
        this.dirty.add(rel);
        this.invalidate(parentOf(rel));
        return { kind: 'file', size: 0, mtime: Date.now() };
      }
      case 'write': {
        const file = await this.materialize(rel, true);
        const fd = await fsp.open(file, 'r+');
        try { await fd.write(data, 0, data.length, h.off); } finally { await fd.close(); }
        this.dirty.add(rel);
        return {};
      }
      case 'truncate': {
        const file = await this.materialize(rel, h.size > 0);
        await fsp.truncate(file, h.size);
        this.dirty.add(rel);
        return {};
      }
      case 'release': {
        if (this.dirty.delete(rel)) await this.queuePush(rel);
        return {};
      }
      case 'mkdir': {
        await this.request({ op: 'mkdir', path: rel });
        await fsp.mkdir(this.localPath(rel), { recursive: true });
        this.invalidate(parentOf(rel));
        return { kind: 'dir', size: 0, mtime: Date.now() };
      }
      case 'unlink':
      case 'rmdir': {
        this.dirty.delete(rel);
        await this.settled(rel);
        if (h.op === 'unlink' && !this.created.has(rel)) await this.remoteTrash(rel);
        else await this.remoteRemove(rel);
        this.created.delete(rel);
        this.local.delete(rel);
        await this.files.get(rel)?.dispose();
        this.files.delete(rel);
        await fsp.rm(this.localPath(rel), { recursive: h.op === 'rmdir', force: true });
        this.invalidate(parentOf(rel));
        return {};
      }
      case 'rename': {
        const from = checkRel(h.from);
        const to = checkRel(h.to);
        await this.settled(from);
        let remoteMissing = false;
        await this.request({ op: 'rename', from, to }).catch((e) => { if (e.code === 'ENOENT') remoteMissing = true; else throw e; });
        await this.files.get(from)?.dispose();
        this.files.delete(from);
        if (this.local.delete(from)) this.local.add(to);
        if (this.dirty.delete(from)) this.dirty.add(to);
        if (this.created.delete(from)) this.created.add(to);
        if (await exists(this.localPath(from))) await moveFile(this.localPath(from), this.localPath(to));
        if (remoteMissing && this.local.has(to) && !this.dirty.has(to)) await this.queuePush(to); // još nije bio poslan
        this.invalidate(parentOf(from));
        this.invalidate(parentOf(to));
        return {};
      }
      default: throw fail('EINVAL', `unknown op ${h.op}`);
    }
  }

  async mountFuse() {
    await fsp.mkdir(this.mount, { recursive: true });
    const child = spawn(FUSE_BIN, [this.mount], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.fuse = child;
    let buf = Buffer.alloc(0);
    const send = (head, data = Buffer.alloc(0)) => {
      const h = Buffer.from(JSON.stringify(head));
      const out = Buffer.allocUnsafe(8 + h.length + data.length);
      out.writeUInt32LE(h.length, 0);
      out.writeUInt32LE(data.length, 4);
      h.copy(out, 8);
      data.copy(out, 8 + h.length);
      child.stdin.write(out);
    };
    const mounted = new Promise((resolve, reject) => {
      child.once('exit', (code) => reject(new Error(`rrweb-fuse exited (${code})`)));
      child.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const hlen = buf.readUInt32LE(0);
          const dlen = buf.readUInt32LE(4);
          if (buf.length < 8 + hlen + dlen) break;
          const head = JSON.parse(buf.subarray(8, 8 + hlen));
          const data = buf.subarray(8 + hlen, 8 + hlen + dlen);
          buf = buf.subarray(8 + hlen + dlen);
          if (head.op === 'mounted') { resolve(); continue; }
          this.fuseOp(head, data).then(
            (r) => (Array.isArray(r) ? send({ id: head.id, ...r[0] }, r[1]) : send({ id: head.id, ...r })),
            (e) => {
              if (e.code !== 'ENOENT') console.warn(`[remote] ${this.name}: ${head.op} ${head.path ?? ''}: ${e.message}`);
              send({ id: head.id, err: ERRNO[e.code] ?? ERRNO.EIO });
            });
        }
      });
    });
    child.on('exit', () => { if (this.fuse === child) this.fuse = null; });
    await Promise.race([mounted, new Promise((_, r) => setTimeout(() => r(new Error('mount timeout')), 10000))]);
    console.log(`[remote] ${this.name}: mounted at ${this.mount}`);
  }

  // --- transfer: mirror na serveru, izmjene natrag na klijenta ---
  async receive(rel, req, mtime) {
    checkRel(rel);
    const tmp = path.join(this.stage, 'upload', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      const dest = path.join(this.mirror, rel);
      if (mtime) await fsp.utimes(tmp, new Date(), new Date(mtime));
      const st = await fsp.stat(tmp);
      this.known.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`); // prije premještanja, da watcher ne vrati natrag
      await moveFile(tmp, dest);
      this.stats.uploaded++;
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  async have() {
    const out = {};
    const walk = async (dir, rel) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (e.isFile()) {
          const st = await fsp.stat(path.join(dir, e.name));
          out[r] = { size: st.size, mtime: Math.round(st.mtimeMs) };
          this.known.set(r, `${st.size}:${Math.round(st.mtimeMs)}`);
        }
      }
    };
    await walk(this.mirror, '');
    return out;
  }

  watch() {
    this.watcher = fs.watch(this.mirror, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const rel = name.split(path.sep).join('/');
      clearTimeout(this.timers.get(rel));
      this.timers.set(rel, setTimeout(() => { this.timers.delete(rel); this.sync(rel).catch((e) => console.warn(`[remote] ${this.name}: ${rel}: ${e.message}`)); }, 1500));
    });
  }

  async sync(rel) {
    if (!this.agent || rel.split('/').some((s) => s.startsWith('.rrweb'))) return;
    const st = await fsp.stat(path.join(this.mirror, rel)).catch(() => null);
    if (!st) return; // brisanje se namjerno ne prenosi na klijenta
    if (st.isDirectory()) { await this.request({ op: 'mkdir', path: rel }); return; }
    if (this.known.get(rel) === `${st.size}:${Math.round(st.mtimeMs)}`) return;
    await this.queuePush(rel, path.join(this.mirror, rel));
    console.log(`[remote] ${this.name}: ${rel} → client`);
  }

  async start() {
    await fsp.mkdir(this.mirror, { recursive: true });
    if (this.mode === 'ondemand') await this.mountFuse();
    else { await this.have(); this.watch(); }
  }

  async stop() {
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const c of this.files.values()) await c.dispose();
    if (this.fuse) {
      const child = this.fuse;
      await new Promise((r) => { child.once('exit', r); child.stdin.end(); setTimeout(r, 5000); });
    }
    this.agent?.close();
    await fsp.rm(this.stage, { recursive: true, force: true });
    if (!this.keep) await fsp.rm(path.join(WORK, 'mirror', this.id), { recursive: true, force: true });
    if (this.mode === 'ondemand') await fsp.rm(path.dirname(this.mount), { recursive: true, force: true }).catch(() => {});
  }
}

// onChange(): popis dijeljenih foldera se promijenio (relay osvježi rootove Files taba)
export function createRemote({ validName, insideRoots, onChange = () => {} }) {
  const shares = new Map();
  const id = () => Math.random().toString(36).slice(2, 10);

  async function start({ id: wanted, name, mode, keep, keepDir }) {
    validName(name);
    if (mode !== 'transfer' && mode !== 'ondemand') throw new Error('mode must be transfer or ondemand');
    if (mode === 'ondemand' && !capabilities().ondemand) throw new Error(capabilities().reason);
    const existing = wanted && shares.get(wanted);
    if (existing) return existing.info();
    const sid = wanted && /^[a-z0-9]{6,16}$/.test(wanted) ? wanted : id();
    let mirror = path.join(WORK, 'mirror', sid, name);
    if (keep) {
      if (!keepDir) throw new Error('choose a server folder for the kept copy');
      const dir = await insideRoots(keepDir); // samo unutar foldera s fotografijama
      mirror = path.join(dir, name);
    }
    const share = new Share({ id: sid, name, mode, keep: !!keep, mirror, mount: path.join(WORK, 'mnt', sid, name) }, shares);
    await share.start();
    shares.set(sid, share);
    onChange();
    console.log(`[remote] ${name}: ${mode}${keep ? ` (copy kept in ${mirror})` : ''} → ${share.view}`);
    return share.info();
  }

  async function stop({ id: sid }) {
    const s = shares.get(sid);
    if (!s) return;
    shares.delete(sid);
    onChange();
    await s.stop();
  }

  return {
    commands: {
      __rr_share_caps: () => ({ ...capabilities(), work: WORK }),
      __rr_share_start: start,
      __rr_share_stop: stop,
      __rr_share_list: () => [...shares.values()].map((s) => s.info()),
      __rr_share_have: async ({ id: sid }) => shares.get(sid)?.have() ?? {},
    },
    // /rfs?id=… WebSocket browsera koji dijeli folder
    attach(ws, sid) {
      const s = shares.get(sid);
      if (!s) { ws.close(4004, 'unknown share'); return; }
      s.attach(ws);
    },
    // PUT /rfs/put?id=…&path=…&mtime=… (transfer upload)
    async http(req, res, u) {
      try {
        const s = shares.get(u.searchParams.get('id'));
        if (!s || req.method !== 'PUT' || u.pathname !== '/rfs/put') { res.writeHead(404).end(); return; }
        await s.receive(u.searchParams.get('path') ?? '', req, Number(u.searchParams.get('mtime')) || 0);
        res.writeHead(204).end();
      } catch (e) {
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' }).end(e.message);
      }
    },
    roots: () => [...shares.values()].map((s) => s.view),
    labels: () => Object.fromEntries([...shares.values()].map((s) => [s.view, `${s.name} (this computer)`])),
    async shutdown() { for (const s of shares.values()) await s.stop().catch(() => {}); },
  };
}
