// RapidRAW Web MCP server: lets AI clients (Claude Code, Claude Desktop, Cursor, VS Code, Codex, ...) edit photos.
//
// Transport: MCP "Streamable HTTP" at /mcp on the relay's port (JSON responses, no SSE stream needed).
//   http://<server>:8780/mcp   Authorization: Bearer <token>   (or ?token=<token>)
// Programs on the same computer (loopback, no browser Origin, no proxy headers) don't need the token
// (RR_MCP_REQUIRE_TOKEN=1: always). The token is RR_MCP_TOKEN or one
// generated on first start and kept in RR_CONFIG (mcpToken); the AI tab of the AI Editor shows it. RR_MCP=0 turns
// the server off.
//
// Two kinds of tools:
//  - headless ones that call the RapidRAW bridge directly (status, list, read an edit, preview, patch adjustments):
//    they work without any browser open;
//  - rapidraw_run / rapidraw_undo, which hand a plan of AI Editor commands (src/agent/catalog.ts, all 37+) to an open
//    RapidRAW Web tab (src/agent/McpHost.tsx). That tab executes them exactly like the AI Editor does: snapshot of
//    the sidecars first, every step checked, results visible in the UI, undo restores the snapshot.
//
// Skills: built-in recipes (src/agent/skills/*.md, bundled through mcp-data.json) plus skills installed from git or
// a URL into <config folder>/skills. They are served as MCP prompts and through rapidraw_skills; the in-app AI
// Editor shows the installed ones too.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_SKILLS_SOURCE = 'https://github.com/vedranius/rapidraw-web/tree/main/plugins/rapidraw/skills';
const RUN_TIMEOUT = 15 * 60 * 1000;
const MAX_BODY = 4 << 20;
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via',
  'cf-connecting-ip', 'tailscale-user-login', 'x-original-forwarded-for'];

export function loadMcpData(file = path.join(here, 'mcp-data.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { catalog: [], reference: '', defaults: {}, skills: [] }; }
}

// --- skills -------------------------------------------------------------------------------------------------------

export function slug(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

// Frontmatter of both formats: the AI Editor's (name, description, triggers, allowed-tools) and Agent Skills
// SKILL.md (name, description, metadata: {title, triggers, rapidraw-commands}). Nested keys are flattened.
export function parseSkill(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '').trim();
  const fm = {};
  let body = text;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end >= 0) {
      for (const line of text.slice(3, end).split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
        if (m && m[2] !== '') fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
      body = text.slice(end + 4).trim();
    }
  }
  if (!fm.name || !fm.description) return null;
  const list = (v) => (v ? v.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []);
  return {
    id: slug(fm.name),
    name: fm.title || fm.name,
    description: fm.description,
    triggers: list(fm.triggers),
    commands: list(fm['rapidraw-commands'] || fm['allowed-tools']),
    mcpOnly: fm['mcp-only'] === 'true',
    content: body,
    raw: text,
  };
}

function skillsStore(dir) {
  const read = () => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return []; }
    return names.map((n) => {
      try { return parseSkill(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; }
    }).filter(Boolean);
  };
  const sourcesFile = path.join(dir, 'sources.json');
  const sources = () => { try { return JSON.parse(fs.readFileSync(sourcesFile, 'utf8')); } catch { return {}; } };
  return {
    dir,
    list: read,
    sources,
    async save(skills, source) {
      await fsp.mkdir(dir, { recursive: true });
      const src = sources();
      for (const s of skills) {
        await fsp.writeFile(path.join(dir, `${s.id}.md`), s.raw + '\n');
        src[s.id] = source;
      }
      await fsp.writeFile(sourcesFile, JSON.stringify(src, null, 2));
    },
    async remove(id) {
      const safe = slug(id);
      await fsp.rm(path.join(dir, `${safe}.md`), { force: true });
      const src = sources();
      delete src[safe];
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(sourcesFile, JSON.stringify(src, null, 2));
    },
  };
}

