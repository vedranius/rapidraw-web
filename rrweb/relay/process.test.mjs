// node --test rrweb/relay/process.test.mjs   (headless jobs of the MCP server, the RapidRAW bridge is faked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcp, loadMcpData } from './mcp.mjs';
import { createJobs, Busy } from './jobs.mjs';
import { chooseDenoise, judge, fixFor, clampTone, concertLimits, NOISE } from './process.mjs';

const data = loadMcpData();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-process-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---- a fake RapidRAW: sidecars in memory, noise per photo, exports announced by events --------------------------
const sidecars = new Map([['/photos/clean.raf', { exposure: 0.2 }], ['/photos/mid.raf', {}], ['/photos/heavy.raf', {}]]);
const NOISE_OF = { 'clean.raf': 0.8, 'mid.raf': 2.0, 'heavy.raf': 4.5 };
const calls = [];
let lastPreview = null;
let exportsOf = {};
let mcp;
const bridge = async (cmd, args) => {
  calls.push(cmd);
  switch (cmd) {
    case 'load_metadata': return { adjustments: structuredClone(sidecars.get(args.path) ?? {}) };
    case 'save_metadata_and_update_thumbnail': sidecars.set(args.path, structuredClone(args.adjustments)); return null;
    case 'read_exif_for_paths': return Object.fromEntries(args.paths.map((p) => [p, { PhotographicSensitivity: '12800' }]));
    case 'get_ai_jobs_status': return { paused: false };
    case 'rrweb_resolve_ai': return args.paths.map((p) => ({ path: p, ok: true }));
    case 'generate_preview_for_path': lastPreview = path.basename(args.path); return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    case 'rrweb_measure_images': return args.paths.map((f) => {
      if (f.startsWith('/out/')) {
        const name = path.basename(f, '.jpg');
        const n = exportsOf[name] = (exportsOf[name] ?? 0) + 1;
        // the first export of "mid" comes out white: the check must find it and the fix export it again
        if (name === 'mid' && n === 1) return { median: 0.93, whiteClip: 0.7, blackClip: 0, centerBlack: 0, noise: 0.5, gridScore: 1, gridPeriod: 0 };
        return { median: 0.35, whiteClip: 0.01, blackClip: 0.01, centerBlack: 0, noise: 0.4, gridScore: 1.5, gridPeriod: 0 };
      }
      return { median: 0.3, whiteClip: 0, blackClip: 0, centerBlack: 0, noise: NOISE_OF[lastPreview], gridScore: 0, gridPeriod: 0 };
    });
    case 'export_images':
      setImmediate(() => {
        for (const p of args.paths) mcp.onEvent('batch-export-progress', { path: p, output: `/out/${path.parse(p).name}.jpg` });
        mcp.onEvent('export-complete', {});
      });
      return null;
    case 'list_images_in_dir': return [...sidecars.keys()].map((p) => ({ path: p, rating: 0, flag: p.includes('heavy') ? null : 'pick', tags: [] }));
    default: return null;
  }
};
mcp = createMcp({ bridge, within: async (p) => { if (!p.startsWith('/photos') && !p.startsWith('/out')) throw new Error('outside'); return p; },
  library: () => '/photos', config: {}, dataDir: dir, data, log: { log() {}, warn() {} } });
const call = async (name, args = {}) => mcp.dispatch({ method: 'tools/call', params: { name, arguments: args } });
const json = (r) => JSON.parse(r.content[0].text);
async function finished(jobId) {
  for (let i = 0; i < 20; i++) {
    const v = json(await call('rapidraw_job', { jobId, action: 'wait', seconds: 5 }));
    if (!['running', 'queued'].includes(v.state)) return v;
  }
  throw new Error('job did not finish');
}

test('choosing the denoise: clean frames none, moderate BM3D, heavy AI in mixed; each mode as asked', () => {
  assert.equal(chooseDenoise('mixed', 0.8).method, 'none');
  assert.equal(chooseDenoise('mixed', 2).method, 'bm3d');
  assert.equal(chooseDenoise('mixed', 4.5).method, 'ai');
  assert.equal(chooseDenoise('bm3d', 4.5).method, 'bm3d');
  assert.equal(chooseDenoise('ai', 2).method, 'ai');
  assert.equal(chooseDenoise('ai', 0.5).method, 'none', 'AI is never spent on a clean frame');
  assert.equal(chooseDenoise('none', 4.5).method, 'none');
  assert.ok(chooseDenoise('ai', 9).amount <= 70, 'strong AI amounts left a tile grid');
  assert.equal(chooseDenoise('mixed', undefined, 12800).method, 'ai', 'without a measure the ISO decides');
  assert.equal(chooseDenoise('mixed', 2, 0, { high: 1.5 }).method, 'ai', 'thresholds are adjustable');
  assert.equal(chooseDenoise('keep', 3), null);
});

