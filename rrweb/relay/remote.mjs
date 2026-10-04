// "From this computer": folder na klijentskom računalu (browser, File System Access API) kao izvor i pohrana
// fotografija za RapidRAW na serveru. Browser je "agent" (WebSocket /rfs) koji čita i piše u taj folder.
//  - transfer: browser uploada cijeli folder u mirror na serveru (radi na svim OS-ovima). RapidRAW radi na mirroru,
//              a novi i izmijenjeni fajlovi (editi .rrdata, exporti) automatski se vraćaju u folder na klijentu.
//  - ondemand: Linux (FUSE) ili Windows (WinFsp), rrweb/fuse: folder klijenta je disk na serveru, bajtovi se
//              dohvaćaju tek kad ih RapidRAW čita (chunk cache + read-ahead), a sve što RapidRAW zapiše ide ravno na klijenta.
//  - keep:     kopija (dohvaćeni originali + editi) ostaje u odabranom folderu na serveru; inače privremeni
//              cache u RR_WORK koji se briše na Stop.
// Okvir na /rfs u oba smjera: [u32 LE q][u32 LE duljina JSON zaglavlja][zaglavlje][podaci].
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(process.env.RR_WORK ?? path.join(os.tmpdir(), 'rrweb-remote'));
const CHUNK = 1 << 20;          // jedinica cachea i dohvaćanja = najveći komad u jednoj WebSocket poruci
const MAX_RUN = 1;              // chunkova po zahtjevu: poruke ≤ 1 MB (proxyji/tuneli poput Cloudflarea)
const PUSH = 1 << 20;           // veličina komada kod slanja fajla na klijenta
const READS = 6;                // najviše dohvata s klijenta odjednom (po dijeljenom folderu; fokus ima svojih READS)
// Prioriteti dohvata s klijenta: fotka otvorena u editoru, thumbnaili iz RAF-ova (raf.mjs), ostala čitanja
// RapidRAW-a (thumbnaili editiranih fotki, EXIF…), punjenje u pozadini. Niži red ne kreće dok viši ima posla.
export const PRIO = { FOCUS: 0, SEED: 1, READ: 2, FILL: 3 };
const EDIT_QUIET = 15000;       // ms nakon zadnje radnje u editoru do nastavka pozadinskog posla
const EDIT_RECENT = 120000;     // toliko nakon zadnje radnje fotka se smatra otvorenom (pozadina radi sporije)
const LOAD_MAX = 60000;         // otvaranje fotke koje se nikad nije javilo ne smije zaustaviti pozadinu zauvijek

