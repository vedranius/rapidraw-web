// Fuji RAF u folderima "na zahtjev" (rrweb/relay/remote.mjs): thumbnail i EXIF iz ugrađenog JPEG-a.
// RapidRAW ugrađeni JPEG i EXIF čita samo iz TIFF RAW-ova (NEF, ARW, CR2, DNG); za RAF dekodira cijeli RAW, a i EXIF
// za library (read_exif_for_paths, za sve fotke u folderu) čita preko rawlera iz cijelog fajla. Kod foldera "na
// zahtjev" bi tako svaki RAF (30–45 MB) putovao s klijenta čim se folder otvori. Umjesto toga:
//  - thumbnail: browser izreže ugrađeni JPEG, smanji ga na RapidRAW-ove veličine (rrweb/files/remote.ts, "thumb",
//    ~0,3 MB) i relay ga spremi u RapidRAW-ov cache thumbnailova pod ključem koji bi RapidRAW sam izračunao, pa ga
//    RapidRAW samo pročita i javi UI-ju kao i inače. Kao RapidRAW za NEF/ARW: samo za fotke bez editova (.rrdata).
//  - EXIF: browser pošalje samo EXIF zaglavlje ugrađenog JPEG-a ("rafexif", ~65 KB); relay ga spremi kao privremeni
//    .raf i pusti RapidRAW-ov vlastiti EXIF parser da ga pročita (isti put kao za NEF/ARW), bez polja samog JPEG-a.
// Mora pratiti src-tauri/src/file_management.rs i exif_processing.rs; rrweb/check-shims.mjs ruši build ako se promijene.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';

const PARALLEL = 4;   // thumbnaila odjednom (browser ih dekodira paralelno)
const EXIF_PARALLEL = 8;
// EXIF polja koja opisuju ugrađeni JPEG, a ne RAW (dimenzije previewa, kompresija…)
const JPEG_ONLY = new Set(['PixelXDimension', 'PixelYDimension', 'Compression', 'CompressedBitsPerPixel', 'JPEGInterchangeFormat',
  'JPEGInterchangeFormatLength', 'XResolution', 'YResolution', 'ResolutionUnit', 'YCbCrPositioning', 'ComponentsConfiguration',
  'MakerNote', 'UserComment', 'InteroperabilityIndex', 'InteroperabilityVersion', 'FlashpixVersion', 'ColorSpace', 'Orientation']);

const hex = (bytes) => Buffer.from(bytes).toString('hex');

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

// RAF iz foldera "na zahtjev" bez .rrdata: { share, rel, entry } ili null
async function plainRaf(locate, p) {
  if (typeof p !== 'string' || !/\.raf$/i.test(p) || p.includes('?vc=')) return null;
  const hit = locate(p);
  if (!hit || hit.share.local.has(hit.rel)) return null;
  const slash = hit.rel.lastIndexOf('/');
  const name = hit.rel.slice(slash + 1);
  const entries = await hit.share.list(slash < 0 ? '' : hit.rel.slice(0, slash));
  const entry = entries.get(name);
  if (entry?.kind !== 'file' || entries.has(`${name}.rrdata`) || hit.share.local.has(`${hit.rel}.rrdata`)) return null;
  return { ...hit, entry };
}

