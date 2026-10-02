// Windows all-in-one installer: skida node.exe (Tauri sidecar) i generira rrweb/win/tauri.windows.json,
// overlay koji u bridge dodaje relay + web UI i dozvolu da bridge sam pokrene relay.
// Overlay polja zamjenjuju (ne spajaju) upstream liste, pa se upstream resources/capabilities čitaju i nadopunjuju.
//   node rrweb/win/prepare.mjs     (RR_NODE_VERSION=v22.x.y za fiksnu verziju; default: zadnji LTS)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BIN = 'rrweb/win/bin';
const NODE = '../rrweb/win/bin/node'; // ime sidecara; isto koristi rrweb/bridge/bridge.ts
const EXE = `${BIN}/node-x86_64-pc-windows-msvc.exe`;
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
const sums = await (await get(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
const want = sums.split('\n').find((l) => l.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
if (!want) throw new Error(`SHASUMS256 za ${version} nema win-x64/node.exe`);
mkdirSync(BIN, { recursive: true });
if (!existsSync(EXE) || sha256(readFileSync(EXE)) !== want) {
  const buf = Buffer.from(await (await get(`https://nodejs.org/dist/${version}/win-x64/node.exe`)).arrayBuffer());
  if (sha256(buf) !== want) throw new Error('node.exe: SHA256 se ne poklapa');
  writeFileSync(EXE, buf);
}
writeFileSync(`${BIN}/NODE-LICENSE.txt`, await (await get(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`)).text());

const up = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const resources = up.bundle?.resources ?? [];
const capabilities = up.app?.security?.capabilities;
if (!Array.isArray(resources) || !Array.isArray(capabilities)) {
  throw new Error('upstream tauri.conf.json: bundle.resources / app.security.capabilities više nisu liste, prilagodi rrweb/win/prepare.mjs');
}
const overlay = {
  bundle: {
    externalBin: [...(up.bundle?.externalBin ?? []), NODE],
    resources: [...resources, '../rrweb/dist-web', '../rrweb/relay', `../${BIN}/NODE-LICENSE.txt`],
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
writeFileSync('rrweb/win/tauri.windows.json', JSON.stringify(overlay, null, 2) + '\n');
console.log(`rrweb: Node.js ${version} → ${EXE}, overlay → rrweb/win/tauri.windows.json`);