// Editor (relay.mjs javlja otvaranje fotke i pomake slidera): dok radi, sve pozadinsko čeka, da otvorena
// fotka ima cijelu vezu, a slideri CPU i GPU
export const editor = {
  last: 0,
  loads: new Map(),             // token → početak otvaranja
  touch() { this.last = Date.now(); },
  loading(token) { this.loads.set(token, Date.now()); this.touch(); },
  loaded(token) { if (this.loads.delete(token)) this.touch(); },
  busy() {
    for (const [t, at] of this.loads) if (Date.now() - at > LOAD_MAX) this.loads.delete(t);
    return this.loads.size > 0 || Date.now() - this.last < EDIT_QUIET;
  },
  recent() { return Date.now() - this.last < EDIT_RECENT; },
  // ms bez ijedne radnje u editoru (0 dok se fotka otvara)
  idleFor() {
    this.busy(); // čisti zaboravljena otvaranja
    return this.loads.size ? 0 : Date.now() - this.last;
  },
  // Smije li pozadinski posao krenuti: dok je fotka otvorena samo u pauzi editiranja (gapMs bez radnje, ništa se ne
  // otvara), inače kad editor miruje EDIT_QUIET
  open(gapMs) { return this.editing() ? this.idleFor() >= gapMs : !this.busy(); },
  async gap(gapMs, stop = () => false) { while (!this.open(gapMs()) && !stop()) await new Promise((r) => setTimeout(r, 250)); },
  // UI (rrweb/files/progress.ts) javlja prikaz: 'editor' ili 'library', i ponavlja ga svakih par sekundi.
  // Svaka kartica (klijent) posebno: fotka je otvorena ako je otvorena u bilo kojoj
  views: new Map(), // klijent → { mode, at }
  setView(mode, who = null) {
    const was = this.editing();
    this.views.set(who, { mode, at: Date.now() });
    if (was && !this.editing()) this.last = 0; // povratak u library: pozadina odmah
  },
  dropView(who) { this.views.delete(who); },
  fresh() { return [...this.views.values()].filter((v) => Date.now() - v.at < 30000); },
  viewKnown() { return this.fresh().length > 0; },
  editing() { return this.fresh().some((v) => v.mode === 'editor'); }, // fotka je otvorena u editoru
  // pozadinski posao (punjenje, priprema thumbnaila) čeka dok editor radi i dok je fotka otvorena
  async idle(stop = () => false) { while ((this.busy() || this.editing()) && !stop()) await new Promise((r) => setTimeout(r, 300)); },
};
const RECONNECT_WAIT = 120000;  // koliko zahtjev čeka da se browser ponovno spoji
const FILL_RESERVE = 5e9;       // punjenje u pozadini staje kad na serveru ostane manje od 5 GB
// Popis foldera s klijenta: readdir (RapidRAW lista folder) traži svježiji od LIST_TTL; stat jednog fajla uzima
// spremljeni popis (do LIST_STALE star) i osvježava ga u pozadini kad je stariji od LIST_REFRESH
const LIST_TTL = 3000;
const LIST_REFRESH = 15000;
const LIST_STALE = 10 * 60 * 1000;
const ERRNO = { ENOENT: 2, EIO: 5, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTEMPTY: 39, EACCES: 13 };

// server bundle: fuse/<arch>/; all-in-one paket: sidecar pored ugrađenog Node.js-a (/usr/bin, AppImage usr/bin, Windows install)
const WIN = process.platform === 'win32';
const VERBOSE = !!process.env.RR_VERBOSE; // i FUSE operacije (bez read/write)
const FUSE_NAME = WIN ? 'rrweb-fuse.exe' : 'rrweb-fuse';
const FUSE_BIN = process.env.RR_FUSE_BIN ?? [
  path.join(here, '..', 'fuse', { x64: 'x86_64', arm64: 'aarch64' }[process.arch] ?? process.arch, FUSE_NAME),
  path.join(path.dirname(process.execPath), FUSE_NAME),
].find((p) => fs.existsSync(p)) ?? path.join(path.dirname(process.execPath), FUSE_NAME);