// locate(p) → { share, rel } za fajl u folderu "na zahtjev" ili null; settings() → RapidRAW postavke;
// bridge(cmd, args) → poziv RapidRAW komande; work → radni folder (RR_WORK)
export function createRaf({ locate, settings, bridge, work }) {
  let dir = process.env.RR_APP_CACHE ? path.join(process.env.RR_APP_CACHE, 'thumbnails') : null;
  let gen = 0;               // update_thumbnail_queue({ paths: [] }) poništava sve što čeka
  const queue = [];
  const pending = new Set();
  const ready = [];
  let running = 0;
  let timer = null;
  let cfg = null;
  let cfgAt = 0;
  const exifCache = new Map(); // "share:rel:size:mtime" → EXIF mapa (ponovno otvaranje foldera)

  async function config() {
    if (!cfg || Date.now() - cfgAt > 30000) {
      const s = await settings().catch(() => ({}));
      cfg = { small: s.smallThumbnailResolution ?? 480, medium: s.mediumThumbnailResolution ?? 1280, off: !!s.alwaysDecodeRawThumbnails };
      cfgAt = Date.now();
    }
    return cfg;
  }

  // Ugrađeni JPEG u RapidRAW-ov cache; ako išta ne štima, RapidRAW thumbnail napravi sam (kao bez ovoga)
  async function prepare({ p }) {
    const c = await config();
    const raf = c.off ? null : await plainRaf(locate, p);
    if (!raf) return;
    const h = cacheHash(p, raf.entry.mtime ?? raf.share.started); // isto vrijeme koje rrweb-fuse javlja RapidRAW-u
    const small = path.join(dir, `${h}_small.jpg`);
    const medium = path.join(dir, `${h}_medium.jpg`);
    if (fs.existsSync(small) && fs.existsSync(medium)) return;
    const { head, data } = await raf.share.request({ op: 'thumb', path: raf.rel, sizes: [c.small, c.medium], quality: 0.75 });
    const [a, b] = head.lens;
    await fsp.mkdir(dir, { recursive: true });
    await writeAtomic(medium, data.subarray(a, a + b));
    await writeAtomic(small, data.subarray(0, a));
  }

  function flush() {
    timer = null;
    if (ready.length) bridge('update_thumbnail_queue', { paths: ready.splice(0) }).catch(() => {});
  }

  function pump() {
    while (running < PARALLEL && queue.length) {
      const item = queue.pop(); // zadnje traženi (vidljivi) prvi, kao i RapidRAW
      running++;
      prepare(item)
        .catch((e) => { if (e.code !== 'ENOENT') console.warn(`[raf] thumbnail ${item.p}: ${e.message}`); })
        .finally(() => {
          running--;
          pending.delete(item.p);
          if (item.gen === gen) { ready.push(item.p); timer ??= setTimeout(flush, 100); }
          pump();
        });
    }
  }

  // EXIF za jedan RAF iz zaglavlja ugrađenog JPEG-a, preko RapidRAW-ovog parsera; null → neka RapidRAW čita sam
  async function exifOf(p, exifDir) {
    const raf = await plainRaf(locate, p);
    if (!raf) return null;
    const key = `${raf.share.id}:${raf.rel}:${raf.entry.size}:${raf.entry.mtime}`;
    if (exifCache.has(key)) return exifCache.get(key);
    const { data } = await raf.share.request({ op: 'rafexif', path: raf.rel });
    const tmp = path.join(exifDir, `${hex(blake3(Buffer.from(p))).slice(0, 32)}.raf`); // stalno ime: RapidRAW-ov .rrcache ne raste
    await fsp.writeFile(tmp, data);
    return { key, tmp };
  }

  return {
    // update_thumbnail_queue iz UI-ja: vraća putanje koje RapidRAW dobiva odmah; RAF-ove iz foldera
    // "na zahtjev" relay prvo pripremi i onda ih sam preda RapidRAW-u
    takeThumbs(paths) {
      if (!paths.length) { gen++; queue.length = 0; pending.clear(); return paths; }
      if (!dir) return paths;
      const now = [];
      for (const p of paths) {
        if (typeof p !== 'string' || !/\.raf$/i.test(p) || p.includes('?vc=') || !locate(p)) now.push(p);
        else if (!pending.has(p)) { pending.add(p); queue.push({ p, gen }); }
      }
      pump();
      return now;
    },

    // read_exif_for_paths iz UI-ja (library čita EXIF svih fotki u folderu): RAF-ovi iz foldera "na zahtjev"
    // iz ugrađenog JPEG-a, ostalo (i sve što ne uspije) normalno preko RapidRAW-a
    async readExif(paths) {
      if (!paths.some((p) => typeof p === 'string' && /\.raf$/i.test(p) && locate(p))) return bridge('read_exif_for_paths', { paths });
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
      const result = await bridge('read_exif_for_paths', { paths: [...direct, ...tmps.map((t) => t.tmp)] }) ?? {};
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