// "owner/repo", "github:owner/repo", https://github.com/owner/repo[.git][/tree/<ref>/<path>]
export function parseGithub(source) {
  const s = String(source).trim();
  let m = s.match(/^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?$/);
  if (m && !s.includes('://')) return { owner: m[1], repo: m[2], ref: m[3] || 'HEAD', sub: '' };
  m = s.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/);
  if (m) return { owner: m[1], repo: m[2], ref: m[3] || 'HEAD', sub: (m[4] || '').replace(/\/$/, '') };
  return null;
}

const isSkillPath = (p) => /(^|\/)SKILL\.md$/i.test(p) || (/(^|\/)skills\/[^/]+\.md$/i.test(p) && !/README\.md$/i.test(p));

async function fetchText(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'rapidraw-web', ...headers }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const t = await r.text();
  if (t.length > 512 << 10) throw new Error(`${url}: larger than 512 KB`);
  return t;
}

// Every skill (SKILL.md, or *.md with frontmatter in a skills/ folder) of a git repository or a single .md URL
export async function collectSkills(source, { git = 'git' } = {}) {
  const s = String(source ?? '').trim() || DEFAULT_SKILLS_SOURCE;
  const found = [];
  const add = (raw) => { const k = parseSkill(raw); if (k && k.id) found.push(k); };
  const gh = parseGithub(s);
  if (/^https:\/\/\S+\.md(\?.*)?$/i.test(s) && !gh?.sub?.endsWith('.md')) {
    add(await fetchText(s));
  } else if (gh) {
    const auth = process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
    const tree = JSON.parse(await fetchText(`https://api.github.com/repos/${gh.owner}/${gh.repo}/git/trees/${encodeURIComponent(gh.ref)}?recursive=1`, auth));
    const files = (tree.tree ?? []).filter((e) => e.type === 'blob' && (!gh.sub || e.path === gh.sub || e.path.startsWith(gh.sub + '/'))
      && (gh.sub.endsWith('.md') ? e.path === gh.sub : isSkillPath(e.path)) && !e.path.includes('node_modules/')).slice(0, 200);
    for (const f of files) add(await fetchText(`https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.ref}/${f.path.split('/').map(encodeURIComponent).join('/')}`));
  } else if (/^(https:\/\/|ssh:\/\/|git@)/.test(s)) {
    const [url, ref] = s.split('#');
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rr-skills-'));
    try {
      await new Promise((resolve, reject) => execFile(git, ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, tmp],
        { timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' } },
        (e) => (e ? reject(new Error(e.code === 'ENOENT' ? 'git is not installed on the server (GitHub repositories work without it)' : `git clone failed: ${e.message.split('\n')[0]}`)) : resolve())));
      const walk = async (dir, rel = '') => {
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          if (e.name === '.git' || e.name === 'node_modules' || found.length >= 200) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(dir, e.name), r);
          else if (isSkillPath(r)) add(await fsp.readFile(path.join(dir, e.name), 'utf8'));
        }
      };
      await walk(tmp);
    } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
  } else {
    throw new Error('Use a GitHub repository (owner/repo or https://github.com/...), an https/ssh git URL, or an https URL of a .md file.');
  }
  if (!found.length) throw new Error(`No skills found in ${s} (looked for SKILL.md files and .md files in skills/ folders with name and description).`);
  return found;
}

// --- adjustments --------------------------------------------------------------------------------------------------

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(base, patch) {
  const out = { ...(plain(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch ?? {})) out[k] = plain(v) && plain(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}
// Only what differs from RapidRAW's defaults: an edit as an AI reads it, in a few hundred tokens instead of thousands
export function diffFromDefaults(adj, defaults) {
  const out = {};
  for (const [k, v] of Object.entries(adj ?? {})) {
    const d = defaults?.[k];
    if (plain(v) && plain(d)) { const sub = diffFromDefaults(v, d); if (Object.keys(sub).length) out[k] = sub; }
    else if (JSON.stringify(v) !== JSON.stringify(d)) out[k] = v;
  }
  return out;
}

// --- server -------------------------------------------------------------------------------------------------------

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });

export const TOOLS = [
  { name: 'rapidraw_status', title: 'RapidRAW status',
    description: 'Is RapidRAW running, which photo library, is a RapidRAW Web tab open (needed by rapidraw_run), which photo is open and selected. Call this first.',
    inputSchema: obj({}), annotations: { readOnlyHint: true } },
  { name: 'rapidraw_list_images', title: 'List photos',
    description: 'Photos in a folder on the RapidRAW server (default: the photo library), with rating, flag, tags, RAW and edited state.',
    inputSchema: obj({ folder: str('Absolute folder path; default the photo library'), recursive: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 } }),
    annotations: { readOnlyHint: true } },
  { name: 'rapidraw_get_edit', title: 'Read a photo\'s edit',
    description: 'Current RapidRAW edit of one photo: rating, tags and only the adjustments that differ from defaults (masks summarised).',
    inputSchema: obj({ path: str('Absolute photo path') }, ['path']), annotations: { readOnlyHint: true } },
  { name: 'rapidraw_preview', title: 'Render a preview',
    description: 'Renders the photo with RapidRAW on the server GPU and returns a JPEG to look at. Pass "adjustments" to preview a patch without saving it.',
    inputSchema: obj({ path: str('Absolute photo path'), maxEdge: { type: 'integer', minimum: 256, maximum: 4096, default: 1280 }, adjustments: { type: 'object', description: 'Optional patch merged over the current edit, not saved' } }, ['path']),
    annotations: { readOnlyHint: true } },
  { name: 'rapidraw_apply_adjustments', title: 'Apply adjustments',
    description: 'Deep-merges an adjustments patch (any slider, curves, hsl, colorGrading, masks, ...; see rapidraw_commands reference) into the edits of the given photos and saves them. Non-destructive (sidecars).',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, minItems: 1 }, adjustments: { type: 'object' } }, ['paths', 'adjustments']),
    annotations: { destructiveHint: false, idempotentHint: true } },
  { name: 'rapidraw_commands', title: 'RapidRAW command catalog',
    description: 'The AI Editor commands rapidraw_run accepts (id, parameters, risk), and with reference=true every adjustment key and its range.',
    inputSchema: obj({ category: str('inspect|tone|colour|detail|geometry|mask|ai|operations|library|app'), id: str('One command id for full detail'), reference: { type: 'boolean' } }),
    annotations: { readOnlyHint: true } },
  { name: 'rapidraw_run', title: 'Run RapidRAW commands',
    description: 'Runs a plan of AI Editor commands in the open RapidRAW Web tab, in order, stopping at the first failure: masks, AI masks, denoise, HDR, panorama, focus stack, crop, lens, styles, LUTs, presets, rating/tags, culling, export and more. Sidecars are snapshotted first; rapidraw_undo with the returned runId restores them. Steps marked risky (export, reset, app settings) need allowRisky=true.',
    inputSchema: obj({
      steps: { type: 'array', minItems: 1, maxItems: 50, items: obj({ tool: str('Command id, e.g. photo.ai-mask'), params: { type: 'object' }, note: { type: 'string' } }, ['tool']) },
      paths: { type: 'array', items: { type: 'string' }, description: 'Target photos; default the selection in the RapidRAW tab' },
      allowRisky: { type: 'boolean', default: false },
    }, ['steps']),
    annotations: { destructiveHint: true } },
  { name: 'rapidraw_undo', title: 'Undo a run',
    description: 'Restores the edits of the photos touched by a rapidraw_run (files it created, like HDR or exports, stay on disk).',
    inputSchema: obj({ runId: str('runId from rapidraw_run') }, ['runId']) },
  { name: 'rapidraw_skills', title: 'Editing skills',
    description: 'Lists RapidRAW editing skills (recipes such as concert, portrait, HDR, high ISO), or returns one skill\'s full instructions with id.',
    inputSchema: obj({ id: str('Skill id for the full text') }), annotations: { readOnlyHint: true } },
  { name: 'rapidraw_install_skills', title: 'Install skills',
    description: `Installs every skill from a git repository or a .md URL on the RapidRAW server (default ${DEFAULT_SKILLS_SOURCE}); also updates skills already installed from there.`,
    inputSchema: obj({ source: str('owner/repo, https://github.com/..., a git URL or a .md URL') }) },
];