test('the automatic check finds white, black, a tile grid and a denoise without effect', () => {
  const ok = { median: 0.35, whiteClip: 0, blackClip: 0, centerBlack: 0, noise: 0.5, gridScore: 1, gridPeriod: 0 };
  assert.deepEqual(judge(ok, { denoise: 'ai', before: { noise: 3 } }), []);
  assert.deepEqual(judge({ ...ok, median: 0.95, whiteClip: 0.8 }).map((x) => x.kind), ['white']);
  assert.deepEqual(judge({ ...ok, median: 0.01, blackClip: 0.9 }).map((x) => x.kind), ['black']);
  assert.deepEqual(judge({ ...ok, centerBlack: 0.5 }).map((x) => x.kind), ['crushedSubject']);
  assert.deepEqual(judge({ ...ok, gridScore: 9, gridPeriod: 416 }, { denoise: 'ai' }).map((x) => x.kind), ['grid']);
  assert.deepEqual(judge({ ...ok, gridScore: 9 }, { denoise: 'none' }), [], 'an LED wall is no denoise grid');
  assert.deepEqual(judge({ ...ok, noise: 2.9 }, { denoise: 'ai', before: { noise: 3 } }).map((x) => x.kind), ['denoiseNoEffect']);
  // fixes
  assert.ok(fixFor({ kind: 'white' }, { exposure: 0, brightness: 12 }, { median: 0.95 }).exposure < 0);
  assert.equal(fixFor({ kind: 'white' }, { exposure: 0, brightness: 12 }, { median: 0.95 }).brightness, 0);
  assert.equal(fixFor({ kind: 'grid' }, { aiDenoiseEnabled: true, aiDenoiseMethod: 'ai' }).aiDenoiseMethod, 'bm3d');
  assert.equal(fixFor({ kind: 'denoiseNoEffect' }, { aiDenoiseEnabled: true, aiDenoiseMethod: 'bm3d' }).aiDenoiseEnabled, false);
  assert.deepEqual(clampTone({ clarity: 30, contrast: 95, blacks: -18 }, concertLimits(12800)), { clarity: 10, contrast: 30, blacks: -10 });
  assert.ok(NOISE.low < NOISE.high);
});