let winCheck = { at: 0, ok: false };
export function capabilities() {
  if (WIN) {
    if (!fs.existsSync(FUSE_BIN)) return { ondemand: false, reason: `rrweb-fuse not found (${FUSE_BIN}).` };
    if (Date.now() - winCheck.at > 30000) { // rrweb-fuse --check: može li učitati WinFsp
      const r = spawnSync(FUSE_BIN, ['--check'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
      winCheck = { at: Date.now(), ok: r.status === 0 };
    }
    return winCheck.ok ? { ondemand: true }
      : { ondemand: false, reason: 'On-demand mode needs WinFsp on the server: install it from winfsp.dev, then try again. Transfer mode works.' };
  }
  if (process.platform !== 'linux') return { ondemand: false, reason: 'On-demand mode needs a Linux or Windows server for now. Transfer mode works.' };
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

// Mount čiji je rrweb-fuse nestao ("Transport endpoint is not connected") odvoji lijeno, da ga se može ponovno koristiti
function lazyUnmount(dir) {
  if (process.platform !== 'linux') return; // WinFsp mount nestaje s procesom
  spawnSync('fusermount3', ['-u', '-z', dir], { stdio: 'ignore' });
}

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

  // prio: PRIO.* (bez njega: fokus ako je ovo fotka otvorena u editoru, inače obično čitanje);
  // slotted = slot je već zauzet (vidi fill)
  async fetchRun(start, count, prio = this.share.isFocus(this.rel) ? PRIO.FOCUS : PRIO.READ, slotted = false) {
    const off = start * CHUNK;
    const len = Math.min(count * CHUNK, this.size - off);
    if (!slotted) await this.share.slot(prio);
    let data;
    try {
      // prolazna greška čitanja na klijentu (npr. fajl upravo zapisan): pokušaj opet, jer greška kroz mmap ruši RapidRAW
      for (let attempt = 0; ; attempt++) {
        try { ({ data } = await this.share.request({ op: 'read', path: this.rel, off, len })); break; } catch (e) {
          if (attempt >= 2 || e.code === 'ENOENT' || this.share.stopped) throw e;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    } finally { this.share.unslot(prio); }
    if (this.share.stopped) throw fail('EIO', 'stopped');
    const fd = await this.open();
    await fd.write(data, 0, data.length, off);
    this.share.stats.fetched += data.length;
    this.share.recordFetch(data.length);
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

  // Dohvaća sve chunkove koji fale: PRIO.FILL = punjenje u pozadini (čeka da editor miruje i da RapidRAW ništa
  // drugo ne čita), PRIO.FOCUS = fotka upravo otvorena u editoru (cijela, paralelno, ispred svega)
  async fill(prio = PRIO.FILL, parallel = 4) {
    const running = new Set();
    for (let i = 0; i < this.n && !this.done && !this.share.stopped; i++) {
      if (this.have[i] || this.inflight.has(i)) continue;
      if (prio === PRIO.FILL) await editor.idle(() => this.share.stopped);
      // slot prije nego što chunk postane "inflight": inače bi čitanje za RapidRAW čekalo chunk koji stoji u redu
      await this.share.slot(prio);
      if (this.have[i] || this.inflight.has(i) || this.done || this.share.stopped) { this.share.unslot(prio); continue; }
      const p = this.fetchRun(i, 1, prio, true).finally(() => { this.inflight.delete(i); running.delete(p); });
      this.inflight.set(i, p);
      running.add(p);
      p.catch(() => {});
      if (running.size >= parallel) await Promise.race(running).catch(() => {});
    }
    await Promise.allSettled([...running]);
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
      this.completedAt = Date.now();
      const old = this.fd;
      this.fd = null;
      setTimeout(() => old?.close().catch(() => {}), 5000);
      this.share.stats.complete++;
    })();
    return this.completing;
  }

  // koliko je fajla već na serveru (za napredak u UI-ju)
  fetchedBytes() {
    let n = 0;
    for (const h of this.have) n += h;
    return Math.min(this.size, n * CHUNK);
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
    this.listing = new Map();      // rel dir → dohvat popisa u tijeku (dijele ga svi koji čekaju)
    this.listGen = new Map();      // rel dir → broj izmjena sa servera (dohvat stariji od izmjene ne smije je poništiti)
    this.files = new Map();        // rel → Cached (ondemand)
    this.local = new Set();        // rel fajlova napisanih na serveru (ondemand overlay)
    this.created = new Set();      // rel fajlova koje je RapidRAW stvorio u ovoj sesiji (smiju se stvarno obrisati)
    this.dirty = new Set();
    this.known = new Map();        // transfer: rel → "size:mtime" već usklađeno s klijentom
    this.timers = new Map();
    this.pushing = new Map();      // rel → red slanja na klijenta (jedno po jedno, zadnji sadržaj pobjeđuje)
    this.started = Date.now();
    this.waiters = new Set();      // zahtjevi koji čekaju da se browser ponovno spoji
    this.active = [0, 0, 0, 0];    // dohvata s klijenta u tijeku, po prioritetu (PRIO)
    this.waiting = [[], [], [], []];
    this.focus = null;             // rel fotke otvorene u editoru
    this.samples = [];             // [vrijeme, bajtova] dohvata s klijenta, za brzinu u UI-ju
    this.offlineSince = Date.now(); // dok se browser ne spoji (attach)
    // fill: total = veličina cijelog foldera, filled = koliko je od toga već cijelo na serveru
    this.stats = { fetched: 0, complete: 0, uploaded: 0, pushed: 0, total: 0, filled: 0, filling: false, diskFull: false };
    this.stage = path.join(WORK, 'stage', this.id);
  }

  get view() { return this.mode === 'ondemand' ? this.mount : this.mirror; }

  info() {
    return { id: this.id, name: this.name, mode: this.mode, keep: this.keep, fill: !!this.fill, view: this.view, mirror: this.mirror,
      online: !!this.agent, stats: this.stats };
  }

  // --- agent (browser) ---
  attach(ws) {
    this.agent?.close();
    this.agent = ws;
    this.offlineSince = 0;
    for (const w of this.waiters) w();
    this.waiters.clear();
    // tuneli i proxyji zatvaraju WebSocket koji miruje; ping ga drži otvorenim
    const keepalive = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 20000);
    ws.on('error', (e) => console.warn(`[remote] ${this.name}: ${e.message}`));
    ws.on('message', (data, isBinary) => {
      if (!isBinary || data.length < 8) return;
      const q = data.readUInt32LE(0);
      const hlen = data.readUInt32LE(4);
      let head;
      try { head = JSON.parse(data.subarray(8, 8 + hlen)); } catch { return; }
      const p = this.pending.get(q);
      if (!p) return;
      this.pending.delete(q);
      if (head.err) p.reject(fail(head.err in ERRNO ? head.err : 'EIO', head.err));
      else p.resolve({ head, data: data.subarray(8 + hlen) });
    });
    ws.on('close', () => {
      clearInterval(keepalive);
      if (this.agent !== ws) return;
      this.agent = null;
      this.offlineSince = Date.now();
      for (const p of this.pending.values()) p.reject(fail('EOFFLINE', 'client folder disconnected'));
      this.pending.clear();
      console.log(`[remote] ${this.name}: client disconnected, waiting for it to reconnect`);
    });
    console.log(`[remote] ${this.name}: client connected`);
  }

  // Kad veza s browserom pukne (tunel, Wi-Fi, osvježavanje stranice), zahtjev pričeka da se ponovno spoji i
  // pokuša opet. Greška bi se kroz mmap pretvorila u SIGBUS i srušila RapidRAW, pa je javljamo tek nakon RECONNECT_WAIT.
  async request(head, data) {
    for (let attempt = 0; ; attempt++) {
      await this.online();
      try { return await this.send(head, data); } catch (e) {
        if (e.code !== 'EOFFLINE' || attempt >= 4) throw e.code === 'EOFFLINE' ? fail('EIO', e.message) : e;
      }
    }
  }

  // Čeka najviše do RECONNECT_WAIT nakon prekida; folder koji je odspojen dulje odmah javlja grešku (inače bi svaki
  // pregled foldera i svaki RapidRAW-ov stat na njemu visio po dvije minute)
  online() {
    if (this.agent) return Promise.resolve();
    if (this.stopped) return Promise.reject(fail('EIO', 'stopped'));
    const left = this.offlineSince + RECONNECT_WAIT - Date.now();
    if (left <= 0) return Promise.reject(fail('EIO', 'client folder is not connected'));
    return new Promise((resolve, reject) => {
      const w = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { this.waiters.delete(w); reject(fail('EIO', 'client folder is not connected')); }, left);
      w.fail = () => { clearTimeout(t); reject(fail('EIO', 'stopped')); };
      this.waiters.add(w);
    });
  }

  send(head, data) {
    if (!this.agent) return Promise.reject(fail('EOFFLINE', 'client folder disconnected'));
    this.q = (this.q + 1) >>> 0 || 1;
    const q = this.q;
    return new Promise((resolve, reject) => {
      this.pending.set(q, { resolve, reject });
      this.agent.send(frame(q, head, data), (e) => {
        if (e && this.pending.delete(q)) reject(fail('EOFFLINE', e.message));
      });
    });
  }

  // Fokus (fotka u editoru) uvijek smije do READS dohvata, bez obzira na ostale; ostali dijele READS, a red kreće
  // tek kad nijedan važniji ne radi niti čeka (thumbnaili ne smiju usporiti otvaranje fotke)
  canStart(p) {
    if (p === PRIO.FOCUS) return this.active[0] < READS;
    if (this.active[1] + this.active[2] + this.active[3] >= READS) return false;
    for (let q = 0; q < p; q++) if (this.active[q] || this.waiting[q].length) return false;
    return true;
  }

  slot(p) {
    if (this.canStart(p)) { this.active[p]++; return Promise.resolve(); }
    return new Promise((r) => this.waiting[p].push(r));
  }

  unslot(p) {
    this.active[p]--;
    for (let q = 0; q < this.waiting.length; q++) {
      while (this.waiting[q].length && this.canStart(q)) { this.active[q]++; this.waiting[q].shift()(); }
    }
  }

  recordFetch(n) {
    const now = Date.now();
    this.samples.push([now, n]);
    while (this.samples.length && now - this.samples[0][0] > 3000) this.samples.shift();
  }

  // bajtova/s u zadnje 3 s
  rate() {
    const now = Date.now();
    const recent = this.samples.filter(([t]) => now - t <= 3000);
    if (!recent.length) return 0;
    return recent.reduce((s, [, n]) => s + n, 0) / Math.max(1, (now - recent[0][0]) / 1000);
  }

  async requestAt(p, head, data) {
    await this.slot(p);
    try { return await this.request(head, data); } finally { this.unslot(p); }
  }

  // fotka i njeni sidecari (.rrdata, .rrexif, virtualne kopije)
  isFocus(rel) { return !!this.focus && (rel === this.focus || rel.startsWith(`${this.focus}.`)); }

  // Fotka otvorena u editoru: RapidRAW je ionako čita cijelu, pa je odmah dohvati paralelno, ispred svega
  setFocus(rel) {
    this.focus = rel;
    this.cached(rel).then((c) => (c.done ? null : c.fill(PRIO.FOCUS, READS)))
      .catch((e) => { if (e.code !== 'ENOENT' && e.code !== 'EISDIR') console.warn(`[remote] ${this.name}: focus ${rel}: ${e.message}`); });
  }

  // ondemand + fill: cijeli folder se polako puni na server dok RapidRAW ne čita ništa drugo. Za formate čiji
  // ugrađeni preview RapidRAW ne zna pročitati (Fuji RAF, Canon CR3) thumbnail ionako treba cijeli fajl.
  async fillAll() {
    this.stats.filling = true;
    const files = [];
    const walk = async (rel) => {
      for (const e of (await this.list(rel)).values()) {
        if (this.stopped || e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.kind === 'dir') await walk(r);
        else { files.push(r); this.stats.total += e.size ?? 0; }
      }
    };
    try {
      await walk('');
      console.log(`[remote] ${this.name}: filling ${files.length} files (${(this.stats.total / 1e9).toFixed(1)} GB) in the background`);
      for (const rel of files) {
        if (this.stopped) break;
        if (this.local.has(rel)) continue; // RapidRAW ga je već prepisao na serveru
        await editor.idle(() => this.stopped);
        try {
          const c = await this.cached(rel);
          if (c.done) { this.stats.filled += c.size; continue; }
          // ne puni disk servera do kraja (mirror može biti u RR_WORK, tj. na sistemskom disku)
          const st = await fsp.statfs(this.mirror);
          if (st.bavail * st.bsize - c.size < FILL_RESERVE) {
            console.warn(`[remote] ${this.name}: background fill stopped, less than ${FILL_RESERVE / 1e9} GB free on the server`);
            this.stats.diskFull = true;
            break;
          }
          await c.fill();
          if (c.done) this.stats.filled += c.size;
        } catch (e) { if (!this.stopped) console.warn(`[remote] ${this.name}: fill ${rel}: ${e.message}`); }
      }
    } finally { this.stats.filling = false; }
  }

  // Popis velikog foldera traje (1330 fajlova: ~1 s, dok browser šalje i druge podatke i 10 s), a RapidRAW neke
  // operacije na fajlovima radi na glavnoj niti (npr. spremanje postavki nakon svake promjene: stat i EXIF fotke),
  // pa za to vrijeme stoji sve, i obrada slidera. Zato stat ne čeka novi popis: uzima spremljeni i osvježava ga u pozadini.
  async list(rel, fresh = true) {
    const c = this.lists.get(rel);
    const age = c ? Date.now() - c.at : Infinity;
    if (age < LIST_TTL) return c.entries;
    if (!fresh && age < LIST_STALE) {
      if (age >= LIST_REFRESH) this.fetchList(rel).catch(() => {});
      return c.entries;
    }
    return this.fetchList(rel);
  }

  fetchList(rel) {
    let p = this.listing.get(rel);
    if (p) return p;
    const gen = this.listGen.get(rel) ?? 0;
    p = this.request({ op: 'list', path: rel }).then(({ head }) => {
      const entries = new Map(head.entries.map((e) => [e.name, e]));
      const old = this.lists.get(rel);
      // za vrijeme dohvata server je nešto promijenio u folderu: zadrži popis s tom izmjenom, osvježi ga idući put
      if ((this.listGen.get(rel) ?? 0) !== gen) {
        if (old) { old.at = Math.min(old.at, Date.now() - LIST_REFRESH); return old.entries; }
        this.lists.set(rel, { at: Date.now() - LIST_REFRESH, entries });
        return entries;
      }
      this.lists.set(rel, { at: Date.now(), entries });
      return entries;
    }).finally(() => { if (this.listing.get(rel) === p) this.listing.delete(rel); });
    this.listing.set(rel, p);
    return p;
  }

  invalidate(rel) { this.lists.delete(rel); }

  // Izmjena koju je napravio server (RapidRAW): odmah u spremljeni popis, bez novog dohvata s klijenta
  patchList(dir, name, entry) {
    this.listGen.set(dir, (this.listGen.get(dir) ?? 0) + 1);
    const c = this.lists.get(dir);
    if (!c) return;
    if (entry) c.entries.set(name, { ...entry, name });
    else c.entries.delete(name);
  }

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
    this.patchList(parentOf(rel), nameOf(rel), { kind: 'file', size: st.size, mtime: Math.round(st.mtimeMs) });
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
    const e = (await this.list(parentOf(rel), false)).get(nameOf(rel));
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
      case 'readdir': { // veličina i vrijeme za Windows (WinFsp ih čita iz popisa direktorija)
        const entries = new Map(await this.list(rel));
        for (const l of this.local) {
          if (parentOf(l) !== rel) continue;
          const st = await fsp.stat(this.localPath(l)).catch(() => null);
          if (st) entries.set(nameOf(l), { name: nameOf(l), kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: Math.round(st.mtimeMs) });
        }
        return { entries: [...entries.values()].map((e) => ({ name: e.name, kind: e.kind, size: e.size ?? 0, mtime: e.mtime ?? this.started })) };
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
        this.patchList(parentOf(rel), nameOf(rel), { kind: 'file', size: 0, mtime: Date.now() });
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
        this.patchList(parentOf(rel), nameOf(rel), { kind: 'dir' });
        this.invalidate(rel);
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
        this.patchList(parentOf(rel), nameOf(rel), null);
        if (h.op === 'rmdir') this.invalidate(rel);
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
        const moved = this.lists.get(parentOf(from))?.entries.get(nameOf(from));
        this.patchList(parentOf(from), nameOf(from), null);
        this.patchList(parentOf(to), nameOf(to), moved ?? null);
        if (!moved) this.invalidate(parentOf(to)); // nije bio u popisu: popis odredišta iznova s klijenta
        for (const d of [...this.lists.keys()]) if (d === from || d.startsWith(`${from}/`)) this.invalidate(d);
        return {};
      }
      default: throw fail('EINVAL', `unknown op ${h.op}`);
    }
  }

  async mountFuse() {
    lazyUnmount(this.mount); // ostatak od prethodnog pada relaya
    if (WIN) { // WinFsp sam stvara folder za mount; ne smije postojati
      await fsp.mkdir(path.dirname(this.mount), { recursive: true });
      await fsp.rmdir(this.mount).catch(() => {});
    } else await fsp.mkdir(this.mount, { recursive: true });
    const child = spawn(FUSE_BIN, [this.mount], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.fuse = child;
    // helper može nestati (pad, kill); pisanje u njegov stdin ne smije srušiti relay
    child.stdin.on('error', (e) => console.warn(`[remote] ${this.name}: rrweb-fuse stdin: ${e.message}`));
    child.on('error', (e) => console.warn(`[remote] ${this.name}: rrweb-fuse: ${e.message}`));
    let buf = Buffer.alloc(0);
    const send = (head, data = Buffer.alloc(0)) => {
      const h = Buffer.from(JSON.stringify(head));
      const out = Buffer.allocUnsafe(8 + h.length + data.length);
      out.writeUInt32LE(h.length, 0);
      out.writeUInt32LE(data.length, 4);
      h.copy(out, 8);
      data.copy(out, 8 + h.length);
      if (child.stdin.writable) child.stdin.write(out);
    };
    const mounted = new Promise((resolve, reject) => {
      child.once('exit', (code) => reject(new Error(`rrweb-fuse exited (${code})`)));
      child.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const hlen = buf.readUInt32LE(0);
          const dlen = buf.readUInt32LE(4);
          if (buf.length < 8 + hlen + dlen) break;
          let head;
          try { head = JSON.parse(buf.subarray(8, 8 + hlen)); } catch { buf = buf.subarray(8 + hlen + dlen); continue; }
          const data = buf.subarray(8 + hlen, 8 + hlen + dlen);
          buf = buf.subarray(8 + hlen + dlen);
          if (head.op === 'mounted') { resolve(); continue; }
          if (VERBOSE && head.op !== 'read' && head.op !== 'write') console.log(`[fuse] ${head.op} ${head.path ?? `${head.from} → ${head.to}`}`);
          this.fuseOp(head, data).then(
            (r) => (Array.isArray(r) ? send({ id: head.id, ...r[0] }, r[1]) : send({ id: head.id, ...r })),
            (e) => {
              if (VERBOSE) console.log(`[fuse] ${head.op} ${head.path ?? `${head.from} → ${head.to}`}: ${e.code ?? e.message}`);
              if (e.code !== 'ENOENT') console.warn(`[remote] ${this.name}: ${head.op} ${head.path ?? ''}: ${e.message}`);
              send({ id: head.id, err: ERRNO[e.code] ?? ERRNO.EIO });
            });
        }
      });
    });
    child.on('exit', (code, sig) => {
      if (this.fuse === child) this.fuse = null;
      lazyUnmount(this.mount);
      if (!this.stopped) console.warn(`[remote] ${this.name}: rrweb-fuse exited (${sig ?? code})`);
    });
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
    if (this.mode === 'ondemand') {
      await this.mountFuse();
      if (this.fill) this.online().then(() => this.fillAll()).catch(() => {});
    } else { await this.have(); this.watch(); }
  }

  async stop() {
    this.stopped = true;
    for (const w of this.waiters) w.fail();
    this.waiters.clear();
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
    if (this.mode === 'ondemand') {
      // nikad rekurzivno: na još spojenom mountu rm bi išao kroz FUSE (i visio, ili brisao na klijentu)
      lazyUnmount(this.mount);
      await fsp.rmdir(this.mount).catch(() => {});
      await fsp.rmdir(path.dirname(this.mount)).catch(() => {});
    }
  }
}

