// node --test rrweb/relay/   (MCP server, no RapidRAW needed: the bridge is faked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcp, deepMerge, diffFromDefaults, parseGithub, parseSkill, TOOLS, loadMcpData } from './mcp.mjs';

const data = loadMcpData();
const calls = [];
const bridge = async (cmd, args) => {
  calls.push([cmd, args]);
  if (cmd === 'load_metadata') return { rating: 3, tags: ['band'], adjustments: { exposure: 0.5, hsl: { reds: { saturation: 10 } } } };
  if (cmd === 'generate_preview_for_path') return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  if (cmd === 'list_images_in_dir') return [{ path: '/photos/a.raf', rating: 2, is_raw: true, is_edited: false, tags: [] }];
  if (cmd === 'cull_images') {
    const sc = (p, aiScore, sharpnessMetric = 300) => ({ path: p, aiScore, sharpnessMetric, exposureMetric: 0.5, highlightClip: 0, shadowClip: 0, tags: ['stage'] });
    return { similarGroups: [{ representative: sc('/photos/b1', 0.9), duplicates: [sc('/photos/b2', 0.8)] }], blurryImages: [sc('/photos/soft', 0.95, 10)], failedPaths: [],
      scores: [sc('/photos/b1', 0.9), sc('/photos/b2', 0.8), sc('/photos/soft', 0.95, 10), sc('/photos/c', 0.7), sc('/photos/d', 0.6)] };
  }
  if (cmd === 'read_exif_for_paths') return { '/photos/b1': { PhotographicSensitivity: '6400' } };
  return null;
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-mcp-test-'));
const mcp = createMcp({ bridge, within: async (p) => { if (!p.startsWith('/photos')) throw new Error('outside'); return p; },
  library: () => '/photos', config: {}, dataDir: dir, data, log: { log() {} } });

const server = http.createServer((req, res) => mcp.http(req, res, new URL(req.url, 'http://x'),
  { isLoopback: () => true, sameOrigin: (r) => r.headers.origin === 'http://ok' }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mcp`;
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let id = 0;
async function rpc(method, params, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  return { status: r.status, session: r.headers.get('mcp-session-id'), body: r.status === 200 ? await r.json() : null };
}
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).body.result;

test('initialize negotiates the protocol and opens a session', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.status, 200);
  assert.ok(r.session);
  assert.equal(r.body.result.protocolVersion, '2025-03-26');
  assert.equal(r.body.result.serverInfo.name, 'rapidraw-web');
  const n = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(n.status, 202);
});

test('a web page (foreign Origin) is refused, the token lets remote clients in', async () => {
  assert.equal((await rpc('ping', {}, { origin: 'http://evil' })).status, 401);
  assert.equal((await rpc('ping', {}, { origin: 'http://evil', authorization: `Bearer ${mcp.token}` })).status, 401);
  assert.equal((await rpc('ping', {}, { origin: 'http://ok' })).status, 401, 'browsers always need the token');
  assert.equal((await rpc('ping', {}, { origin: 'http://ok', authorization: `Bearer ${mcp.token}` })).status, 200);
  assert.equal((await rpc('ping', {})).status, 200, 'local clients without Origin need no token');
  assert.equal((await rpc('ping', {}, { 'x-forwarded-for': '1.2.3.4' })).status, 401, 'through a proxy on this computer');
  assert.equal((await rpc('ping', {}, { 'x-forwarded-for': '1.2.3.4', authorization: `Bearer ${mcp.token}` })).status, 200);
});

test('tools/list has schemas for every tool', async () => {
  const { tools } = (await rpc('tools/list')).body.result;
  assert.equal(tools.length, TOOLS.length);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
});

test('get_edit returns only what differs from the defaults', async () => {
  const r = await call('rapidraw_get_edit', { path: '/photos/a.raf' });
  const out = JSON.parse(r.content[0].text);
  assert.deepEqual(out.adjustments, { exposure: 0.5, hsl: { reds: { saturation: 10 } } });
});

test('paths outside the photo folders are refused', async () => {
  const r = await call('rapidraw_get_edit', { path: '/etc/passwd' });
  assert.equal(r.isError, true);
});

test('preview returns a JPEG and passes the merged patch and maxEdge', async () => {
  calls.length = 0;
  const r = await call('rapidraw_preview', { path: '/photos/a.raf', maxEdge: 800, adjustments: { contrast: 20 } });
  assert.equal(r.content[0].type, 'image');
  assert.equal(r.content[0].mimeType, 'image/jpeg');
  const [, args] = calls.find(([c]) => c === 'generate_preview_for_path');
  assert.equal(args.maxEdge, 800);
  assert.equal(args.jsAdjustments.contrast, 20);
  assert.equal(args.jsAdjustments.exposure, 0.5);
  assert.equal(args.jsAdjustments.hsl.reds.saturation, 10);
});

test('unknown adjustment keys are rejected', async () => {
  const r = await call('rapidraw_apply_adjustments', { paths: ['/photos/a.raf'], adjustments: { texture: 10 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /texture/);
});

test('apply_adjustments saves headless when no tab is open', async () => {
  calls.length = 0;
  const r = await call('rapidraw_apply_adjustments', { paths: ['/photos/a.raf'], adjustments: { contrast: 15 } });
  assert.ok(!r.isError, r.content[0].text);
  const [, args] = calls.find(([c]) => c === 'save_metadata_and_update_thumbnail');
  assert.equal(args.adjustments.contrast, 15);
  assert.equal(args.adjustments.exposure, 0.5);
});

test('run needs an open tab, validates commands and risky steps', async () => {
  assert.match((await call('rapidraw_run', { steps: [{ tool: 'photo.auto-tone' }] })).content[0].text, /No RapidRAW Web tab/);
  assert.match((await call('rapidraw_run', { steps: [{ tool: 'photo.nope' }] })).content[0].text, /Unknown commands/);
  assert.match((await call('rapidraw_run', { steps: [{ tool: 'library.export', params: {} }] })).content[0].text, /allowRisky/);
});

test('run is executed by the RapidRAW Web tab and its result returned', async () => {
  const sent = [];
  const ws = { readyState: 1, send: (s) => {
    const { payload } = JSON.parse(s);
    sent.push(payload);
    setImmediate(() => mcp.commands.__rr_mcp_result({ rid: payload.rid, result: { runId: payload.rid, results: [{ tool: 'photo.auto-tone', ok: true, message: 'done' }] } }));
  } };
  mcp.commands.__rr_mcp_hello({ state: { openPhoto: '/photos/a.raf' } }, ws);
  const other = { readyState: 1, send() {} };
  assert.equal(mcp.commands.__rr_mcp_hello({ passive: true }, other).host, false, 'a background tab does not take over');
  const r = await call('rapidraw_run', { steps: [{ tool: 'photo.auto-tone' }], paths: ['/photos/a.raf'] });
  assert.ok(!r.isError);
  assert.equal(sent[0].op, 'run');
  assert.deepEqual(sent[0].paths, ['/photos/a.raf']);
  assert.equal(JSON.parse(r.content[0].text).results[0].ok, true);
  const s = JSON.parse((await call('rapidraw_status')).content[0].text);
  assert.equal(s.editorTab, 'open');
  assert.equal(s.openPhoto, '/photos/a.raf');
  mcp.dropClient(ws);
  assert.equal(JSON.parse((await call('rapidraw_status')).content[0].text).editorTab, 'none');
});

test('skills are listed as tools output and MCP prompts', async () => {
  const list = (await call('rapidraw_skills')).content[0].text;
  assert.match(list, /concert-hero/);
  const { prompts } = (await rpc('prompts/list')).body.result;
  assert.ok(prompts.length >= 10);
  const p = (await rpc('prompts/get', { name: 'concert-hero', arguments: { request: 'warmer' } })).body.result;
  assert.match(p.messages[0].content.text, /warmer/);
  assert.match(p.messages[0].content.text, /rapidraw_run/);
});

test('installed skills override built-in ones and can be removed', async () => {
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'concert-hero.md'), '---\nname: concert-hero\ndescription: Updated\nmetadata:\n  title: "Concert Hero"\n---\nbody');
  assert.match((await call('rapidraw_skills')).content[0].text, /concert-hero: Concert Hero - Updated \(installed\)/);
  assert.equal(mcp.commands.__rr_skills_list().length, 1);
  await mcp.commands.__rr_skills_remove({ id: 'concert-hero' });
  assert.equal(mcp.commands.__rr_skills_list().length, 0);
});

test('rank keeps the best of a burst, drops soft frames, adds ISO', async () => {
  calls.length = 0;
  const r = await call('rapidraw_rank', { paths: ['/photos/b1', '/photos/b2', '/photos/soft', '/photos/c', '/photos/d'], top: 2 });
  assert.ok(!r.isError, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.deepEqual(out.best.map((x) => x.path), ['/photos/b1', '/photos/c']);
  assert.equal(out.best[0].iso, 6400);
  assert.equal(out.droppedDuplicates, 1);
  assert.equal(out.droppedSoft, 1);
  assert.equal(calls.find(([c]) => c === 'cull_images')[1].settings.includeScores, true);
  const all = JSON.parse((await call('rapidraw_rank', { paths: ['/photos/b1'], top: 10, keepDuplicates: true, keepSoft: true })).content[0].text);
  assert.equal(all.best.length, 5);
});

test('set_library flags headless, or through the open tab', async () => {
  calls.length = 0;
  let r = await call('rapidraw_set_library', { paths: ['/photos/b1', '/photos/c'], flag: 'pick', rating: 4, addTags: ['concert'] });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(calls.find(([c]) => c === 'set_flag_for_paths')[1], { paths: ['/photos/b1', '/photos/c'], flag: 'pick' });
  assert.equal(calls.find(([c]) => c === 'set_rating_for_paths')[1].rating, 4);
  assert.equal(calls.find(([c]) => c === 'add_tag_for_paths')[1].tag, 'concert');
  const sent = [];
  const ws = { readyState: 1, send: (s) => { const { payload } = JSON.parse(s); sent.push(payload); setImmediate(() => mcp.commands.__rr_mcp_result({ rid: payload.rid, result: { ok: true } })); } };
  mcp.commands.__rr_mcp_hello({ state: {} }, ws);
  r = await call('rapidraw_set_library', { paths: ['/photos/b1'], flag: 'none' });
  assert.ok(!r.isError);
  assert.deepEqual(sent[0].steps, [{ tool: 'library.flag', params: { paths: ['/photos/b1'], flag: null } }]);
  mcp.dropClient(ws);
});

test('helpers', () => {
  assert.deepEqual(parseGithub('vedranius/rapidraw-web'), { owner: 'vedranius', repo: 'rapidraw-web', ref: 'HEAD', sub: '' });
  assert.deepEqual(parseGithub('https://github.com/a/b/tree/main/plugins/x/skills'), { owner: 'a', repo: 'b', ref: 'main', sub: 'plugins/x/skills' });
  assert.equal(parseGithub('https://gitlab.com/a/b'), null);
  const s = parseSkill('---\nname: hdr\ndescription: d\nmetadata:\n  title: "HDR Bracket"\n  rapidraw-commands: "photo.hdr, settings.patch"\n---\nx');
  assert.equal(s.name, 'HDR Bracket');
  assert.deepEqual(s.commands, ['photo.hdr', 'settings.patch']);
  assert.equal(parseSkill('no frontmatter'), null);
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { b: 3 }, l: [2] }), { a: { b: 3, c: 2 }, l: [2] });
  assert.deepEqual(diffFromDefaults({ a: 1, b: { c: 0 } }, { a: 1, b: { c: 0 } }), {});
});

test('the generated data is complete', () => {
  assert.ok(data.catalog.length >= 37);
  assert.ok(data.reference.includes('exposure'));
  assert.ok('exposure' in data.defaults);
  assert.ok(data.agentSkills['rapidraw-editor']);
});
