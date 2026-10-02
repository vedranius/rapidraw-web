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
if (problems.length) { console.error('rrweb shim check FAILED:\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`rrweb shim check OK (${Object.keys(SHIMS).length} modula)`);