// onChange(): popis dijeljenih foldera se promijenio (relay osvježi rootove Files taba)
export function createRemote({ validName, insideRoots, onChange = () => {} }) {
  const shares = new Map();
  const id = () => Math.random().toString(36).slice(2, 10);

  async function start({ id: wanted, name, mode, keep, keepDir, fill = true }) {
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
    const share = new Share({ id: sid, name, mode, keep: !!keep, fill: mode === 'ondemand' && fill !== false, mirror,
      mount: path.join(WORK, 'mnt', sid, name) }, shares);
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
      if (!s) { ws.on('error', () => {}); ws.close(4004, 'unknown share'); return; }
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
    work: WORK,
    // Mountovi ostali od prethodnog pada relaya. Tek kad je relay zauzeo port: dok radi drugi relay (isti RR_WORK),
    // njegovi mountovi nisu mrtvi
    sweep() {
      if (process.platform !== 'linux') return;
      try {
        for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
          const [, raw, type] = line.split(' ');
          const dir = raw?.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))); // razmak = \040
          if (type === 'fuse.rrweb' && dir?.startsWith(WORK + path.sep)) { lazyUnmount(dir); console.log(`[remote] cleaned up stale mount ${dir}`); }
        }
      } catch { /* nema /proc/mounts */ }
    },
    roots: () => [...shares.values()].map((s) => s.view),
    // fajl iz foldera "na zahtjev" čiji browser nije spojen dulje od par sekundi (kratki prekid se čeka)
    offline(p) {
      const hit = typeof p === 'string' ? this.locate(p.split('?vc=')[0]) : null;
      return !!hit && !hit.share.agent && Date.now() - hit.share.offlineSince > 5000;
    },
    // Napredak otvaranja fotke za UI (rrweb/files/progress.ts): null za fotke izvan foldera "na zahtjev"
    progress(p) {
      const hit = typeof p === 'string' ? this.locate(p.split('?vc=')[0]) : null;
      if (!hit) return null;
      const { share, rel } = hit;
      if (!share.agent && Date.now() - share.offlineSince > 5000) return { phase: 'offline' };
      const c = share.files.get(rel);
      if (c?.done) return { phase: 'decoding', completedAt: c.completedAt ?? 0 };
      return { phase: 'downloading', fetched: c ? c.fetchedBytes() : 0, total: c?.size ?? 0, rate: Math.round(share.rate()) };
    },
    // fajl iz foldera "na zahtjev" koji se upravo dohvaća: { fetched, total } (thumbnaili u UI-ju)
    fetching(p) {
      const hit = typeof p === 'string' ? this.locate(p.split('?vc=')[0]) : null;
      const c = hit?.share.files.get(hit.rel);
      return c && !c.done && c.inflight.size ? { fetched: c.fetchedBytes(), total: c.size } : null;
    },
    // load_image iz editora: ako je fotka iz foldera "na zahtjev", dohvati je ispred svega ostalog
    focus(p) {
      const hit = typeof p === 'string' && !p.includes('?vc=') ? this.locate(p) : null;
      if (hit) hit.share.setFocus(hit.rel);
    },
    // putanja na mountu foldera "na zahtjev" → { share, rel } (rrweb/relay/raf.mjs)
    locate(p) {
      for (const s of shares.values()) {
        if (s.mode !== 'ondemand' || (p !== s.view && !p.startsWith(s.view + path.sep))) continue;
        const rel = p.slice(s.view.length + 1).split(path.sep).join('/');
        try { return { share: s, rel: checkRel(rel) }; } catch { return null; }
      }
      return null;
    },
    labels: () => Object.fromEntries([...shares.values()].map((s) => [s.view, `${s.name} (this computer${s.agent ? '' : ', not connected'})`])),
    async shutdown() { for (const s of shares.values()) await s.stop().catch(() => {}); },
  };
}
