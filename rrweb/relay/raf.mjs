// Thumbnaili i EXIF za library, tako da fotka otvorena u editoru uvijek ima prednost.
//  - Raspored: sve thumbnaile (iz UI-ja update_thumbnail_queue) relay predaje RapidRAW-u sam. Dok editor radi
//    (otvaranje fotke, slideri, i EDIT_QUIET nakon toga; remote.mjs: editor) ne predaje nijedan; dok je fotka otvorena,
//    a editor miruje, po jedan; u libraryju OUT_LIBRARY odjednom (koliko RapidRAW ima workera). Thumbnail editirane
//    fotke RapidRAW renderira iz cijelog RAW-a na GPU-u, pa bi inače usporavao slidere. UI vidi relayev napredak.
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
import path from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { PRIO, editor } from './remote.mjs';

const PARALLEL = 4;       // pripreme RAF thumbnaila odjednom (browser ih dekodira paralelno)
const OUT_LIBRARY = 4;    // thumbnaila koje RapidRAW radi odjednom dok si u libraryju
const OUT_EDITOR = 1;     // …dok je fotka otvorena u editoru, a editor miruje
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
// settings() → RapidRAW postavke; bridge(cmd, args) → poziv RapidRAW komande; work → radni folder (RR_WORK)
export function createRaf({ locate, offline, settings, bridge, work }) {
  let dir = process.env.RR_APP_CACHE ? path.join(process.env.RR_APP_CACHE, 'thumbnails') : null;
  let gen = 0;               // update_thumbnail_queue({ paths: [] }) poništava sve što čeka
  const queue = [];          // čekaju pripremu (RAF iz foldera "na zahtjev")
  const pending = new Set();
  let running = 0;
  const cheap = [];          // RapidRAW ih ima u cacheu (samo pročita)
  const heavy = [];          // RapidRAW ih mora napraviti sam
  const out = new Map();     // predani RapidRAW-u → { timer, heavy }
  let done = 0;              // za napredak u UI-ju
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
    await editor.idle(() => raf.share.stopped);
    const { head, data } = await raf.share.requestAt(PRIO.SEED, { op: 'thumb', path: raf.rel, sizes: [c.small, c.medium], quality: 0.75 });
    const [a, b] = head.lens;
    await fsp.mkdir(dir, { recursive: true });
    await writeAtomic(medium, data.subarray(a, a + b));
    await writeAtomic(small, data.subarray(0, a));
    return true;
  }

  function submit(paths, isHeavy) {
    for (const p of paths) out.set(p, { heavy: isHeavy, timer: setTimeout(() => finished(p), OUT_WAIT) });
    bridge('update_thumbnail_queue', { paths }).catch(() => paths.forEach(finished));
  }

  function finished(p) {
    const o = out.get(p);
    if (!o) return;
    clearTimeout(o.timer);
    out.delete(p);
    done++;
    pumpOut();
  }

  // Predaja RapidRAW-u prema tome što radi editor; fotke iz foldera čiji browser nije spojen čekaju
  function pumpOut() {
    if (editor.busy()) return;
    const ready = (p) => !offline(p);
    const now = cheap.filter(ready);
    if (now.length) { cheap.splice(0, cheap.length, ...cheap.filter((p) => !ready(p))); submit(now, false); }
    const limit = editor.recent() ? OUT_EDITOR : OUT_LIBRARY;
    let active = [...out.values()].filter((o) => o.heavy).length;
    for (let i = heavy.length - 1; i >= 0 && active < limit; i--) { // zadnje traženi (vidljivi) prvi, kao i RapidRAW
      if (!ready(heavy[i])) continue;
      submit(heavy.splice(i, 1), true);
      active++;
    }
    if (!busyWork()) done = 0;
  }
  setInterval(pumpOut, 500).unref(); // nastavi kad editor utihne

  const busyWork = () => queue.length + running + cheap.length + heavy.length + out.size > 0;

  function pump() {
    while (running < PARALLEL && queue.length) {
      const item = queue.pop();
      running++;
      prepare(item)
        .catch((e) => { if (e.code !== 'ENOENT') console.warn(`[raf] thumbnail ${item.p}: ${e.message}`); return false; })
        .then((isCached) => {
          running--;
          pending.delete(item.p);
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
    generated(p) { finished(p); },
    // thumbnail-generation-complete: RapidRAW nema više ništa u redu (i one koji nisu uspjeli, pa se nisu javili)
    drained() { for (const p of [...out.keys()]) finished(p); },
    // napredak za UI dok relay još ima posla (null: neka UI vidi RapidRAW-ov)
    progress() { return busyWork() ? { current: done, total: done + queue.length + running + cheap.length + heavy.length + out.size } : null; },

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
