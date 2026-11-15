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
import { createJobs, Busy } from './jobs.mjs';
import { createProcessor, MODES, aiMaskContainer } from './process.mjs';
import { visionConfig, reviewImages } from './vision.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_SKILLS_SOURCE = 'https://github.com/vedranius/rapidraw-web/tree/main/plugins/rapidraw/skills';
const RUN_TIMEOUT = 15 * 60 * 1000;
// A plan that the tab could not start within this time is dropped: AI clients give up after about a minute, and a
// plan run later (when the tab is free again) overwrote newer edits
const START_WAIT = 45 * 1000;
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

// Numeric ranges of the sliders from the adjustment reference ("key min..max", top-level lines only), the same
// rule as adjustmentRanges() in src/agent/catalog.ts. An agent that read brightness as -100..100 set +12 and got
// white photos: values outside the range are refused.
export function adjustmentRanges(reference = '') {
  const ranges = new Map();
  for (const line of String(reference).split('\n')) {
    if (line.includes('{')) continue;
    for (const m of line.matchAll(/(?:^|\|)\s*([A-Za-z]\w*) (-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)/g)) ranges.set(m[1], [Number(m[2]), Number(m[3])]);
  }
  return ranges;
}
export function rangeProblems(patch, ranges, mask = false) {
  const out = [];
  for (const [k, v] of Object.entries(patch ?? {})) {
    const r = ranges.get(k);
    if (!r || typeof v !== 'number') continue;
    const [min, max] = mask && r[0] === 0 ? [-r[1], r[1]] : r;
    if (!Number.isFinite(v) || v < min || v > max) out.push(`${k} ${v} (range ${min}..${max})`);
  }
  if (Array.isArray(patch?.masks)) for (const m of patch.masks) if (m?.adjustments) out.push(...rangeProblems(m.adjustments, ranges, true));
  if (patch?.crop && patch.crop.unit && patch.crop.unit !== 'px') out.push('crop unit must be "px" (pixels of the original); use photo.crop for an aspect ratio');
  return out;
}

// --- server -------------------------------------------------------------------------------------------------------

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });

const SIDE_FILES = new Set(['.rrdata', '.xmp', '.json', '.txt', '.pp3', '.dop', '.thm', '.lrv']);

// The adjustments a mask has (src/utils/adjustments.ts INITIAL_MASK_ADJUSTMENTS), from the global defaults
const MASK_KEYS = ['activeTools', 'blacks', 'brightness', 'clarity', 'colorGrading', 'colorNoiseReduction', 'contrast', 'curves', 'pointCurves',
  'parametricCurve', 'curveMode', 'dehaze', 'exposure', 'flareAmount', 'glowAmount', 'halationAmount', 'highlights', 'hsl', 'hue',
  'lumaNoiseReduction', 'motionBlurAmount', 'motionBlurAngle', 'motionBlurDepth', 'motionBlurDepthEnabled', 'motionBlurHighlights',
  'motionBlurLayer', 'motionBlurType', 'saturation', 'shadows', 'sharpness', 'sharpnessThreshold', 'structure', 'temperature', 'tint',
  'vibrance', 'whites'];
export function maskDefaults(defaults) {
  const out = { activeTools: {}, sharpnessThreshold: 15, motionBlurDepth: 50, motionBlurHighlights: 30, motionBlurLayer: 'auto', motionBlurType: 'linear', curveMode: 'point' };
  for (const k of MASK_KEYS) if (k in defaults && !(k in out)) out[k] = structuredClone(defaults[k]);
  for (const k of ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'clarity', 'structure', 'dehaze', 'saturation', 'vibrance',
    'temperature', 'tint', 'hue', 'sharpness', 'lumaNoiseReduction', 'colorNoiseReduction', 'flareAmount', 'glowAmount', 'halationAmount', 'motionBlurAmount', 'motionBlurAngle']) out[k] = 0;
  out.motionBlurDepthEnabled = false;
  return out;
}

