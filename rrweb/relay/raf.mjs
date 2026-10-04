// Thumbnaili i EXIF za library, tako da fotka otvorena u editoru uvijek ima prednost.
//  - Raspored: sve thumbnaile (iz UI-ja update_thumbnail_queue) relay predaje RapidRAW-u sam. U libraryju OUT_LIBRARY
//    odjednom, prvo pločice koje se vide (UI ih javlja). Dok je fotka otvorena u editoru (remote.mjs: editor) radi
//    samo u pauzama editiranja (tune.gapMs bez radnje, ništa se ne otvara): lagane (iz cachea, ugrađeni JPEG) za sve,
//    a one koje RapidRAW mora napraviti sam (cijeli RAW, GPU, za foldere "na zahtjev" i dohvat cijelog fajla) samo
//    za fotke oko otvorene u filmstripu (UI: ahead, prvo sljedeće), tune.k odjednom. Koliko odjednom i kolika pauza
//    prilagođava se mjerenju na tom serveru (editTiming). UI vidi relayev napredak, a gore i ukupno stanje (summary).
//  - Fuji RAF: RapidRAW ugrađeni JPEG i EXIF čita samo iz TIFF RAW-ova (NEF, ARW, CR2, DNG); za RAF dekodira cijeli
//    RAW, a EXIF za library (read_exif_for_paths, za sve fotke u folderu) čita preko rawlera iz cijelog fajla.
//    · thumbnail (folderi "na zahtjev", fotke bez .rrdata): browser izreže ugrađeni JPEG, smanji ga na RapidRAW-ove
//      veličine (rrweb/files/remote.ts, "thumb", ~0,3 MB) i relay ga spremi u RapidRAW-ov cache thumbnailova pod
//      ključem koji bi RapidRAW sam izračunao, pa ga RapidRAW samo pročita. Isto kao RapidRAW za NEF/ARW.
//    · EXIF (svi RAF-ovi, osim kad .rrdata već ima EXIF): samo EXIF zaglavlje ugrađenog JPEG-a (~65 KB; s klijenta
//      "rafexif", lokalno iz fajla) spremi se kao privremeni .raf i RapidRAW-ov vlastiti parser ga pročita.
// Mora pratiti src-tauri/src/file_management.rs i exif_processing.rs; rrweb/check-shims.mjs ruši build ako se promijene.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { PRIO, editor } from './remote.mjs';

const PARALLEL = 4;       // pripreme RAF thumbnaila odjednom (browser ih dekodira paralelno)
const OUT_LIBRARY = 4;    // thumbnaila koje RapidRAW radi odjednom dok si u libraryju
const OUT_EDITOR = 1;     // …stariji UI koji ne javlja prikaz, dok editor miruje
// teških odjednom dok je fotka otvorena, najviše (prema broju jezgri: 12 niti → 3, 4 niti → 1); kreće od 1
const OUT_EDITOR_MAX = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 4)));
const SEED_EDITOR = 2;    // pripreme RAF thumbnaila odjednom dok je fotka otvorena
const NEAR_TTL = 30000;   // popis fotki oko otvorene (UI ga javlja svake sekunde dok ima pločica bez thumbnaila)
const OUT_WAIT = 60000;   // thumbnail koji se nikad nije javio (greška) ne smije zauvijek zauzeti mjesto
const EXIF_PARALLEL = 8;
// EXIF polja koja opisuju ugrađeni JPEG, a ne RAW (dimenzije previewa, kompresija…)
const JPEG_ONLY = new Set(['PixelXDimension', 'PixelYDimension', 'Compression', 'CompressedBitsPerPixel', 'JPEGInterchangeFormat',
  'JPEGInterchangeFormatLength', 'XResolution', 'YResolution', 'ResolutionUnit', 'YCbCrPositioning', 'ComponentsConfiguration',
  'MakerNote', 'UserComment', 'InteroperabilityIndex', 'InteroperabilityVersion', 'FlashpixVersion', 'ColorSpace', 'Orientation']);

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const isRaf = (p) => typeof p === 'string' && /\.raf$/i.test(p) && !p.includes('?vc=');