test('out-of-range values are refused before anything is saved (brightness +12 made white photos)', async () => {
  const before = structuredClone(sidecars.get('/photos/mid.raf'));
  const r = await call('rapidraw_apply_adjustments', { paths: ['/photos/mid.raf'], adjustments: { brightness: 12 } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /brightness/);
  assert.deepEqual(sidecars.get('/photos/mid.raf'), before);
  const ok = await call('rapidraw_apply_adjustments', { paths: ['/photos/mid.raf'], adjustments: { brightness: 0.5 } });
  assert.ok(!ok.isError, ok.content[0].text);
  assert.equal(sidecars.get('/photos/mid.raf').brightness, 0.5);
  sidecars.set('/photos/mid.raf', before);
});

test('process asks for a speed and needs allowRisky to export', async () => {
  const r = await call('rapidraw_process', { paths: ['/photos/mid.raf'] });
  assert.ok(r.isError);
  for (const m of ['none', 'bm3d', 'mixed', 'ai']) assert.match(r.content[0].text, new RegExp(`"${m}"`));
  const e = await call('rapidraw_process', { paths: ['/photos/mid.raf'], mode: 'mixed', export: { folder: '/out' } });
  assert.ok(e.isError);
  assert.match(e.content[0].text, /allowRisky/);
});

test('list_images pages and filters', async () => {
  const all = json(await call('rapidraw_list_images', { limit: 2 }));
  assert.equal(all.total, 3);
  assert.equal(all.images.length, 2);
  assert.equal(all.nextOffset, 2);
  const picks = json(await call('rapidraw_list_images', { flag: 'pick', pathsOnly: true }));
  assert.deepEqual(picks.paths, ['/photos/clean.raf', '/photos/mid.raf']);
});

test('analyze measures noise and estimates the four speeds', async () => {
  const r = json(await call('rapidraw_analyze', { folder: '/photos' }));
  assert.ok(r.jobId);
  const v = await finished(r.jobId);
  assert.equal(v.state, 'done');
  assert.deepEqual(Object.keys(v.summary.modes), ['none', 'bm3d', 'mixed', 'ai']);
  assert.deepEqual(v.summary.modes.mixed.denoise, { none: 1, bm3d: 1, ai: 1 });
  assert.ok(v.summary.modes.ai.seconds > v.summary.modes.mixed.seconds);
  assert.ok(v.summary.modes.mixed.seconds > v.summary.modes.none.seconds);
});

test('process: masks, denoise by noise, export, check, one fix, then undo restores the edits', async () => {
  exportsOf = {};
  const original = structuredClone(Object.fromEntries(sidecars));
  const r = json(await call('rapidraw_process', { folder: '/photos', mode: 'mixed', allowRisky: true, export: { folder: '/out', longEdge: 2048 },
    aiMasks: [{ type: 'face', name: 'Face lift', patch: { exposure: 0.3 } }] }));
  const v = await finished(r.jobId);
  assert.equal(v.state, 'done', JSON.stringify(v));
  assert.deepEqual(v.summary.denoise, { none: 1, bm3d: 1, ai: 1, keep: 0 });
  assert.equal(v.summary.exported, 3);
  assert.equal(v.summary.fixes.length, 1);
  assert.equal(v.summary.fixes[0].path, '/photos/mid.raf');
  assert.deepEqual(v.summary.problems, []);
  const heavy = sidecars.get('/photos/heavy.raf');
  assert.equal(heavy.aiDenoiseMethod, 'ai');
  assert.equal(heavy.masks.filter((m) => m.name === 'Face lift').length, 1);
  assert.equal(sidecars.get('/photos/clean.raf').aiDenoiseEnabled, false);
  assert.ok(sidecars.get('/photos/mid.raf').exposure < 0, 'the white export was fixed by lowering exposure');
  assert.ok(calls.includes('pause_ai_jobs') && calls.includes('resume_ai_jobs'), 'background AI work waits during the job');

  // run again: the mask is replaced, not added twice
  const again = await finished(json(await call('rapidraw_ai_mask', { paths: ['/photos/heavy.raf'], type: 'face', name: 'Face lift', patch: { exposure: 0.4 } })).jobId);
  assert.equal(again.state, 'done');
  assert.equal(sidecars.get('/photos/heavy.raf').masks.filter((m) => m.name === 'Face lift').length, 1);

  const u = json(await call('rapidraw_job', { jobId: r.jobId, action: 'undo' }));
  assert.equal(u.restored, 3);
  assert.deepEqual(Object.fromEntries(sidecars), original);
});

test('jobs: one at a time, a full queue answers busy, a restart marks running jobs interrupted', async () => {
  const file = path.join(dir, 'jobs.json');
  const jobs = createJobs({ file, log: { warn() {} } });
  let release;
  const gate = new Promise((r) => { release = r; });
  const order = [];
  const first = jobs.submit({ kind: 't', title: 'first', spec: { paths: [] }, runner: async () => { order.push('first'); await gate; } });
  await new Promise((r) => setImmediate(r));
  const queued = [];
  for (let i = 0; i < 6; i++) queued.push(jobs.submit({ kind: 't', title: `q${i}`, runner: async () => { order.push(`q${i}`); } }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jobs.view(first).state, 'running');
  assert.equal(jobs.view(queued[0]).state, 'queued');
  assert.throws(() => jobs.submit({ kind: 't', title: 'too many', runner: async () => {} }), (e) => e instanceof Busy && e.retryAfter >= 30);
  await new Promise((r) => setTimeout(r, 400)); // the journal is written
  const after = createJobs({ file, log: { warn() {} } });
  assert.equal(after.get(first.id).state, 'interrupted');
  assert.equal(after.view(after.get(first.id)).resumable, true);
  release();
  await jobs.wait(queued[5].id, 2000);
  assert.deepEqual(order, ['first', 'q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
  assert.equal(jobs.cancel(queued[0].id).state, 'done');
});

test('ai_review explains how to configure a cheap vision model when none is set', async () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, g: process.env.GEMINI_API_KEY, ra: process.env.RR_ANTHROPIC_API_KEY, rg: process.env.RR_GEMINI_API_KEY };
  for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'RR_ANTHROPIC_API_KEY', 'RR_GEMINI_API_KEY']) delete process.env[k];
  const r = await call('rapidraw_ai_review', { paths: ['/photos/mid.raf'] });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /ANTHROPIC_API_KEY|GEMINI_API_KEY/);
  const st = json(await call('rapidraw_status'));
  assert.equal(st.models.cull, 'claude-haiku-5-5');
  assert.equal(st.models.plan, 'claude-sonnet-5-5');
  assert.match(String(st.vision), /not configured/);
  if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
  if (saved.g) process.env.GEMINI_API_KEY = saved.g;
  if (saved.ra) process.env.RR_ANTHROPIC_API_KEY = saved.ra;
  if (saved.rg) process.env.RR_GEMINI_API_KEY = saved.rg;
});