export function createMcp({ bridge, within, library, version, configFile, config = {}, saveConfig = () => {}, dataDir, data = loadMcpData(), log = console }) {
  const enabled = process.env.RR_MCP !== '0';
  version ??= data.version ?? '0';
  let token = process.env.RR_MCP_TOKEN || config.mcpToken;
  if (!token) { token = randomBytes(24).toString('base64url'); config.mcpToken = token; try { saveConfig(); } catch { /* read-only config */ } }
  const store = skillsStore(path.join(dataDir ?? (configFile ? path.dirname(configFile) : path.join(os.homedir(), '.rapidraw-web')), 'skills'));
  const catalog = new Map((data.catalog ?? []).map((t) => [t.id, t]));
  const builtIn = (data.skills ?? []).map(parseSkill).filter(Boolean);
  const allSkills = () => {
    const m = new Map(builtIn.map((s) => [s.id, { ...s, builtIn: true }]));
    for (const s of store.list()) m.set(s.id, { ...s, builtIn: false });
    return [...m.values()];
  };

  // The RapidRAW Web tab that runs plans: the last one that said hello and is still open
  let host = null; // { ws, state }
  const pending = new Map(); // rid -> { resolve, reject, timer }
  let seq = 0;
  function hostRequest(op, args, timeout = RUN_TIMEOUT) {
    if (!host || host.ws.readyState !== 1) throw new Error('No RapidRAW Web tab is open. Open RapidRAW Web in a browser (http://<server>:8780), then retry. Headless tools (rapidraw_preview, rapidraw_apply_adjustments, ...) work without it.');
    const rid = `${Date.now().toString(36)}-${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(rid); reject(new Error(`${op} timed out`)); }, timeout);
      pending.set(rid, { resolve, reject, timer, ws: host.ws });
      host.ws.send(JSON.stringify({ event: '__rr_mcp_request', payload: { rid, op, ...args } }));
    });
  }

  const commands = {
    // the last tab that said hello runs plans; a passive hello (tab in the background) only fills an empty place
    __rr_mcp_hello: (args, ws) => {
      if (!args?.passive || !host || host.ws === ws || host.ws.readyState !== 1) host = { ws, state: args?.state ?? {} };
      return { enabled, host: host.ws === ws };
    },
    __rr_mcp_result: ({ rid, result, error }) => {
      const p = pending.get(rid);
      if (!p) return null;
      pending.delete(rid);
      clearTimeout(p.timer);
      error ? p.reject(new Error(String(error))) : p.resolve(result);
      return null;
    },
    __rr_mcp_info: () => ({ enabled, token, path: '/mcp', defaultSource: DEFAULT_SKILLS_SOURCE, skillsDir: store.dir, tools: TOOLS.map((t) => t.name) }),
    __rr_skills_list: () => allSkills().filter((s) => !s.builtIn).map((s) => ({ id: s.id, raw: s.raw, source: store.sources()[s.id] ?? null })),
    __rr_skills_install: async ({ source }) => install(source),
    __rr_skills_remove: async ({ id }) => { await store.remove(id); return null; },
  };
  function dropClient(ws) {
    if (host?.ws === ws) host = null;
    for (const [rid, p] of pending) if (p.ws === ws) { clearTimeout(p.timer); p.reject(new Error('The RapidRAW Web tab was closed')); pending.delete(rid); }
  }

  async function install(source) {
    const src = String(source ?? '').trim() || DEFAULT_SKILLS_SOURCE;
    const skills = await collectSkills(src);
    await store.save(skills, src);
    log.log(`[mcp] installed ${skills.length} skill(s) from ${src}`);
    return { source: src, installed: skills.map((s) => s.id) };
  }

  const fullAdjustments = async (p) => {
    const meta = await bridge('load_metadata', { path: p });
    return { meta, adjustments: deepMerge(data.defaults ?? {}, meta?.adjustments ?? {}) };
  };
  const checkPath = async (p) => { if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('path must be an absolute path'); await within(p); return p; };
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
  const unknownKeys = (patch) => Object.keys(patch ?? {}).filter((k) => data.defaults && !(k in data.defaults));

  const handlers = {
    async rapidraw_status() {
      let bridgeOk = true;
      try { await bridge('load_settings', {}); } catch { bridgeOk = false; }
      return text({ version, bridge: bridgeOk ? 'connected' : 'not connected', library: library(), editorTab: host ? 'open' : 'none', ...(host?.state ?? {}),
        skills: allSkills().length, hint: host ? 'All tools available.' : 'Open RapidRAW Web in a browser to use rapidraw_run.' });
    },
    async rapidraw_list_images({ folder, recursive, limit = 200 }) {
      const dir = folder || library();
      if (!dir) throw new Error('No photo library is set; pass folder');
      await checkPath(dir);
      const list = await bridge(recursive ? 'list_images_recursive' : 'list_images_in_dir', { path: dir });
      const out = (list ?? []).slice(0, limit).map((f) => ({ path: f.path, rating: f.rating, flag: f.flag ?? undefined, tags: f.tags?.length ? f.tags : undefined, raw: f.is_raw ?? f.isRaw, edited: f.is_edited ?? f.isEdited }));
      return text({ folder: dir, total: list?.length ?? 0, images: out });
    },
    async rapidraw_get_edit({ path: p }) {
      await checkPath(p);
      const { meta, adjustments } = await fullAdjustments(p);
      const diff = diffFromDefaults(adjustments, data.defaults);
      if (Array.isArray(diff.masks)) diff.masks = diff.masks.map((m) => ({ id: m.id, name: m.name, visible: m.visible, subMasks: m.subMasks?.map((s) => s.type), adjustments: diffFromDefaults(m.adjustments, {}) }));
      return text({ path: p, rating: meta?.rating, tags: meta?.tags, adjustments: diff });
    },
    async rapidraw_preview({ path: p, maxEdge = 1280, adjustments }) {
      await checkPath(p);
      const bad = unknownKeys(adjustments);
      if (bad.length) throw new Error(`Unknown adjustment keys: ${bad.join(', ')}`);
      const cur = (await fullAdjustments(p)).adjustments;
      const jpeg = await bridge('generate_preview_for_path', { path: p, jsAdjustments: adjustments ? deepMerge(cur, adjustments) : cur, maxEdge });
      if (!Buffer.isBuffer(jpeg)) throw new Error('RapidRAW returned no image');
      return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `${path.basename(p)}${adjustments ? ' (patch previewed, not saved)' : ''}` }] };
    },
    async rapidraw_apply_adjustments({ paths, adjustments }) {
      const bad = unknownKeys(adjustments);
      if (bad.length) throw new Error(`Unknown adjustment keys: ${bad.join(', ')}. See rapidraw_commands with reference=true.`);
      for (const p of paths) await checkPath(p);
      if (host) return text(await hostRequest('run', { steps: [{ tool: 'settings.patch', params: { paths, patch: adjustments } }], paths }));
      for (const p of paths) {
        const { adjustments: cur } = await fullAdjustments(p);
        await bridge('save_metadata_and_update_thumbnail', { path: p, adjustments: deepMerge(cur, adjustments) });
      }
      return text({ ok: true, updated: paths.length, note: 'Saved headless; open RapidRAW tabs show it after reopening the photo.' });
    },
    async rapidraw_commands({ category, id, reference }) {
      if (id) { const t = catalog.get(id); if (!t) throw new Error(`Unknown command ${id}`); return text(t); }
      const lines = [...catalog.values()].filter((t) => !category || t.category === category)
        .map((t) => `${t.id}${t.destructive ? ' [risky]' : ''}: ${t.description} | params: ${t.params}`);
      return text(lines.join('\n') + (reference ? `\n\nADJUSTMENTS REFERENCE\n${data.reference}` : '\n\n(reference=true lists every adjustment key and range)'));
    },
    async rapidraw_run({ steps, paths, allowRisky }) {
      const unknown = steps.filter((s) => !catalog.has(s.tool)).map((s) => s.tool);
      if (unknown.length) throw new Error(`Unknown commands: ${unknown.join(', ')}. See rapidraw_commands.`);
      const risky = steps.filter((s) => catalog.get(s.tool)?.destructive).map((s) => s.tool);
      if (risky.length && !allowRisky) throw new Error(`Risky steps (${risky.join(', ')}) need allowRisky=true. Confirm with the user first.`);
      if (paths) for (const p of paths) await checkPath(p);
      const r = await hostRequest('run', { steps: steps.map((s) => ({ tool: s.tool, params: s.params ?? {}, note: s.note })), paths });
      return { ...text(r), isError: r?.results?.some((x) => !x.ok) || undefined };
    },
    async rapidraw_undo({ runId }) { return text(await hostRequest('undo', { runId }, 120000)); },
    async rapidraw_skills({ id }) {
      const all = allSkills();
      if (id) { const s = all.find((k) => k.id === slug(id)); if (!s) throw new Error(`Unknown skill ${id}`); return text(`# ${s.name}\n${s.description}\nCommands: ${s.commands.join(', ') || 'any'}\n\n${s.content}`); }
      return text(all.map((s) => `${s.id}: ${s.name} - ${s.description}${s.builtIn ? '' : ' (installed)'}`).join('\n'));
    },
    async rapidraw_install_skills({ source }) { return text(await install(source)); },
  };

  function prompts() {
    return allSkills().map((s) => ({ name: s.id, title: s.name, description: s.description,
      arguments: [{ name: 'request', description: 'What to do, e.g. "make it warmer and protect the highlights"', required: false }] }));
  }
  function getPrompt(name, args = {}) {
    const s = allSkills().find((k) => k.id === name);
    if (!s) throw rpcError(-32602, `Unknown prompt ${name}`);
    const msg = `Edit with RapidRAW using the "${s.name}" skill.${args.request ? `\nRequest: ${args.request}` : ''}\n\n` +
      'Workflow: rapidraw_status → rapidraw_get_edit and rapidraw_preview of the photo → rapidraw_run with the steps below (or rapidraw_apply_adjustments) → rapidraw_preview to check → adjust. ' +
      `Allowed commands: ${s.commands.join(', ') || 'any'}.\n\n${s.content}`;
    return { description: s.description, messages: [{ role: 'user', content: { type: 'text', text: msg } }] };
  }
  const resources = () => [
    { uri: 'rapidraw://reference/adjustments', name: 'Adjustment reference', mimeType: 'text/plain', description: 'Every adjustment key and range' },
    { uri: 'rapidraw://reference/commands', name: 'Command catalog', mimeType: 'application/json' },
    ...allSkills().map((s) => ({ uri: `rapidraw://skills/${s.id}`, name: s.name, mimeType: 'text/markdown', description: s.description })),
  ];
  function readResource(uri) {
    if (uri === 'rapidraw://reference/adjustments') return data.reference;
    if (uri === 'rapidraw://reference/commands') return JSON.stringify([...catalog.values()]);
    const s = allSkills().find((k) => `rapidraw://skills/${k.id}` === uri);
    if (s) return s.raw;
    throw rpcError(-32002, `Unknown resource ${uri}`);
  }

  const INSTRUCTIONS = 'RapidRAW Web: a GPU RAW photo editor. Start with rapidraw_status and rapidraw_list_images. Read edits with rapidraw_get_edit, look with rapidraw_preview, ' +
    'change sliders with rapidraw_apply_adjustments, and use rapidraw_run for everything else (AI masks, denoise, HDR, panorama, crop, styles, export...). ' +
    'Check results with rapidraw_preview. Edits are non-destructive; rapidraw_undo reverts a run. Ask the user before exports or resets. Prompts are editing recipes.';

  async function dispatch(msg) {
    const { method, params = {} } = msg;
    switch (method) {
      case 'initialize': return { protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'rapidraw-web', title: 'RapidRAW Web', version }, instructions: INSTRUCTIONS };
      case 'ping': return {};
      case 'tools/list': return { tools: TOOLS };
      case 'tools/call': {
        const h = handlers[params.name];
        if (!h) throw rpcError(-32602, `Unknown tool ${params.name}`);
        try { return await h(params.arguments ?? {}); }
        catch (e) { return { content: [{ type: 'text', text: e.message ?? String(e) }], isError: true }; }
      }
      case 'prompts/list': return { prompts: prompts() };
      case 'prompts/get': return getPrompt(params.name, params.arguments);
      case 'resources/list': return { resources: resources() };
      case 'resources/read': return { contents: [{ uri: params.uri, mimeType: params.uri.startsWith('rapidraw://skills/') ? 'text/markdown' : 'text/plain', text: readResource(params.uri) }] };
      default: throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  function authorized(req, u, isLoopback, sameOrigin) {
    if (req.headers.origin && !sameOrigin(req)) return false; // a website in a browser must not reach it (DNS rebinding)
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? u.searchParams.get('token');
    const a = Buffer.from(String(bearer ?? '')), b = Buffer.from(token);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
    // Without the token only programs on this computer: loopback, not through a reverse proxy or tunnel on this
    // computer (tailscale serve, cloudflared, Caddy, nginx...: they add forwarding headers), not from a browser
    if (process.env.RR_MCP_REQUIRE_TOKEN === '1' || req.headers.origin) return false;
    if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
    return isLoopback(req.socket.remoteAddress);
  }

  async function http(req, res, u, { isLoopback, sameOrigin }) {
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin && sameOrigin(req) ? req.headers.origin : 'null', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' };
    if (!enabled) { res.writeHead(404).end(); return; }
    if (!authorized(req, u, isLoopback, sameOrigin)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="RapidRAW MCP"' }).end(JSON.stringify({ error: 'MCP token required (AI Editor → AI clients)' }));
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(204, cors).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { ...cors, Allow: 'POST, DELETE' }).end(); return; }
    let body = '';
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } body += chunk; }
    let msgs;
    try { msgs = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const batch = Array.isArray(msgs);
    const replies = [];
    let session = null;
    for (const m of batch ? msgs : [msgs]) {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        if (m && m.id !== undefined && (m.result !== undefined || m.error !== undefined)) continue; // a client's answer
        replies.push({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
        continue;
      }
      if (m.id === undefined || m.id === null) continue; // notification
      if (m.method === 'initialize') session = randomUUID();
      try { replies.push({ jsonrpc: '2.0', id: m.id, result: await dispatch(m) }); }
      catch (e) { replies.push({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } }); }
    }
    if (!replies.length) { res.writeHead(202, cors).end(); return; }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(session ? { 'Mcp-Session-Id': session } : {}) });
    res.end(JSON.stringify(batch ? replies : replies[0]));
  }

  // Every skill as an Agent Skills folder (<id>/SKILL.md), e.g. to upload to Claude.ai (Settings → Capabilities)
  async function zip(res) {
    const { default: yazl } = await import('yazl'); // lazy: rrweb/mcp/generate.mjs imports this file without the relay's packages
    const z = new yazl.ZipFile();
    const files = { ...(data.agentSkills ?? {}) };
    for (const s of store.list()) files[s.id] = s.raw + '\n';
    for (const [id, content] of Object.entries(files)) z.addBuffer(Buffer.from(content), `rapidraw-skills/${slug(id)}/SKILL.md`);
    z.end();
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="rapidraw-skills.zip"', 'Cache-Control': 'no-store' });
    z.outputStream.pipe(res);
  }

  return { enabled, token, http, zip, commands, dropClient, dispatch, install, skills: allSkills };
}

function rpcError(code, message) { const e = new Error(message); e.code = code; return e; }