// blake3(putanja ‖ mtime u sekundama, u64 LE ‖ editovi); bez .rrdata su editovi prazni
export function cacheHash(p, mtimeMs) {
  const t = Buffer.alloc(8);
  t.writeBigUInt64LE(BigInt(Math.floor(mtimeMs / 1000)));
  return hex(blake3(Buffer.concat([Buffer.from(p), t])));
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

// SOI … APP1 Exif segment, EOI: dovoljno za EXIF parser (isto radi rrweb/files/remote.ts "rafexif" na klijentu)
function exifHead(j) {
  for (let i = 2; i + 10 <= j.length && j[i] === 0xff;) {
    const seg = 2 + j.readUInt16BE(i + 2);
    if (j[i + 1] === 0xe1 && j.toString('latin1', i + 4, i + 8) === 'Exif') return Buffer.concat([j.subarray(0, i + seg), Buffer.from([0xff, 0xd9])]);
    i += seg;
  }
  return null;
}

// RAF na disku servera: EXIF zaglavlje ugrađenog JPEG-a (zaglavlje RAF-a: pomak i duljina na 84 i 88, big-endian)
async function localExifHead(p) {
  const fh = await fsp.open(p, 'r');
  try {
    const head = Buffer.alloc(92);
    await fh.read(head, 0, 92, 0);
    if (head.toString('latin1', 0, 15) !== 'FUJIFILMCCD-RAW') return null;
    const j = Buffer.alloc(Math.min(head.readUInt32BE(88), 1 << 18));
    await fh.read(j, 0, j.length, head.readUInt32BE(84));
    return exifHead(j);
  } finally { await fh.close(); }
}

// .rrdata s EXIF-om (RapidRAW ga čita prije RAW-a; korisnik ga je možda ručno mijenjao)
const sidecarHasExif = (text) => { try { return !!JSON.parse(text)?.exif; } catch { return false; } };

// locate(p) → { share, rel } za fajl u folderu "na zahtjev" ili null; offline(p) → je li njegov browser odspojen;
// fetching(p) → { fetched, total } dok se fajl dohvaća s klijenta; settings() → RapidRAW postavke;
// bridge(cmd, args) → poziv RapidRAW komande; work → radni folder (RR_WORK)
export function createRaf({ locate, offline, fetching = () => null, settings, bridge, work }) {
  let dir = process.env.RR_APP_CACHE ? path.join(process.env.RR_APP_CACHE, 'thumbnails') : null;
  let gen = 0;               // update_thumbnail_queue({ paths: [] }) poništava sve što čeka
  const queue = [];          // čekaju pripremu (RAF iz foldera "na zahtjev")
  const pending = new Set();
  let running = 0;
  const cheap = [];          // RapidRAW ih ima u cacheu (samo pročita)
  const heavy = [];          // RapidRAW ih mora napraviti sam
  const out = new Map();     // predani RapidRAW-u → { timer, heavy }
  let done = 0;              // za napredak u UI-ju
  const preparing = new Set(); // RAF thumbnail se upravo priprema (browser šalje ugrađeni JPEG)
  let heavyMs = 0;           // prosječno trajanje thumbnaila koji RapidRAW radi sam (za procjenu u UI-ju)
  const ema = (old, v) => (old ? old * 0.7 + v * 0.3 : v);
  let near = { list: [], at: 0 }; // fotke oko otvorene u filmstripu, prvo sljedeće (UI)
  const nearby = () => (Date.now() - near.at < NEAR_TTL ? near.list : []);
  // Rad dok je fotka otvorena: k teških odjednom, nakon gapMs bez radnje u editoru. Obrada slidera ili otvaranje fotke
  // dok RapidRAW radi takav thumbnail sporije nego inače (base: bez thumbnaila) → manje odjednom i dulja pauza;
  // tri thumbnaila bez smetnje → jedan više (do OUT_EDITOR_MAX) i kraća pauza
  const tune = { k: 1, gapMs: 1500, clean: 0, base: {} };
  const heavyOut = () => [...out.values()].filter((o) => o.heavy);
  function retune(k, gapMs, why) {
    if (k === tune.k && gapMs === tune.gapMs) return;
    tune.k = k;
    tune.gapMs = gapMs;
    console.log(`[raf] while editing: ${k} thumbnail${k > 1 ? 's' : ''} at a time, after ${(gapMs / 1000).toFixed(1)} s without changes (${why})`);
  }
  let cfg = null;
  let cfgAt = 0;
  const exifCache = new Map(); // ključ fajla (veličina, vrijeme) → EXIF mapa

  async function config() {
    if (!cfg || Date.now() - cfgAt > 30000) {
      const s = await settings().catch(() => ({}));
      cfg = { small: s.smallThumbnailResolution ?? 480, medium: s.mediumThumbnailResolution ?? 1280, off: !!s.alwaysDecodeRawThumbnails };
      cfgAt = Date.now();
    }
    return cfg;
  }

  // RAF iz foldera "na zahtjev": { share, rel, entry, edited } ili null
  async function remoteRaf(p) {
    if (!isRaf(p)) return null;
    const hit = locate(p);
    if (!hit || hit.share.local.has(hit.rel)) return null;
    const slash = hit.rel.lastIndexOf('/');
    const name = hit.rel.slice(slash + 1);
    const entries = await hit.share.list(slash < 0 ? '' : hit.rel.slice(0, slash));
    const entry = entries.get(name);
    if (entry?.kind !== 'file') return null;
    return { ...hit, entry, edited: entries.has(`${name}.rrdata`) || hit.share.local.has(`${hit.rel}.rrdata`) };
  }

  // Ugrađeni JPEG u RapidRAW-ov cache. true = RapidRAW će thumbnail samo pročitati iz cachea;
  // false = mora ga napraviti sam (lokalni fajl, editirana fotka, drugi format, ili nešto nije štimalo)
  async function prepare({ p }) {
    const c = await config();
    const raf = c.off || !dir ? null : await remoteRaf(p);
    if (!raf || raf.edited) return false;
    const h = cacheHash(p, raf.entry.mtime ?? raf.share.started); // isto vrijeme koje rrweb-fuse javlja RapidRAW-u
    const small = path.join(dir, `${h}_small.jpg`);
    const medium = path.join(dir, `${h}_medium.jpg`);
    if (fs.existsSync(small) && fs.existsSync(medium)) return true;
    await editor.gap(() => tune.gapMs, () => raf.share.stopped);
    const { head, data } = await raf.share.requestAt(PRIO.SEED, { op: 'thumb', path: raf.rel, sizes: [c.small, c.medium], quality: 0.75 });
    const [a, b] = head.lens;
    await fsp.mkdir(dir, { recursive: true });
    await writeAtomic(medium, data.subarray(a, a + b));
    await writeAtomic(small, data.subarray(0, a));
    return true;
  }

  function submit(paths, isHeavy, inEditor = false) {
    for (const p of paths) out.set(p, { heavy: isHeavy, inEditor, hit: false, at: Date.now(), timer: setTimeout(() => finished(p), OUT_WAIT) });
    bridge('update_thumbnail_queue', { paths }).catch(() => paths.forEach(finished));
  }

  function finished(p, ok = false) {
    const o = out.get(p);
    if (!o) return;
    if (ok && o.heavy) heavyMs = ema(heavyMs, Date.now() - o.at);
    if (ok && o.inEditor && !o.hit && ++tune.clean >= 3) {
      tune.clean = 0;
      retune(Math.min(OUT_EDITOR_MAX, tune.k + 1), Math.max(1000, Math.round(tune.gapMs * 0.8)), 'editing stayed fast');
    }
    clearTimeout(o.timer);
    out.delete(p);
    done++;
    pumpOut();
  }

  // koliko teških thumbnaila RapidRAW smije raditi odjednom: dok je fotka otvorena tune.k u pauzi editiranja
  // (stariji UI koji ne javlja prikaz: jedan, kad editor miruje)
  const heavyLimit = () => (editor.editing() ? (editor.open(tune.gapMs) ? tune.k : 0)
    : editor.busy() ? 0 : editor.viewKnown() ? OUT_LIBRARY : editor.recent() ? OUT_EDITOR : OUT_LIBRARY);

  // Predaja RapidRAW-u prema tome što radi editor; fotke iz foldera čiji browser nije spojen čekaju
  function pumpOut() {
    const editing = editor.editing();
    if (!editor.open(tune.gapMs)) return;
    const ready = (p) => !offline(p);
    const now = cheap.filter(ready);
    if (now.length) { cheap.splice(0, cheap.length, ...cheap.filter((p) => !ready(p))); submit(now, false); }
    const limit = heavyLimit();
    let active = heavyOut().length;
    if (editing) { // samo fotke oko otvorene, prvo sljedeće
      for (const p of nearby()) {
        if (active >= limit) break;
        const i = heavy.indexOf(p);
        if (i < 0 || !ready(p)) continue;
        submit(heavy.splice(i, 1), true, true);
        active++;
      }
    } else {
      for (let i = heavy.length - 1; i >= 0 && active < limit; i--) { // zadnje traženi (vidljivi) prvi, kao i RapidRAW
        if (!ready(heavy[i])) continue;
        submit(heavy.splice(i, 1), true);
        active++;
      }
    }
    if (!busyWork()) done = 0;
  }
  setInterval(pumpOut, 500).unref(); // nastavi kad editor utihne

  const busyWork = () => queue.length + running + cheap.length + heavy.length + out.size > 0;

  // tražene pločice na kraj redova (predaje se od kraja), prva tražena posljednja, da dođe prva
  function prioritize(paths) {
    const rank = new Map();
    paths.forEach((p, i) => { if (!rank.has(p)) rank.set(p, i); });
    if (!rank.size) return;
    const order = (arr, key) => {
      const want = arr.filter((x) => rank.has(key(x)));
      if (!want.length) return;
      want.sort((a, b) => rank.get(key(b)) - rank.get(key(a)));
      arr.splice(0, arr.length, ...arr.filter((x) => !rank.has(key(x))), ...want);
    };
    order(heavy, (p) => p);
    order(cheap, (p) => p);
    order(queue, (i) => i.p);
  }

  function pump() {
    while (running < (editor.editing() ? SEED_EDITOR : PARALLEL) && queue.length) {
      const item = queue.pop();
      running++;
      preparing.add(item.p);
      prepare(item)
        .catch((e) => { if (e.code !== 'ENOENT') console.warn(`[raf] thumbnail ${item.p}: ${e.message}`); return false; })
        .then((isCached) => {
          running--;
          pending.delete(item.p);
          preparing.delete(item.p);
          if (item.gen === gen) (isCached ? cheap : heavy).push(item.p);
          pumpOut();
          pump();
        });
    }
  }

  // EXIF za jedan RAF iz zaglavlja ugrađenog JPEG-a, preko RapidRAW-ovog parsera; null → neka RapidRAW čita sam
  async function exifOf(p, exifDir) {
    if (!isRaf(p)) return null;
    let key;
    let head;
    const raf = locate(p) ? await remoteRaf(p) : null;
    if (raf) {
      key = `${raf.share.id}:${raf.rel}:${raf.entry.size}:${raf.entry.mtime}`;
      if (exifCache.has(key)) return exifCache.get(key);
      if (raf.edited) {
        const side = await raf.share.cached(`${raf.rel}.rrdata`).catch(() => null);
        if (!side || sidecarHasExif((await side.read(0, side.size)).toString('utf8'))) return null;
      }
      ({ data: head } = await raf.share.requestAt(PRIO.SEED, { op: 'rafexif', path: raf.rel }));
    } else {
      const st = await fsp.stat(p).catch(() => null);
      if (!st?.isFile() || locate(p)) return null;
      key = `local:${p}:${st.size}:${st.mtimeMs}`;
      if (exifCache.has(key)) return exifCache.get(key);
      const side = await fsp.readFile(`${p}.rrdata`, 'utf8').catch(() => null);
      if (side !== null && sidecarHasExif(side)) return null;
      head = await localExifHead(p);
      if (!head) return null;
    }
    const tmp = path.join(exifDir, `${hex(blake3(Buffer.from(p))).slice(0, 32)}.raf`); // stalno ime: RapidRAW-ov .rrcache ne raste
    await fsp.writeFile(tmp, head);
    return { key, tmp };
  }

  return {
    // update_thumbnail_queue iz UI-ja: relay ih predaje RapidRAW-u sam (pumpOut); prazna lista poništava red
    // (vraća true ako zahtjev treba proslijediti RapidRAW-u)
    takeThumbs(paths) {
      if (!paths.length) {
        gen++;
        queue.length = 0;
        pending.clear();
        cheap.length = 0;
        heavy.length = 0;
        done = 0;
        return true;
      }
      for (const p of paths) {
        if (typeof p !== 'string' || pending.has(p) || out.has(p)) continue;
        if (isRaf(p) && locate(p)) { pending.add(p); queue.push({ p, gen }); } else if (!heavy.includes(p)) heavy.push(p);
      }
      pump();
      pumpOut();
      return false;
    },

    // thumbnail-generated iz RapidRAW-a
    generated(p) { finished(p, true); },

    // Stanje thumbnaila za UI (rrweb/files/progress.ts): u redu (mjesto, procjena), priprema, dohvat, renderiranje;
    // gotovi i nepoznati se ne vraćaju. paths: pločice koje se upravo vide; ahead: u editoru fotke oko otvorene u
    // filmstripu, prvo sljedeće (samo one smiju teške thumbnaile dok je fotka otvorena)
    status(paths, ahead) {
      if (Array.isArray(ahead)) near = { list: ahead.filter((p) => typeof p === 'string').slice(0, 40), at: Date.now() };
      prioritize([...(Array.isArray(ahead) ? near.list : []), ...paths]); // na početak reda
      pumpOut();
      const editing = editor.editing();
      const nearSet = new Set(editing ? nearby() : []);
      const busy = !editing && editor.busy();
      const limit = editing ? tune.k : Math.max(1, heavyLimit() || OUT_LIBRARY);
      const res = {};
      for (const p of paths) {
        const o = out.get(p);
        if (o) {
          const dl = fetching(p);
          res[p] = dl ? { state: 'downloading', ...dl } : { state: 'rendering', ms: Date.now() - o.at };
        } else if (preparing.has(p)) res[p] = { state: 'preparing' };
        else if (heavy.includes(p)) {
          // u editoru: mjesto među fotkama oko otvorene; ostale čekaju library
          const pos = editing ? near.list.filter((q) => heavy.includes(q)).indexOf(p) + 1 : heavy.length - heavy.lastIndexOf(p);
          const paused = busy || (editing && !nearSet.has(p));
          res[p] = { state: 'queued', pos: pos || undefined, paused, eta: paused ? null : Math.round(Math.ceil(pos / limit) * (heavyMs || 3000) / 1000) };
        } else if (cheap.includes(p) || pending.has(p)) res[p] = { state: 'queued', paused: busy };
      }
      return res;
    },
    // thumbnail-generation-complete: RapidRAW nema više ništa u redu (i one koji nisu uspjeli, pa se nisu javili)
    drained() { for (const p of [...out.keys()]) finished(p); },
    // napredak za UI dok relay još ima posla (null: neka UI vidi RapidRAW-ov)
    progress() { return busyWork() ? { current: done, total: done + queue.length + running + cheap.length + heavy.length + out.size } : null; },

    // ukupno stanje za traku na vrhu: koliko ih je još, procjena, stoji li zbog editora
    summary() {
      const outHeavy = heavyOut().length;
      const left = queue.length + running + cheap.length + heavy.length + out.size;
      const editing = editor.editing();
      const paused = !editing && editor.busy();
      const eta = Math.round(Math.ceil((heavy.length + outHeavy) / OUT_LIBRARY) * (heavyMs || 3000) / 1000);
      // u editoru: koliko ih se radi u pauzama (lagani i oni oko otvorene), ostali čekaju library
      const nearSet = new Set(editing ? nearby() : []);
      const later = editing ? heavy.filter((p) => !nearSet.has(p)).length : 0;
      return { left, heavy: heavy.length + outHeavy, paused, eta: left && !editing ? eta : 0, editing, later };
    },

    // Trajanje obrade u editoru (relay.mjs): 'interactive' i 'final' pregled, 'load' (dekodiranje fotke). Sporije nego
    // inače dok RapidRAW radi thumbnail predan u editoru → manje odjednom, dulja pauza
    editTiming(kind, ms) {
      const running = heavyOut();
      const base = tune.base[kind] ?? 0;
      if (!running.length) { tune.base[kind] = ema(base, ms); return; }
      if (!base || !running.some((o) => o.inEditor) || ms <= base * 1.5 + 40) return;
      for (const o of running) o.hit = true;
      tune.clean = 0;
      retune(Math.max(1, tune.k - 1), Math.min(8000, Math.round(tune.gapMs * 1.5)),
        `${kind === 'load' ? 'opening a photo' : 'a slider preview'} took ${Math.round(ms)} ms instead of ~${Math.round(base)} ms`);
    },

    // read_exif_for_paths iz UI-ja (library čita EXIF svih fotki u folderu): RAF-ovi iz ugrađenog JPEG-a,
    // ostalo (i sve što ne uspije) normalno preko RapidRAW-a; fotke iz odspojenih foldera se preskaču
    async readExif(paths) {
      paths = paths.filter((p) => !offline(p));
      if (!paths.some(isRaf)) return paths.length ? bridge('read_exif_for_paths', { paths }) : {};
      const exifDir = path.join(work, 'exif');
      await fsp.mkdir(exifDir, { recursive: true });
      const found = new Map();
      const todo = [...paths];
      await Promise.all(Array.from({ length: EXIF_PARALLEL }, async () => {
        for (let p; (p = todo.shift()) !== undefined;) {
          try { found.set(p, await exifOf(p, exifDir)); } catch (e) {
            if (e.code !== 'ENOENT') console.warn(`[raf] exif ${p}: ${e.message}`);
            found.set(p, null);
          }
        }
      }));
      const tmps = [...found.values()].filter((v) => v?.tmp);
      const direct = paths.filter((p) => !found.get(p));
      const result = (direct.length || tmps.length ? await bridge('read_exif_for_paths', { paths: [...direct, ...tmps.map((t) => t.tmp)] }) : null) ?? {};
      for (const [p, v] of found) {
        if (!v) continue;
        let map = v.tmp ? result[v.tmp] : v;
        if (v.tmp) {
          delete result[v.tmp];
          if (!map) continue; // RapidRAW nije razumio zaglavlje: drugi put ide normalnim putem
          map = Object.fromEntries(Object.entries(map).filter(([k]) => !JPEG_ONLY.has(k) && !k.startsWith('Tag(')));
          if (map.PhotographicSensitivity && !map.ISOSpeedRatings) map.ISOSpeedRatings = map.PhotographicSensitivity;
          if (exifCache.size > 50000) exifCache.clear();
          exifCache.set(v.key, map);
        }
        result[p] = map;
      }
      await Promise.all(tmps.map((t) => fsp.rm(t.tmp, { force: true })));
      return result;
    },

    // bez RR_APP_CACHE: cache folder iz prvog thumbnail-generated eventa
    learn(thumbnailPath) { if (!dir && typeof thumbnailPath === 'string') dir = path.dirname(thumbnailPath); },
  };
}
