// All-in-one bridge (Windows, macOS): skida službeni Node.js (Tauri sidecar, SHA256 iz nodejs.org SHASUMS256)
// i generira rrweb/bundle/tauri.bundle.json, overlay koji u bridge dodaje relay + web UI i dozvolu da bridge
// sam pokrene relay. Overlay polja zamjenjuju (ne spajaju) upstream liste, pa se upstream resources/capabilities
// čitaju i nadopunjuju.
//   node rrweb/bundle/prepare.mjs      (RR_NODE_VERSION=v24.x.y za fiksnu verziju; default: zadnji LTS;
//                                      RR_BUNDLE_PLATFORM=darwin-arm64 itd. za test druge platforme)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = 'rrweb/bundle/bin';
const NODE = '../rrweb/bundle/bin/node'; // ime sidecara; isto koristi rrweb/bridge/bridge.ts
// platforma → [rust target triple, Node.js dist datoteka, putanja do binarke unutar arhive]
const TARGETS = {
  'win32-x64': ['x86_64-pc-windows-msvc', 'win-x64/node.exe'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'win-arm64/node.exe'],
  'darwin-x64': ['x86_64-apple-darwin', 'node-{v}-darwin-x64.tar.gz', 'node-{v}-darwin-x64/bin/node'],
  'darwin-arm64': ['aarch64-apple-darwin', 'node-{v}-darwin-arm64.tar.gz', 'node-{v}-darwin-arm64/bin/node'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'node-{v}-linux-x64.tar.gz', 'node-{v}-linux-x64/bin/node'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', 'node-{v}-linux-arm64.tar.gz', 'node-{v}-linux-arm64/bin/node'],
};
const platform = process.env.RR_BUNDLE_PLATFORM ?? `${process.platform}-${process.arch}`;
const os = platform.split('-')[0];
if (!TARGETS[platform]) throw new Error(`no all-in-one bundle for ${platform}`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
};

for (const p of ['rrweb/dist-web/index.html', 'rrweb/relay/node_modules/ws']) {
  if (!existsSync(p)) throw new Error(`nema ${p}: prvo vite build web UI-ja i npm install u rrweb/relay`);
}

const version = process.env.RR_NODE_VERSION
  ?? (await (await get('https://nodejs.org/dist/index.json')).json()).find((r) => r.lts).version;
const [triple, distTpl, innerTpl] = TARGETS[platform];
const dist = distTpl.replaceAll('{v}', version);
const exe = `${BIN}/node-${triple}${os === 'win32' ? '.exe' : ''}`;
const stamp = `${exe}.version`; // koja je verzija/arhiva već raspakirana

const sums = await (await get(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
const want = sums.split('\n').find((l) => l.trim().endsWith(` ${dist}`))?.split(/\s+/)[0];
if (!want) throw new Error(`SHASUMS256 za ${version} nema ${dist}`);
mkdirSync(BIN, { recursive: true });
if (!existsSync(exe) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== `${dist} ${want}`) {
  const buf = Buffer.from(await (await get(`https://nodejs.org/dist/${version}/${dist}`)).arrayBuffer());
  if (sha256(buf) !== want) throw new Error(`${dist}: SHA256 se ne poklapa`);
  if (!innerTpl) writeFileSync(exe, buf);
  else {
    const tmp = mkdtempSync(join(tmpdir(), 'rrweb-node-'));
    writeFileSync(join(tmp, 'node.tar.gz'), buf);
    const inner = innerTpl.replaceAll('{v}', version);
    execFileSync('tar', ['-xzf', 'node.tar.gz', inner], { cwd: tmp }); // relativno: GNU tar "C:\…" čita kao host
    copyFileSync(join(tmp, inner), exe); // ne rename: temp može biti na drugom volumenu
    chmodSync(exe, 0o755);
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(stamp, `${dist} ${want}`);
}
writeFileSync(`${BIN}/NODE-LICENSE.txt`, await (await get(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`)).text());

const up = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const resources = up.bundle?.resources ?? [];
const capabilities = up.app?.security?.capabilities;
if (!Array.isArray(resources) || !Array.isArray(capabilities)) {
  throw new Error('upstream tauri.conf.json: bundle.resources / app.security.capabilities više nisu liste, prilagodi rrweb/bundle/prepare.mjs');
}
const overlay = {
  bundle: {
    externalBin: [...(up.bundle?.externalBin ?? []), NODE],
    resources: [...resources, '../rrweb/dist-web', '../rrweb/relay', `../${BIN}/NODE-LICENSE.txt`],
    // macOS: ad-hoc potpis (nema Apple Developer ID); bez ikakvog potpisa Apple Silicon ne pokreće app
    ...(os === 'darwin' ? { macOS: { signingIdentity: '-' } } : {}),
  },
  app: {
    security: {
      capabilities: [...capabilities, {
        identifier: 'rrweb-relay',
        description: 'rapidraw-web: bridge pokreće ugrađeni relay',
        windows: ['main'],
        permissions: [{
          identifier: 'shell:allow-spawn',
          allow: [{ name: NODE, sidecar: true, args: [{ validator: '.+[\\\\/]relay\\.mjs' }] }],
        }],
      }],
    },
  },
};
writeFileSync('rrweb/bundle/tauri.bundle.json', `${JSON.stringify(overlay, null, 2)}\n`);
console.log(`rrweb: Node.js ${version} (${platform}) → ${exe}, overlay → rrweb/bundle/tauri.bundle.json`);