export const TOOLS = [
  { name: 'rapidraw_status', title: 'RapidRAW status',
    description: 'Is RapidRAW running, which photo library, is a RapidRAW Web tab open (needed by rapidraw_run), which photo is open and selected. Call this first.',
    inputSchema: obj({}), annotations: { readOnlyHint: true } },
  { name: 'rapidraw_list_images', title: 'List photos',
    description: 'Photos in a folder on the RapidRAW server (default: the photo library): path, rating, flag, colour label, tags, RAW and edited state. Paged (offset, limit) and filtered, so a folder of thousands stays small: e.g. flag "pick" and ext "RAF".',
    inputSchema: obj({ folder: str('Absolute folder path; default the photo library'), recursive: { type: 'boolean' },
      offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      flag: { enum: ['pick', 'reject', 'none'] }, color: str('Colour label, or "none"'), minRating: { type: 'integer', minimum: 0, maximum: 5 },
      ext: str('Only this extension, e.g. RAF or jpg'), contains: str('Only paths containing this text (e.g. a subfolder name)'),
      pathsOnly: { type: 'boolean', description: 'Only the paths (smallest answer)' } }),
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
  { name: 'rapidraw_process', title: 'Process photos (headless job)',
    description: 'Edits, denoises, exports and checks a set of photos on the server, without a browser tab, as a background job: returns a jobId at once (follow it with rapidraw_job). Per photo: AI masks, denoise chosen from the measured noise, export, automatic check of the file (white/black frames, crushed subject, tile grid, denoise without effect) with one automatic fix and re-export. '
      + 'BEFORE calling, ask the user which speed they want (mode): "none" very fast, no denoise; "bm3d" fast, BM3D only; "mixed" slower, BM3D or AI per photo by noise; "ai" very slow, AI only. rapidraw_analyze gives the time each mode would take for these photos. "keep" leaves each photo\'s denoise as it is. Exports are risky: confirm folder and size with the user.',
    inputSchema: obj({
      paths: { type: 'array', items: { type: 'string' }, description: 'Photos; or folder + filter' },
      folder: str('Instead of paths: every photo of this folder (with the filter)'), recursive: { type: 'boolean' },
      filter: obj({ flag: { enum: ['pick', 'reject', 'none'] }, color: { type: 'string' }, minRating: { type: 'integer' }, ext: { type: 'string' } }),
      mode: { enum: ['none', 'bm3d', 'mixed', 'ai', 'keep'] },
      thresholds: obj({ low: { type: 'number', description: 'Noise below: no denoise (default 1.2)' }, high: { type: 'number', description: 'Noise from: AI in mixed mode (default 3.0)' } }),
      adjustments: { type: 'object', description: 'Patch for every photo (the look), as rapidraw_apply_adjustments' },
      perPhoto: { type: 'object', description: '{ "<path>": patch } for single photos' },
      autoLens: { type: 'boolean' }, autoTone: { type: 'boolean', description: 'Auto tone with gentle limits by ISO (concert-safe)' },
      aiMasks: { type: 'array', items: obj({ type: { enum: ['subject', 'face', 'sky', 'foreground', 'text'] }, name: { type: 'string' }, patch: { type: 'object' },
        parts: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' }, grow: { type: 'number' }, feather: { type: 'number' } }, ['type']),
        description: 'AI masks added to every photo (a mask with the same name is replaced, never duplicated), e.g. {type:"face", name:"Face lift", patch:{exposure:0.35}}' },
      export: obj({ folder: str('Absolute output folder'), longEdge: { type: 'integer', minimum: 64 }, quality: { type: 'integer', minimum: 1, maximum: 100 },
        format: { enum: ['jpeg', 'png', 'tiff'] }, fastDenoise: { type: 'boolean', description: 'Denoise at twice the output size (default true)' },
        preserveTimestamps: { type: 'boolean', description: 'File time = capture time (default false: the time of the export)' }, filenameTemplate: { type: 'string' } }, ['folder']),
      qa: { type: 'boolean', default: true }, autoFix: { type: 'boolean', default: true },
      allowRisky: { type: 'boolean', description: 'Needed with export (the user confirmed folder and size)' },
    }), annotations: { destructiveHint: true } },
  { name: 'rapidraw_analyze', title: 'Measure noise (headless job)',
    description: 'Measures the noise of each photo (a GPU render without noise reduction) and returns, per photo and in total, what each processing mode (none, bm3d, mixed, ai) would do and an estimate of how long it would take on this server. Use it to offer the user the four speeds with real times. Background job: returns a jobId.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' } }, folder: { type: 'string' }, recursive: { type: 'boolean' },
      filter: obj({ flag: { enum: ['pick', 'reject', 'none'] }, color: { type: 'string' }, minRating: { type: 'integer' }, ext: { type: 'string' } }),
      thresholds: obj({ low: { type: 'number' }, high: { type: 'number' } }) }), annotations: { readOnlyHint: true } },
  { name: 'rapidraw_export', title: 'Export photos (headless job)',
    description: 'Exports photos with their saved edits on the server, without a browser tab, as a background job (jobId; rapidraw_job to follow or cancel). Never exports without a denoise the edit asks for. Every file is checked (white/black, tile grid) unless qa is false. Confirm folder and size with the user first (allowRisky).',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, minItems: 1 }, folder: str('Absolute output folder'), longEdge: { type: 'integer', minimum: 64 },
      quality: { type: 'integer', minimum: 1, maximum: 100 }, format: { enum: ['jpeg', 'png', 'tiff'] }, fastDenoise: { type: 'boolean' },
      preserveTimestamps: { type: 'boolean' }, filenameTemplate: { type: 'string' }, qa: { type: 'boolean', default: true }, autoFix: { type: 'boolean', default: false },
      allowRisky: { type: 'boolean' } }, ['paths', 'folder']), annotations: { destructiveHint: true } },
  { name: 'rapidraw_ai_mask', title: 'AI masks on many photos (headless job)',
    description: 'Adds an AI mask (subject, face, sky, foreground or text) with local adjustments to every given photo on the server, one photo at a time, without opening them in a tab. A mask with the same name is replaced, never duplicated. Background job: returns a jobId.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, minItems: 1 }, type: { enum: ['subject', 'face', 'sky', 'foreground', 'text'] }, name: { type: 'string' },
      patch: { type: 'object', description: 'Local adjustments of the mask, e.g. {exposure: 0.35, shadows: 15}' }, parts: { type: 'array', items: { type: 'string' }, description: 'Face parts (default faceSkin)' },
      prompt: { type: 'string', description: 'Text masks: what to select' }, grow: { type: 'number' }, feather: { type: 'number' } }, ['paths', 'type']),
    annotations: { destructiveHint: false } },
  { name: 'rapidraw_job', title: 'Follow a job',
    description: 'Status of a background job (state, done/total, current photo, ETA, results, problems found by the automatic check), or: wait (blocks up to "seconds", max 50, then returns the status), cancel, resume (an interrupted, failed or cancelled job continues with the photos it had not finished), undo (restores the edits a rapidraw_process job changed), list (recent jobs).',
    inputSchema: obj({ jobId: { type: 'string' }, action: { enum: ['status', 'wait', 'cancel', 'resume', 'undo', 'list'], default: 'status' },
      seconds: { type: 'integer', minimum: 1, maximum: 50, default: 45 }, full: { type: 'boolean', description: 'Every result and log line' } }) },
  { name: 'rapidraw_ai_review', title: 'Cheap vision review (culling)',
    description: 'Sends small previews of photos to the cheap vision model configured on the server (Claude Haiku 5.5 or Gemini Flash) and returns per photo a 0-10 score, keep, eyes closed, face hidden and distractions. For borderline frames after rapidraw_rank, so the main model does not look at every photo. Background job: returns a jobId. Errors when no model is configured.',
    inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 300 }, note: str('Extra instruction, e.g. "the singer of Exit Eden is the subject"'),
      maxEdge: { type: 'integer', minimum: 256, maximum: 1024, default: 640 } }, ['paths']), annotations: { readOnlyHint: true } },
  { name: 'rapidraw_rank', title: 'Rank photos (AI culling)',
    description: 'Scores every photo of a folder (or the given paths) with RapidRAW\'s content-aware culling (composition, light, sharpness, scene and subject), drops near-duplicates of a burst and soft frames, and returns the best ones with ISO, so an AI can pick e.g. the 50 best concert shots without looking at every photo. Slow for large folders (it analyses every file).',
    inputSchema: obj({
      folder: str('Absolute folder; default the photo library'), recursive: { type: 'boolean' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Instead of folder' },
      top: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
      keepDuplicates: { type: 'boolean', default: false, description: 'Keep every frame of a burst, not only its best one' },
      keepSoft: { type: 'boolean', default: false, description: 'Keep frames culling marks as soft' },
      similarityThreshold: { type: 'integer', minimum: 0, maximum: 64, default: 28 },
      blurThreshold: { type: 'number', default: 100 },
    }), annotations: { readOnlyHint: true } },
  { name: 'rapidraw_set_library', title: 'Flag, rate, label, tag',
    description: 'Sets the pick/reject flag, star rating, colour label and/or adds or removes tags on photos. Works without an open tab. includePairs also marks the other files of the same shot (DSCF1234.RAF and DSCF1234.JPG).',
    inputSchema: obj({
      paths: { type: 'array', items: { type: 'string' }, minItems: 1 }, includePairs: { type: 'boolean', default: false },
      flag: { enum: ['pick', 'reject', 'none'] }, rating: { type: 'integer', minimum: 0, maximum: 5 },
      color: { enum: ['red', 'yellow', 'green', 'blue', 'purple', 'none'] },
      addTags: { type: 'array', items: { type: 'string' } }, removeTags: { type: 'array', items: { type: 'string' } },
    }, ['paths']), annotations: { destructiveHint: false, idempotentHint: true } },
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
      async: { type: 'boolean', description: 'Return a jobId at once instead of waiting (long plans)' },
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
    const ws = host.ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rid);
        // a plan still waiting in the tab must not run later and overwrite newer edits
        try { ws.send(JSON.stringify({ event: '__rr_mcp_request', payload: { rid, op: 'cancel' } })); } catch { /* closed */ }
        reject(new Error(`${op} timed out in the RapidRAW Web tab; it was cancelled if it had not started. Prefer the headless tools (rapidraw_process, rapidraw_export, rapidraw_ai_mask), which return a jobId.`));
      }, timeout);
      pending.set(rid, { resolve, reject, timer, ws });
      ws.send(JSON.stringify({ event: '__rr_mcp_request', payload: { rid, op, deadline: Date.now() + Math.min(timeout, START_WAIT), ...args } }));
    });
  }
  // fire and forget: tell the tab that photos were changed headless
  function notifyTab(paths) {
    if (!host || host.ws.readyState !== 1 || !paths.length) return;
    try { host.ws.send(JSON.stringify({ event: '__rr_mcp_request', payload: { rid: `n${++seq}`, op: 'reload', paths } })); } catch { /* closed */ }
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
  const ranges = adjustmentRanges(data.reference ?? '');
  // the other files of the same shot: DSCF1234.RAF with DSCF1234.JPG (same folder, same name)
  async function withPairs(paths) {
    const out = new Set(paths);
    const byDir = new Map();
    for (const p of paths) { const d = path.dirname(p); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(p); }
    for (const [d, list] of byDir) {
      let names;
      try { names = await fsp.readdir(d); } catch { continue; }
      const stems = new Set(list.map((p) => path.parse(p).name.toLowerCase()));
      for (const n of names) {
        if (n.startsWith('.') || SIDE_FILES.has(path.extname(n).toLowerCase())) continue;
        if (stems.has(path.parse(n).name.toLowerCase())) out.add(path.join(d, n));
      }
    }
    return [...out];
  }
  const unknownKeys = (patch) => Object.keys(patch ?? {}).filter((k) => data.defaults && !(k in data.defaults));

  const baseDir = dataDir ?? (configFile ? path.dirname(configFile) : path.join(os.homedir(), '.rapidraw-web'));
  // previews are GPU renders: a few at a time, however many AI clients and jobs ask (a laptop froze with more)
  const previewSlots = { free: Math.max(1, parseInt(process.env.RR_MCP_PREVIEWS ?? '2', 10) || 2), waiting: [] };
  const limitedBridge = async (cmd, args) => {
    if (cmd !== 'generate_preview_for_path') return bridge(cmd, args);
    if (previewSlots.free > 0) previewSlots.free--;
    else await new Promise((r) => previewSlots.waiting.push(r));
    try { return await bridge(cmd, args); } finally { const next = previewSlots.waiting.shift(); next ? next() : previewSlots.free++; }
  };
  const jobs = createJobs({ file: path.join(baseDir, 'mcp-jobs.json'), log });
  if (!config.jobStats || typeof config.jobStats !== 'object') config.jobStats = {};
  let statsTimer = null;
  const proc = createProcessor({
    bridge: limitedBridge, defaults: data.defaults ?? {}, maskDefaults: maskDefaults(data.defaults ?? {}), notifyTab, stats: config.jobStats,
    saveStats: () => { if (!statsTimer) statsTimer = setTimeout(() => { statsTimer = null; try { saveConfig(); } catch { /* read-only */ } }, 5000); },
  });
  const snapDir = path.join(baseDir, 'mcp-snapshots');
  // the edits a job is about to change, for rapidraw_job undo (a resumed job keeps the snapshot of its first run)
  async function snapshot(ctx, paths) {
    const spec = ctx.job.spec;
    if (spec) spec.snapshotId ??= ctx.job.id;
    const f = path.join(snapDir, `${spec?.snapshotId ?? ctx.job.id}.json`);
    let snap = {};
    try { snap = JSON.parse(await fsp.readFile(f, 'utf8')); } catch { /* first */ }
    for (const p of paths) if (!(p in snap)) { try { snap[p] = (await bridge('load_metadata', { path: p }))?.adjustments ?? null; } catch { snap[p] = null; } }
    await fsp.mkdir(snapDir, { recursive: true });
    await fsp.writeFile(f, JSON.stringify(snap));
    // only the snapshots of the jobs still listed are kept
    const keep = new Set(jobs.list().flatMap((j) => [`${j.jobId}.json`, `${jobs.get(j.jobId)?.spec?.snapshotId}.json`]));
    for (const old of await fsp.readdir(snapDir).catch(() => [])) if (!keep.has(old)) fsp.rm(path.join(snapDir, old), { force: true }).catch(() => {});
  }
  const models = () => ({
    cull: process.env.RR_MODEL_CULL || config.models?.cull || 'claude-haiku-5-5',
    plan: process.env.RR_MODEL_PLAN || config.models?.plan || 'claude-sonnet-5-5',
    rescue: process.env.RR_MODEL_RESCUE || config.models?.rescue || 'claude-opus-5-5',
  });

  async function listFolder(dir, recursive) {
    if (!dir) throw new Error('No photo library is set; pass folder');
    await checkPath(dir);
    return (await bridge(recursive ? 'list_images_recursive' : 'list_images_in_dir', { path: dir })) ?? [];
  }
  const colorOf = (f) => (f.tags ?? []).find((t) => t.startsWith('color:'))?.slice(6) ?? null;
  function filterImages(list, { flag, color, minRating, ext, contains } = {}) {
    return list.filter((f) => (!flag || (flag === 'none' ? !f.flag : f.flag === flag))
      && (!color || (color === 'none' ? !colorOf(f) : colorOf(f) === color))
      && (minRating === undefined || (f.rating ?? 0) >= minRating)
      && (!ext || path.extname(f.path).slice(1).toLowerCase() === String(ext).replace(/^\./, '').toLowerCase())
      && (!contains || f.path.includes(contains)));
  }
  async function targets({ paths, folder, recursive, filter }) {
    if (paths?.length) { for (const p of paths) await checkPath(p); return [...new Set(paths)]; }
    if (!folder && !library()) throw new Error('Pass paths, or folder (with filter)');
    const list = filterImages(await listFolder(folder || library(), recursive), filter);
    if (!list.length) throw new Error('No photos match');
    return list.map((f) => f.path);
  }
  function checkPatch(patch, mask = false) {
    const bad = unknownKeys(patch);
    if (bad.length) throw new Error(`Unknown adjustment keys: ${bad.join(', ')}. See rapidraw_commands with reference=true.`);
    const out = rangeProblems(patch ?? {}, ranges, mask);
    if (out.length) throw new Error(`Out of range: ${out.join('; ')}. Nothing was changed.`);
  }
  const accepted = (job, extra = {}) => text({ jobId: job.id, state: job.state, total: job.total, ...extra,
    next: `rapidraw_job {jobId: "${job.id}", action: "wait"} until the state is done (each call waits up to 50 s).` });
  function submit(opts) {
    try { return jobs.submit(opts); } catch (e) { if (e instanceof Busy) throw Object.assign(new Error(e.message), { retryAfter: e.retryAfter }); throw e; }
  }
  const exportOpts = (e) => ({ ...e, format: e.format ?? 'jpeg' });

  const handlers = {
    async rapidraw_status() {
      let bridgeOk = true;
      let health = null;
      try { await bridge('load_settings', {}); } catch { bridgeOk = false; }
      if (bridgeOk) { try { health = await bridge('rrweb_health', {}); } catch { /* older bridge */ } }
      const vision = visionConfig(config);
      const running = jobs.running();
      const lib = library() ?? host?.state?.currentFolder ?? null;
      return text({ version, bridge: bridgeOk ? 'connected' : 'not connected', library: lib, editorTab: host ? 'open' : 'none', ...(host?.state ?? {}),
        health: health ?? undefined,
        jobs: { running: running ? jobs.view(running) : null, queued: jobs.queued() },
        vision: vision.configured ? { provider: vision.provider, model: vision.model } : 'not configured (rapidraw_ai_review needs ANTHROPIC_API_KEY or GEMINI_API_KEY on the server)',
        models: models(),
        modelRouting: 'Use the cheapest model that can do the work: culling with rapidraw_rank (local), then rapidraw_ai_review (cheap vision model on the server) for borderline frames, or a subagent on models.cull; edit plans on models.plan; models.rescue only for photos that still fail QA.',
        processingModes: MODES,
        skills: allSkills().length,
        hint: 'Every tool works without a browser tab except rapidraw_run/rapidraw_undo. Long work (rapidraw_process, rapidraw_export, rapidraw_ai_mask, rapidraw_analyze, rapidraw_ai_review) returns a jobId.' });
    },
    async rapidraw_list_images({ folder, recursive, offset = 0, limit = 100, pathsOnly, ...filter }) {
      const dir = folder || library();
      const all = filterImages(await listFolder(dir, recursive), filter);
      const page = all.slice(offset, offset + limit);
      const more = offset + page.length < all.length ? offset + page.length : undefined;
      if (pathsOnly) return text({ folder: dir, total: all.length, offset, nextOffset: more, paths: page.map((f) => f.path) });
      const out = page.map((f) => ({ path: f.path, rating: f.rating || undefined, flag: f.flag ?? undefined, color: colorOf(f) ?? undefined,
        tags: f.tags?.filter((t) => !t.startsWith('color:')).length ? f.tags.filter((t) => !t.startsWith('color:')) : undefined,
        raw: f.is_raw ?? f.isRaw, edited: f.is_edited ?? f.isEdited }));
      return text({ folder: dir, total: all.length, offset, nextOffset: more, images: out });
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
      if (adjustments) checkPatch(adjustments);
      const cur = (await fullAdjustments(p)).adjustments;
      const jpeg = await limitedBridge('generate_preview_for_path', { path: p, jsAdjustments: adjustments ? deepMerge(cur, adjustments) : cur, maxEdge });
      if (!Buffer.isBuffer(jpeg)) throw new Error('RapidRAW returned no image');
      return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: `${path.basename(p)}${adjustments ? ' (patch previewed, not saved)' : ''}` }] };
    },
    // always headless: a plan in the tab could wait behind other work and run minutes later (handover #2)
    async rapidraw_apply_adjustments({ paths, adjustments }) {
      checkPatch(adjustments);
      for (const p of paths) await checkPath(p);
      for (const p of paths) await proc.patchPhoto(p, adjustments);
      notifyTab(paths);
      return text({ ok: true, updated: paths.length });
    },
    async rapidraw_process(args) {
      const { mode, export: exp, allowRisky } = args;
      if (!mode) {
        throw new Error(`Ask the user which speed they want, then pass mode: ${Object.entries(MODES).map(([k, v]) => `"${k}" ${v}`).join('; ')}; or "keep" (leave each photo's denoise). rapidraw_analyze gives the time of each mode for these photos.`);
      }
      if (exp && !allowRisky) throw new Error(`Exporting writes files into ${exp.folder}: confirm the folder and size with the user, then pass allowRisky=true.`);
      if (exp) await checkPath(exp.folder);
      if (args.adjustments) checkPatch(args.adjustments);
      for (const patch of Object.values(args.perPhoto ?? {})) checkPatch(patch);
      for (const m of args.aiMasks ?? []) if (m.patch) checkPatch(m.patch, true);
      for (const p of Object.keys(args.perPhoto ?? {})) await checkPath(p);
      const paths = await targets(args);
      const spec = { paths, mode, thresholds: args.thresholds, adjustments: args.adjustments, perPhoto: args.perPhoto, autoLens: args.autoLens, autoTone: args.autoTone,
        aiMasks: args.aiMasks ?? [], export: exp ? exportOpts(exp) : null, qa: args.qa !== false, autoFix: args.autoFix !== false, done: [] };
      const job = submit({ kind: 'process', title: `${mode} on ${paths.length} photo(s)${exp ? ` → ${exp.folder}` : ''}`, total: paths.length, spec,
        runner: async (ctx) => { await snapshot(ctx, paths); return proc.run(ctx, spec); } });
      return accepted(job, { mode, undo: `rapidraw_job {jobId: "${job.id}", action: "undo"}` });
    },
    async rapidraw_analyze(args) {
      const paths = await targets(args);
      const spec = { paths, thresholds: args.thresholds };
      const job = submit({ kind: 'analyze', title: `noise of ${paths.length} photo(s)`, total: paths.length, spec, runner: (ctx) => proc.analyze(ctx, spec) });
      return accepted(job);
    },
    async rapidraw_export(args) {
      const { paths, folder, allowRisky, qa = true, autoFix = false } = args;
      if (!allowRisky) throw new Error(`Exporting writes files into ${folder}: confirm the folder and size with the user, then pass allowRisky=true.`);
      await checkPath(folder);
      for (const p of paths) await checkPath(p);
      const exp = exportOpts({ folder, longEdge: args.longEdge, quality: args.quality, format: args.format, fastDenoise: args.fastDenoise,
        preserveTimestamps: args.preserveTimestamps, filenameTemplate: args.filenameTemplate });
      const spec = { paths: [...new Set(paths)], mode: 'keep', export: exp, qa, autoFix, done: [] };
      const job = submit({ kind: 'export', title: `export of ${spec.paths.length} photo(s) → ${folder}`, total: spec.paths.length, spec,
        runner: async (ctx) => { if (autoFix) await snapshot(ctx, spec.paths); return proc.run(ctx, spec); } });
      return accepted(job);
    },
    async rapidraw_ai_mask({ paths, type, name, patch, parts, prompt, grow, feather }) {
      for (const p of paths) await checkPath(p);
      if (patch) checkPatch(patch, true);
      aiMaskContainer({ type, name, patch, parts, prompt }, {}); // validates type and prompt now, not in the job
      const spec = { paths: [...new Set(paths)], mode: 'keep', aiMasks: [{ type, name: name || `AI ${type}`, patch, parts, prompt, grow, feather }], done: [] };
      const job = submit({ kind: 'ai-mask', title: `${type} mask on ${spec.paths.length} photo(s)`, total: spec.paths.length, spec,
        runner: async (ctx) => { await snapshot(ctx, spec.paths); return proc.run(ctx, spec); } });
      return accepted(job, { undo: `rapidraw_job {jobId: "${job.id}", action: "undo"}` });
    },
    async rapidraw_job({ jobId, action = 'status', seconds = 45, full }) {
      if (action === 'list') return text({ jobs: jobs.list() });
      if (!jobId) throw new Error('Pass jobId (rapidraw_job {action: "list"} lists the recent jobs)');
      const job = jobs.get(jobId);
      if (!job) throw new Error(`Unknown job ${jobId}`);
      if (action === 'wait') await jobs.wait(jobId, Math.min(50, Math.max(1, seconds)) * 1000);
      if (action === 'cancel') jobs.cancel(jobId);
      if (action === 'resume') {
        if (!['interrupted', 'failed', 'cancelled'].includes(job.state) || !job.spec) throw new Error(`Job ${jobId} is ${job.state}; only an interrupted, failed or cancelled job can be resumed`);
        const spec = job.spec;
        const left = spec.paths.length - (spec.done?.length ?? 0);
        const runner = job.kind === 'analyze' ? (ctx) => proc.analyze(ctx, { ...spec, paths: spec.paths.filter((p) => !(spec.done ?? []).includes(p)) })
          : job.kind === 'review' ? null
            : async (ctx) => { await snapshot(ctx, spec.paths); return proc.run(ctx, spec); };
        if (!runner) throw new Error('A review cannot be resumed; start it again with the photos it had not reviewed');
        const next = submit({ kind: job.kind, title: `${job.title} (resumed)`, total: spec.paths.length, spec, runner });
        return accepted(next, { resumedFrom: jobId, left });
      }
      if (action === 'undo') {
        if (job.state === 'running' || job.state === 'queued') throw new Error('Cancel the job first');
        let snap;
        try { snap = JSON.parse(await fsp.readFile(path.join(snapDir, `${job.spec?.snapshotId ?? jobId}.json`), 'utf8')); } catch { throw new Error(`Job ${jobId} changed no edits, or its snapshot is gone`); }
        let restored = 0;
        for (const [p, adj] of Object.entries(snap)) {
          await bridge('save_metadata_and_update_thumbnail', { path: p, adjustments: adj ?? {} });
          restored++;
        }
        notifyTab(Object.keys(snap));
        return text({ jobId, restored, note: 'Exported files stay on disk.' });
      }
      const v = jobs.view(jobs.get(jobId), { full });
      return text(v.state === 'running' || v.state === 'queued' ? { ...v, next: 'rapidraw_job {action: "wait"} again' } : v);
    },
    async rapidraw_ai_review({ paths, note, maxEdge = 640 }) {
      const cfg = visionConfig(config);
      if (!cfg.provider) await reviewImages(cfg, [], note); // throws the "not configured" advice
      for (const p of paths) await checkPath(p);
      const list = [...new Set(paths)];
      const spec = { paths: list, done: [] };
      const job = submit({ kind: 'review', title: `${cfg.model} review of ${list.length} photo(s)`, total: list.length, spec, runner: async (ctx) => {
        const usage = { input: 0, output: 0 };
        let i = 0;
        for (let b = 0; b < list.length; b += 6) {
          ctx.checkCancelled();
          const batch = list.slice(b, b + 6);
          ctx.progress(i, list.length, batch[0]);
          const imgs = [];
          for (const p of batch) {
            const { adjustments } = await fullAdjustments(p);
            imgs.push(await limitedBridge('generate_preview_for_path', { path: p, jsAdjustments: adjustments, maxEdge }));
          }
          try {
            const r = await reviewImages(cfg, imgs, note);
            usage.input += r.usage?.input ?? 0; usage.output += r.usage?.output ?? 0;
            const byIndex = new Map((r.photos ?? []).map((x) => [x.index, x]));
            batch.forEach((p, k) => { const x = byIndex.get(k) ?? {}; delete x.index; ctx.result({ path: p, ok: x.score !== undefined, ...x }); });
          } catch (e) {
            ctx.log(`review failed: ${e.message}`);
            batch.forEach((p) => ctx.result({ path: p, ok: false, error: e.message }));
          }
          spec.done.push(...batch);
          i += batch.length;
          ctx.progress(i, list.length, null);
        }
        const rows = ctx.job.results.filter((r) => r.ok !== false);
        return { reviewed: rows.length, keep: rows.filter((r) => r.keep).map((r) => r.path), reject: rows.filter((r) => r.keep === false).map((r) => r.path),
          model: cfg.model, usage, note: 'rapidraw_job {full: true} lists every score and note' };
      } });
      return accepted(job, { model: cfg.model });
    },
    async rapidraw_rank({ folder, recursive, paths, top = 50, keepDuplicates, keepSoft, similarityThreshold = 28, blurThreshold = 100 }) {
      let list = paths;
      if (!list?.length) {
        const dir = folder || library();
        if (!dir) throw new Error('No photo library is set; pass folder or paths');
        await checkPath(dir);
        list = ((await bridge(recursive ? 'list_images_recursive' : 'list_images_in_dir', { path: dir })) ?? []).map((f) => f.path);
      }
      for (const p of list) await checkPath(p);
      if (!list.length) return text({ total: 0, best: [] });
      const t0 = Date.now();
      const r = await bridge('cull_images', { paths: list, settings: { groupSimilar: true, similarityThreshold, filterBlurry: true, blurThreshold, includeScores: true } });
      const scores = r?.scores ?? [];
      if (!scores.length && list.length) throw new Error('This RapidRAW bridge is too old to return culling scores; update RapidRAW Web.');
      const drop = new Set();
      if (!keepDuplicates) for (const g of r.similarGroups ?? []) for (const d of g.duplicates ?? []) drop.add(d.path);
      if (!keepSoft) for (const b of r.blurryImages ?? []) drop.add(b.path);
      const best = scores.filter((x) => !drop.has(x.path)).sort((a, b) => b.aiScore - a.aiScore).slice(0, top);
      let exif = {};
      try { exif = (await bridge('read_exif_for_paths', { paths: best.map((x) => x.path) })) ?? {}; } catch { /* ISO stays unknown */ }
      const iso = (p) => { const e = exif[p] ?? {}; const v = e.PhotographicSensitivity ?? e.ISOSpeedRatings ?? e.ISO; const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : undefined; };
      const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
      return text({
        analysed: scores.length, failed: r.failedPaths?.length ?? 0, droppedDuplicates: keepDuplicates ? 0 : [...(r.similarGroups ?? [])].reduce((n, g) => n + (g.duplicates?.length ?? 0), 0),
        droppedSoft: keepSoft ? 0 : (r.blurryImages?.length ?? 0), seconds: Math.round((Date.now() - t0) / 1000),
        best: best.map((x, i) => ({ rank: i + 1, path: x.path, score: r2(x.aiScore), iso: iso(x.path), sharpness: r2(x.sharpnessMetric), exposure: r2(x.exposureMetric),
          highlightClip: r2(x.highlightClip), shadowClip: r2(x.shadowClip), tags: x.tags?.slice(0, 6) })),
      });
    },
    async rapidraw_set_library({ paths: given, includePairs, flag, rating, color, addTags = [], removeTags = [] }) {
      for (const p of given) await checkPath(p);
      const paths = includePairs ? await withPairs(given) : given;
      if (host) {
        const steps = [];
        if (flag) steps.push({ tool: 'library.flag', params: { paths, flag: flag === 'none' ? null : flag } });
        if (rating !== undefined) steps.push({ tool: 'library.rate', params: { paths, rating } });
        if (color) steps.push({ tool: 'library.color', params: { paths, color: color === 'none' ? null : color } });
        if (addTags.length || removeTags.length) steps.push({ tool: 'library.tag', params: { paths, tags: addTags, remove: removeTags } });
        if (!steps.length) throw new Error('Nothing to set');
        return text(await hostRequest('run', { steps, paths }));
      }
      if (flag) await bridge('set_flag_for_paths', { paths, flag: flag === 'none' ? null : flag });
      if (rating !== undefined) await bridge('set_rating_for_paths', { paths, rating });
      if (color) await bridge('set_color_label_for_paths', { paths, color: color === 'none' ? null : color });
      for (const tag of addTags) await bridge('add_tag_for_paths', { paths, tag });
      for (const tag of removeTags) await bridge('remove_tag_for_paths', { paths, tag });
      notifyTab(paths);
      return text({ ok: true, updated: paths.length, ...(includePairs ? { pairsAdded: paths.length - given.length } : {}) });
    },
    async rapidraw_commands({ category, id, reference }) {
      if (id) { const t = catalog.get(id); if (!t) throw new Error(`Unknown command ${id}`); return text(t); }
      const lines = [...catalog.values()].filter((t) => !category || t.category === category)
        .map((t) => `${t.id}${t.destructive ? ' [risky]' : ''}: ${t.description} | params: ${t.params}`);
      return text(lines.join('\n') + (reference ? `\n\nADJUSTMENTS REFERENCE\n${data.reference}` : '\n\n(reference=true lists every adjustment key and range)'));
    },
    async rapidraw_run({ steps, paths, allowRisky, async: background }) {
      const unknown = steps.filter((s) => !catalog.has(s.tool)).map((s) => s.tool);
      if (unknown.length) throw new Error(`Unknown commands: ${unknown.join(', ')}. See rapidraw_commands.`);
      const risky = steps.filter((s) => catalog.get(s.tool)?.destructive).map((s) => s.tool);
      if (risky.length && !allowRisky) throw new Error(`Risky steps (${risky.join(', ')}) need allowRisky=true. Confirm with the user first.`);
      if (paths) for (const p of paths) await checkPath(p);
      const plan = { steps: steps.map((s) => ({ tool: s.tool, params: s.params ?? {}, note: s.note })), paths };
      if (background) {
        if (!host) hostRequest('run', plan); // throws "no tab"
        const job = submit({ kind: 'run', title: `plan of ${steps.length} step(s) in the tab`, total: steps.length, runner: async (ctx) => {
          const r = await hostRequest('run', plan);
          for (const x of r?.results ?? []) ctx.result(x);
          ctx.progress(steps.length, steps.length);
          return { runId: r?.runId, ok: !r?.results?.some((x) => !x.ok) };
        } });
        return accepted(job);
      }
      const r = await hostRequest('run', plan);
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

  const INSTRUCTIONS = 'RapidRAW Web: a GPU RAW photo editor on a server; every tool works headless (no browser tab), except rapidraw_run/rapidraw_undo. Start with rapidraw_status and rapidraw_list_images (paged, filtered). ' +
    'Culling: rapidraw_rank (local scores, free) first, then rapidraw_ai_review (cheap vision model on the server) only for borderline frames, then rapidraw_set_library to flag picks. Never look at hundreds of previews with an expensive model. ' +
    'Editing: rapidraw_get_edit, rapidraw_preview, rapidraw_apply_adjustments (values are range-checked; brightness is -5..5 and +1 is already strong). ' +
    'Many photos: ask the user for a speed (rapidraw_analyze gives the real times), then rapidraw_process: masks, denoise chosen by measured noise, export, automatic check and one fix per photo. ' +
    'Long tools return a jobId: follow with rapidraw_job {action: "wait"} (up to 50 s per call), never start the same work twice; "busy" means wait and retry. rapidraw_job undo restores the edits of a job. ' +
    'Ask the user before exports or resets (allowRisky). Prompts are editing recipes.';

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

  return { enabled, token, http, zip, commands, dropClient, dispatch, install, skills: allSkills, onEvent: proc.onEvent, jobs };
}

function rpcError(code, message) { const e = new Error(message); e.code = code; return e; }
