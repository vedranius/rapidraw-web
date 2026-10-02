// rrweb Files tab (server): listanje, skidanje (fajl ili zip), upload, novi folder, preimenovanje, kopiranje,
// premještanje i brisanje u koš (preko RapidRAW-a). Sve putanje moraju biti unutar foldera s fotografijama
// koje RapidRAW koristi (rootFolders, pinnedFolders, lastRootPath) ili RR_PHOTOS.
// Fajl putuje sa svojim sidecarima kao u RapidRAW-u: <ime>.rrdata, <ime>.<id>.rrdata (virtualne kopije), <ime>.rrexif.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

const CP = { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true };
const isSidecar = (name) => /\.(rrdata|rrexif)$/i.test(name);
const inside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const exists = (p) => fsp.lstat(p).then(() => true, () => false);
const samePath = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..'
    || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new Error(`Invalid name: ${name}`);
  return name;
}

async function sidecars(file) {
  const name = path.basename(file);
  return (await fsp.readdir(path.dirname(file))).filter((n) => n.startsWith(`${name}.`) && isSidecar(n));
}

async function assertFree(plan) {
  const taken = [];
  for (const [src, dst] of plan) if (!samePath(src, dst) && await exists(dst)) taken.push(path.basename(dst));
  if (taken.length) throw new Error(`Already exists: ${taken.join(', ')}`);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { s += c; if (s.length > max) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

const disposition = (name) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

async function addToZip(zip, p, name) {
  const st = await fsp.stat(p);
  if (st.isDirectory()) {
    zip.addEmptyDirectory(name, { mtime: st.mtime });
    for (const e of await fsp.readdir(p)) await addToZip(zip, path.join(p, e), `${name}/${e.replace(/\\/g, '_')}`);
  } else {
    zip.addFile(p, name, { compress: false, mtime: st.mtime }); // fotke su već komprimirane
  }
}

// settings(): RapidRAW postavke (preko bridgea), bridge(cmd, args): poziv RapidRAW komande
export function createFiles({ settings, bridge, extraRoots = [] }) {
  let cached = { at: 0, roots: [] };

  async function roots() {
    if (Date.now() - cached.at < 3000) return cached.roots;
    const s = await settings().catch(() => ({}));
    const real = [];
    for (const p of [...(s.rootFolders ?? []), ...(s.pinnedFolders ?? []), s.lastRootPath, ...extraRoots]) {
      if (!p) continue;
      try {
        const r = await fsp.realpath(p);
        if ((await fsp.stat(r)).isDirectory() && !real.includes(r)) real.push(r);
      } catch { /* folder više ne postoji */ }
    }
    cached = { at: Date.now(), roots: real.filter((r) => !real.some((o) => o !== r && inside(r, o))) };
    return cached.roots;
  }

  async function within(p) {
    if (typeof p !== 'string' || !p) throw new Error('Missing path');
    const real = await fsp.realpath(p);
    if (!(await roots()).some((r) => inside(real, r))) throw new Error(`Outside the photo folders: ${p}`);
    return real;
  }

  async function notRoot(real, what) {
    if ((await roots()).includes(real)) throw new Error(`A photo folder root cannot be ${what} here (use RapidRAW)`);
  }

  async function ls({ path: dir }) {
    const rs = await roots();
    if (!dir) return { path: null, roots: rs, sep: path.sep, crumbs: [], items: [] };
    const real = await within(dir);
    const root = rs.find((r) => inside(real, r));
    const crumbs = [];
    for (let p = real; ; p = path.dirname(p)) {
      crumbs.unshift({ name: path.basename(p) || p, path: p });
      if (p === root || path.dirname(p) === p) break;
    }
    const items = [];
    for (const e of await fsp.readdir(real, { withFileTypes: true })) {
      try {
        const st = await fsp.stat(path.join(real, e.name));
        const dir = st.isDirectory();
        items.push({ name: e.name, dir, size: dir ? 0 : st.size, mtime: st.mtimeMs, sidecar: !dir && isSidecar(e.name) });
      } catch { /* pokvaren link, nema prava… */ }
    }
    return { path: real, roots: rs, sep: path.sep, crumbs, items };
  }

  async function mkdir({ dir, name }) {
    await fsp.mkdir(path.join(await within(dir), validName(name)));
  }

  async function rename({ path: p, name }) {
    const src = await within(p);
    await notRoot(src, 'renamed');
    validName(name);
    const dir = path.dirname(src);
    const old = path.basename(src);
    if (old === name) return;
    const plan = [[src, path.join(dir, name)]];
    if (!(await fsp.stat(src)).isDirectory()) {
      for (const c of await sidecars(src)) plan.push([path.join(dir, c), path.join(dir, name + c.slice(old.length))]);
    }
    await assertFree(plan);
    for (const [a, b] of plan) await fsp.rename(a, b);
  }

  async function transfer({ paths, dest }, move) {
    const d = await within(dest);
    if (!(await fsp.stat(d)).isDirectory()) throw new Error('Destination is not a folder');
    const plan = new Map(); // izvor → cilj
    for (const p of paths ?? []) {
      const src = await within(p);
      if (move) await notRoot(src, 'moved');
      if (inside(d, src)) throw new Error(`Cannot put a folder inside itself: ${path.basename(src)}`);
      plan.set(src, path.join(d, path.basename(src)));
      if (!(await fsp.stat(src)).isDirectory()) {
        for (const c of await sidecars(src)) plan.set(path.join(path.dirname(src), c), path.join(d, c));
      }
    }
    await assertFree(plan);
    for (const [src, dst] of plan) {
      if (samePath(src, dst)) continue;
      if (!move) await fsp.cp(src, dst, CP);
      else await fsp.rename(src, dst).catch(async (e) => {
        if (e.code !== 'EXDEV') throw e; // drugi disk: kopiraj pa obriši
        await fsp.cp(src, dst, CP);
        await fsp.rm(src, { recursive: true });
      });
    }
  }

  // U koš, preko RapidRAW-a (trash crate; uz fajl idu i njegovi sidecari)
  async function remove({ paths }) {
    const files = [];
    const dirs = [];
    for (const p of paths ?? []) {
      const real = await within(p);
      await notRoot(real, 'deleted');
      ((await fsp.stat(real)).isDirectory() ? dirs : files).push(real);
    }
    if (files.length) await bridge('delete_files_from_disk', { paths: files });
    for (const d of dirs) await bridge('delete_folder', { path: d });
  }

  const commands = {
    __rr_fs_ls: ls,
    __rr_fs_mkdir: mkdir,
    __rr_fs_rename: rename,
    __rr_fs_copy: (a) => transfer(a, false),
    __rr_fs_move: (a) => transfer(a, true),
    __rr_fs_delete: remove,
  };

  // GET /fm/dl?path=…  ·  POST /fm/zip (form: path=…&path=…&name=…)  ·  PUT /fm/upload?dir=…&name=…[&overwrite=1]
  async function http(req, res, u) {
    if (!u.pathname.startsWith('/fm/')) return false;
    try {
      if (u.pathname === '/fm/dl' && req.method === 'GET') {
        const f = await within(u.searchParams.get('path'));
        const st = await fsp.stat(f);
        if (!st.isFile()) throw new Error('Not a file');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size,
          'Content-Disposition': disposition(path.basename(f)), 'X-Content-Type-Options': 'nosniff' });
        await pipeline(fs.createReadStream(f), res);
      } else if (u.pathname === '/fm/zip' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req, 4 << 20));
        const items = [];
        for (const p of form.getAll('path')) items.push(await within(p));
        if (!items.length) throw new Error('Nothing selected');
        const zip = new yazl.ZipFile();
        res.writeHead(200, { 'Content-Type': 'application/zip',
          'Content-Disposition': disposition(`${(form.get('name') || 'photos').replace(/[\\/]/g, '_')}.zip`) });
        const done = pipeline(zip.outputStream, res);
        for (const it of items) await addToZip(zip, it, path.basename(it).replace(/\\/g, '_'));
        zip.end();
        await done;
      } else if (u.pathname === '/fm/upload' && req.method === 'PUT') {
        const dir = await within(u.searchParams.get('dir'));
        const name = validName(u.searchParams.get('name') ?? '');
        const target = path.join(dir, name);
        if (u.searchParams.get('overwrite') !== '1' && await exists(target)) {
          res.writeHead(409, { 'Content-Type': 'text/plain' }).end('Already exists');
          return true;
        }
        const tmp = path.join(dir, `.${name}.${process.pid}.upload`);
        try {
          await pipeline(req, fs.createWriteStream(tmp));
          await fsp.rename(tmp, target);
        } catch (e) {
          await fsp.rm(tmp, { force: true });
          throw e;
        }
        res.writeHead(204).end();
      } else {
        res.writeHead(404).end();
      }
    } catch (e) {
      if (res.headersSent) res.destroy(e);
      else res.writeHead(e.code === 'ENOENT' ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(e.message);
    }
    return true;
  }

  return { commands, http };
}
