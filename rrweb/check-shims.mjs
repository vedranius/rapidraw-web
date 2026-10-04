// Provjerava da shimovi pokrivaju svaki @tauri-apps/* modul i svaki imenovani import u src/.
// Pada (exit 1) s popisom onoga što fali → upstream je počeo koristiti novi Tauri API.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SHIMS = {
  '@tauri-apps/api/core': 'core', '@tauri-apps/api/event': 'event',
  '@tauri-apps/api/window': 'window', '@tauri-apps/api/path': 'path',
  '@tauri-apps/api/app': 'app', '@tauri-apps/plugin-dialog': 'dialog',
  '@tauri-apps/plugin-os': 'os', '@tauri-apps/plugin-process': 'process',
  '@tauri-apps/plugin-shell': 'shell',
};
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
});
const exportsOf = (mod) => {
  const src = readFileSync(`rrweb/shim/${SHIMS[mod]}.ts`, 'utf8');
  return new Set([...src.matchAll(/export\s+(?:async\s+)?(?:const|function|let|type)\s+(\w+)/g)].map((m) => m[1]));
};

const problems = [];
const re = /import\s+(type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s+from\s+['"](@tauri-apps\/[\w/-]+)['"]/g;
for (const f of walk('src')) {
  for (const m of readFileSync(f, 'utf8').matchAll(re)) {
    const [, isType, names, mod] = m;
    if (!SHIMS[mod]) { problems.push(`${f}: modul ${mod} nema shim`); continue; }
    if (isType || !names) continue;
    const have = exportsOf(mod);
    for (const raw of names.split(',')) {
      const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (n && !raw.trim().startsWith('type ') && !have.has(n)) problems.push(`${f}: ${mod} → '${n}' nije u rrweb/shim/${SHIMS[mod]}.ts`);
    }
  }
}
// rrweb/relay/raf.mjs piše u RapidRAW-ov cache thumbnailova i EXIF RAF-a čita kroz RapidRAW: ključ, imena fajlova,
// kodiranje i put čitanja EXIF-a moraju ostati isti
const fm = readFileSync('src-tauri/src/file_management.rs', 'utf8');
const ex = readFileSync('src-tauri/src/exif_processing.rs', 'utf8');
const ui = readFileSync('src/hooks/useThumbnails.ts', 'utf8');
const nav = readFileSync('src/hooks/useAppNavigation.ts', 'utf8');
for (const [what, ok] of [
  ['cache folder "thumbnails"', fm.includes('cache_dir.join("thumbnails")')],
  ['cache ključ blake3(path ‖ mtime sekunde LE ‖ adjustments)', /hasher\.update\(path_str\.as_bytes\(\)\);\s*hasher\.update\(&img_mod_time\.to_le_bytes\(\)\);\s*hasher\.update\(adjustments_bytes\);/.test(fm)],
  ['mtime u sekundama', /\.duration_since\(std::time::UNIX_EPOCH\)\s*\.ok\(\)\?\s*\.as_secs\(\)/.test(fm)],
  ['bez .rrdata su adjustments prazni', /\} else \{\s*\(0, false, Vec::new\(\)\)\s*\};\s*let cache_hash = compute_thumbnail_cache_hash\(path_str, &adjustments_bytes\)/.test(fm)],
  ['imena {hash}_small.jpg / {hash}_medium.jpg', fm.includes('format!("{}_small.jpg", cache_hash)') && fm.includes('format!("{}_medium.jpg", cache_hash)')],
  ['gotov cache se koristi bez dekodiranja', /if !force_regenerate && small_path\.exists\(\) && medium_path\.exists\(\)/.test(fm)],
  ['JPEG kvaliteta 75, downscale na dulju stranicu', fm.includes('JpegEncoder::new_with_quality(&mut buf, 75)') && fm.includes('downscale_f32_image(image, target_width, target_width)')],
  ['UI traži thumbnailove s update_thumbnail_queue({ paths })', ui.includes("invoke('update_thumbnail_queue', { paths: pathsToSend })")],
  ['UI čita EXIF s read_exif_for_paths({ paths })', nav.includes('invoke(Invokes.ReadExifForPaths, { paths: chunk })')],
  ['EXIF RAW-a: prvo kamadak-exif (extract_metadata), pa rawler', /if is_raw_file\(path\)\s*&& let Some\(map\) = extract_metadata\(file_bytes\)/.test(ex) && /if !map\.is_empty\(\) \{(?:(?!\n    \}\n)[\s\S]){0,600}?return Some\(map\);\s*\}\s*let metadata = read_raw_metadata\(file_bytes\)\?;/.test(ex)],
]) if (!ok) problems.push(`RapidRAW thumbnail/EXIF se promijenio (${what}): prilagodi rrweb/relay/raf.mjs`);
// rrweb/files/adjust.ts: kružić pokraj slidera traži slider po markupu i prepoznaje preskočene preglede
const slider = readFileSync('src/components/ui/Slider.tsx', 'utf8');
const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
for (const [what, ok] of [
  ['Slider: <div className="mb-2 group …"> s jednim <input type="range">', slider.includes('className={`mb-2 group ') && (slider.match(/type="range"/g) ?? []).length === 1],
  ['Slider: naziv u prvom <span>, vrijednost u <div className="w-12 …">', /<span[\s\S]*?\{label\}/.test(slider) && slider.includes('<div className="w-12 text-right">')],
  ['preskočen pregled: "Superseded or worker failed"', lib.includes('"Superseded or worker failed"')],
]) if (!ok) problems.push(`RapidRAW editor se promijenio (${what}): prilagodi rrweb/files/adjust.ts`);
if (problems.length) { console.error('rrweb shim check FAILED:\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`rrweb shim check OK (${Object.keys(SHIMS).length} modula)`);
