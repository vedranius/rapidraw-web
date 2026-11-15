// Headless photo processing for the MCP server: everything runs on the RapidRAW server through the bridge, no
// browser tab needed. Used by the jobs of mcp.mjs (rapidraw_process, rapidraw_export, rapidraw_ai_mask,
// rapidraw_analyze).
//
// Lessons from a real concert edit (144 photos, ISO 12800, see AI_MCP.md "Processing many photos"):
// - denoise is chosen per photo from its measured noise: clean frames get none, moderate noise BM3D (fast),
//   heavy noise AI (slow); the user picks one of four speeds;
// - AI denoise for a resized export is made at twice the output size, not at full size (fastDenoise);
// - every exported file is measured: white or black frames, crushed subjects, the grid of denoise tiles and a
//   denoise that had no effect are found and, with autoFix, corrected and exported again once;
// - auto tone is kept gentle on high-ISO concert frames (clarity, contrast and blacks are limited by ISO).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const MODES = {
  none: 'very fast: no denoise (only colour noise reduction on very noisy frames)',
  bm3d: 'fast: BM3D denoise on every frame that needs it',
  mixed: 'slower: per photo by measured noise: none, BM3D for moderate noise, AI for heavy noise',
  ai: 'very slow: AI denoise on every frame that needs it',
};
// seconds per photo (24-26 MP RAW, 2048 px JPEG) before this server has measured its own
const DEFAULT_SECONDS = { none: 4, bm3d: 15, ai: 55 };

// Noise is the Immerkær estimate in 0..255 levels at 2048 px (rrweb_measure_images), without any denoise.
// Below LOW a frame is clean, at HIGH and above AI denoise pays off. Overridable per call (thresholds).
export const NOISE = { low: 1.2, high: 3.0 };

/** Denoise for one photo in a mode: { method: 'none'|'bm3d'|'ai', amount } */
export function chooseDenoise(mode, noise, iso, thresholds = NOISE) {
  const { low, high } = { ...NOISE, ...thresholds };
  // no measure: fall back to ISO
  const n = Number.isFinite(noise) ? noise : iso >= 6400 ? high + 0.5 : iso >= 1600 ? (low + high) / 2 : iso ? low / 2 : low / 2;
  if (mode === 'keep') return null;
  if (n < low) return { method: 'none', amount: 0, noise: n };
  const amountAi = Math.round(Math.min(70, 40 + (n - low) * 4)); // 100 left a visible tile grid in smooth areas
  const amountBm3d = Math.round(Math.min(85, 55 + (n - low) * 6));
  switch (mode) {
    case 'none': return { method: 'none', amount: 0, noise: n, colorNoiseReduction: n >= high ? 25 : undefined };
    case 'bm3d': return { method: 'bm3d', amount: amountBm3d, noise: n };
    case 'ai': return { method: 'ai', amount: amountAi, noise: n };
    default: return n >= high ? { method: 'ai', amount: amountAi, noise: n } : { method: 'bm3d', amount: amountBm3d, noise: n };
  }
}

/** Gentle limits for auto tone on concert / high-ISO frames (auto tone set clarity 30, contrast 95, blacks -18) */
export function concertLimits(iso) {
  if (iso >= 6400) return { clarity: 10, structure: 10, contrast: 30, blacks: -10, dehaze: 10, brightness: 1 };
  if (iso >= 3200) return { clarity: 15, structure: 15, contrast: 40, blacks: -12, dehaze: 15, brightness: 1 };
  return { clarity: 25, structure: 20, contrast: 50, blacks: -15, dehaze: 20, brightness: 1.5 };
}
export function clampTone(adj, limits) {
  const out = {};
  for (const k of ['clarity', 'structure', 'contrast', 'dehaze']) {
    if (typeof adj[k] === 'number' && adj[k] > limits[k]) out[k] = limits[k];
  }
  if (typeof adj.blacks === 'number' && adj.blacks < limits.blacks) out.blacks = limits.blacks;
  if (typeof adj.brightness === 'number' && Math.abs(adj.brightness) > limits.brightness) out.brightness = Math.sign(adj.brightness) * limits.brightness;
  return out;
}

/** QA of one exported image; before: measure of the same photo without denoise (optional) */
export function judge(m, { denoise, before, expectedGrid, grain = 0 } = {}) {
  const issues = [];
  if (m.error) return [{ kind: 'unreadable', detail: m.error }];
  if (m.median > 0.85 || m.whiteClip > 0.5) issues.push({ kind: 'white', detail: `median ${m.median.toFixed(2)}, ${(m.whiteClip * 100).toFixed(0)} % clipped white` });
  if (m.median < 0.02 || m.blackClip > 0.6) issues.push({ kind: 'black', detail: `median ${m.median.toFixed(3)}, ${(m.blackClip * 100).toFixed(0)} % pure black` });
  else if (m.centerBlack > 0.3) issues.push({ kind: 'crushedSubject', detail: `${(m.centerBlack * 100).toFixed(0)} % of the centre is pure black` });
  if (denoise && denoise !== 'none' && m.gridScore >= 6) issues.push({ kind: 'grid', detail: `regular grid every ${m.gridPeriod.toFixed(0)} px (score ${m.gridScore.toFixed(1)})${expectedGrid ? `, denoise tiles every ${expectedGrid.toFixed(0)} px` : ''}` });
  if (denoise && denoise !== 'none' && !grain && before?.noise > NOISE.low && m.noise > 0.85 * before.noise) {
    issues.push({ kind: 'denoiseNoEffect', detail: `noise ${m.noise.toFixed(2)} after ${denoise} vs ${before.noise.toFixed(2)} without` });
  }
  return issues;
}

/** The patch that corrects an issue (null: nothing to do automatically) */
export function fixFor(issue, adj, m) {
  switch (issue.kind) {
    case 'white': {
      const stops = Math.log2(Math.max(m.median, 0.05) / 0.4);
      const p = { exposure: Math.round(Math.max(-5, (adj.exposure ?? 0) - Math.min(2, Math.max(0.3, stops))) * 100) / 100 };
      if ((adj.brightness ?? 0) > 0.5) p.brightness = 0;
      return p;
    }
    case 'black': return { exposure: Math.round(Math.min(5, (adj.exposure ?? 0) + Math.min(1.5, Math.log2(0.18 / Math.max(m.median, 0.01)))) * 100) / 100, shadows: Math.min(100, (adj.shadows ?? 0) + 15) };
    case 'crushedSubject': return { shadows: Math.min(100, (adj.shadows ?? 0) + 15), blacks: Math.max(adj.blacks ?? 0, -5) };
    case 'grid':
    case 'denoiseNoEffect':
      return adj.aiDenoiseMethod === 'bm3d' || !adj.aiDenoiseEnabled
        ? { aiDenoiseEnabled: false, lumaNoiseReduction: Math.max(adj.lumaNoiseReduction ?? 0, 25), colorNoiseReduction: Math.max(adj.colorNoiseReduction ?? 0, 30) }
        : { aiDenoiseMethod: 'bm3d', aiDenoiseAmount: Math.max(55, Math.min(80, adj.aiDenoiseAmount ?? 60)) };
    default: return null;
  }
}

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, patch) {
  const out = { ...(plain(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch ?? {})) out[k] = plain(v) && plain(out[k]) ? merge(out[k], v) : v;
  return out;
}
const num = (v) => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : undefined; };
export const isoOf = (e = {}) => num(e.PhotographicSensitivity ?? e.ISOSpeedRatings ?? e.ISO ?? e.iso);

// AI mask containers as the editor makes them; the background AI worker (or rrweb_resolve_ai) fills in the mask
export function aiMaskContainer({ type = 'subject', name, patch = {}, parts, grow = 0, feather = 0, opacity = 100, prompt }, defaults) {
  const t = String(type).toLowerCase();
  const subType = { subject: 'ai-subject', face: 'ai-face', sky: 'ai-sky', foreground: 'ai-foreground', text: 'ai-text' }[t];
  if (!subType) throw new Error(`Unknown AI mask type ${type}: subject, face, sky, foreground or text`);
  const parameters = { maskDataBase64: null, grow, feather };
  if (t === 'subject') Object.assign(parameters, { startX: 10, startY: 10, endX: 990, endY: 990, boxSpaceWidth: 1000, boxSpaceHeight: 1000 });
  if (t === 'face') parameters.parts = parts?.length ? parts : ['faceSkin'];
  if (t === 'text') { if (!prompt) throw new Error('A text mask needs a prompt'); parameters.prompt = prompt; }
  return {
    id: randomUUID(), name: name || `AI ${t}`, opacity, visible: true, invert: false,
    subMasks: [{ id: randomUUID(), name: name || t, type: subType, mode: 'additive', opacity: 100, visible: true, invert: false, parameters }],
    adjustments: merge(defaults ?? {}, patch),
  };
}

export function createProcessor({ bridge, defaults = {}, maskDefaults = {}, notifyTab = () => {}, workDir = os.tmpdir(), stats = {}, saveStats = () => {} }) {
  // export events from RapidRAW (relay.mjs forwards every bridge event to onEvent)
  const exportListeners = new Set();
  function onEvent(event, payload) {
    if (['batch-export-progress', 'export-complete', 'export-error', 'export-cancelled'].includes(event)) for (const l of exportListeners) l(event, payload);
  }

  // one writer per sidecar at a time (headless edits, jobs)
  const locks = new Map();
  async function withLock(p, fn) {
    const prev = locks.get(p) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    locks.set(p, prev.then(() => mine));
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(p) === mine) locks.delete(p); }
  }
  const load = async (p) => merge(defaults, (await bridge('load_metadata', { path: p }))?.adjustments ?? {});
  async function patchPhoto(p, patch, { replaceMasksNamed } = {}) {
    return withLock(p, async () => {
      const cur = await load(p);
      let next = merge(cur, patch);
      if (replaceMasksNamed?.length) {
        const keep = (cur.masks ?? []).filter((m) => !replaceMasksNamed.includes(m.name));
        next = { ...next, masks: [...keep, ...(patch.masks ?? [])] };
      }
      await bridge('save_metadata_and_update_thumbnail', { path: p, adjustments: next });
      return next;
    });
  }

  async function exif(paths) {
    try { return (await bridge('read_exif_for_paths', { paths })) ?? {}; } catch { return {}; }
  }

  const tmpDir = path.join(workDir, 'rrweb-mcp');
  async function tmpFile(buf) {
    await fsp.mkdir(tmpDir, { recursive: true });
    const f = path.join(tmpDir, `${randomBytes(6).toString('hex')}.jpg`);
    await fsp.writeFile(f, buf);
    return f;
  }
  async function measureFiles(files, maxEdge = 2048, expectedGrid) {
    return bridge('rrweb_measure_images', { paths: files, maxEdge, expectedGrid: expectedGrid ?? null });
  }
  /** Noise and brightness of a photo as it would develop without any noise reduction, at 2048 px */
  async function measureSource(p, adj, edge = 2048) {
    const a = adj ?? await load(p);
    // as exported, minus every kind of noise reduction (and grain, which would read as noise)
    const plainAdj = { ...a, aiDenoiseEnabled: false, lumaNoiseReduction: 0, colorNoiseReduction: 0, grainAmount: 0 };
    const jpeg = await bridge('generate_preview_for_path', { path: p, jsAdjustments: plainAdj, maxEdge: edge });
    if (!Buffer.isBuffer(jpeg)) throw new Error('RapidRAW returned no image');
    const f = await tmpFile(jpeg);
    try { return (await measureFiles([f], edge))[0]; } finally { fsp.rm(f, { force: true }).catch(() => {}); }
  }

  // ---- export, one call of RapidRAW's batch export, waiting for its events ------------------------------------
  async function exportPhotos(ctx, paths, opts) {
    const { folder, format = 'jpeg', quality = 90, longEdge, fastDenoise = true, preserveTimestamps = false, filenameTemplate = null, stripGps = false } = opts;
    if (!folder || !path.isAbsolute(folder)) throw new Error('export.folder must be an absolute folder on the server');
    try { await bridge('create_folder', { path: folder }); } catch (e) { if (!/exist/i.test(String(e.message))) throw e; }
    const results = new Map(paths.map((p) => [p, { path: p }]));
    let resolveDone, rejectDone;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
    const listener = (event, payload) => {
      if (event === 'batch-export-progress' && payload?.path && results.has(payload.path)) {
        Object.assign(results.get(payload.path), { output: payload.output ?? undefined, error: payload.error ?? undefined });
        ctx?.log?.(`exported ${path.basename(payload.path)}${payload.error ? `: ${payload.error}` : ''}`);
      } else if (event === 'export-complete') resolveDone('complete');
      else if (event === 'export-cancelled') resolveDone('cancelled');
      else if (event === 'export-error') resolveDone('error');
    };
    exportListeners.add(listener);
    ctx?.onCancel?.(() => bridge('cancel_export', {}).catch(() => {}));
    try {
      await bridge('export_images', {
        paths, outputFolderOrFile: folder, isExplicitFilePath: false, baseOriginFolders: [],
        exportSettings: {
          filenameTemplate, jpegQuality: quality, tiffBitDepth: 16, keepMetadata: true, preserveTimestamps, stripGps,
          resize: longEdge ? { mode: 'longEdge', value: longEdge, dontEnlarge: true } : null, border: null, pad: null,
          watermark: null, exportMasks: false, preserveFolders: false, destinationType: 'customFolder', subfolder: '',
          fastDenoise: !!(fastDenoise && longEdge),
        },
        outputFormat: format === 'jpeg' ? 'jpg' : format, currentEditPath: null, currentEditAdjustments: null,
      });
      // a photo that needs AI denoise at full size can take minutes; nothing else bounds this but cancel
      const hardLimit = setTimeout(() => rejectDone(new Error('export did not finish within 30 min per photo')), paths.length * 30 * 60 * 1000);
      const how = await done.finally(() => clearTimeout(hardLimit));
      if (how === 'cancelled') throw Object.assign(new Error('Cancelled'), { cancelled: true });
    } finally { exportListeners.delete(listener); }
    return [...results.values()];
  }

  // ---- the pipeline -------------------------------------------------------------------------------------------
  /**
   * spec: { paths, mode, thresholds, adjustments, perPhoto, autoLens, autoTone, aiMasks, export, qa, autoFix, skipDone }
   */
  async function run(ctx, spec) {
    const { paths, mode = 'mixed', thresholds, adjustments, perPhoto = {}, autoLens, autoTone, aiMasks = [], qa = true, autoFix = true } = spec;
    const exp = spec.export;
    const done = new Set(spec.done ?? []);
    const todo = paths.filter((p) => !done.has(p));
    ctx.progress(done.size, paths.length);
    const isos = await exif(todo);
    const iso = (p) => isoOf(isos[p]);
    // background AI work for other photos waits while this runs (resumed at the end)
    let resume = false;
    try { const st = await bridge('get_ai_jobs_status', {}); if (!st?.paused) { await bridge('pause_ai_jobs', {}); resume = true; } } catch { /* older bridge */ }
    const counts = { none: 0, bm3d: 0, ai: 0, keep: 0 };
    const fixes = [];
    const problems = [];
    try {
      // 1. edits that apply to all photos at once
      if (todo.length && adjustments && Object.keys(adjustments).length) { ctx.log(`look patch on ${todo.length} photo(s)`); for (const p of todo) { ctx.checkCancelled(); await patchPhoto(p, adjustments); } }
      if (todo.length && autoLens) { ctx.log('auto lens correction'); await bridge('apply_auto_lens_correction_to_paths', { paths: todo }); }
      if (todo.length && autoTone) {
        ctx.log('auto tone (concert-safe limits by ISO)');
        await bridge('apply_auto_adjustments_to_paths', { paths: todo });
        for (const p of todo) {
          const clamp = clampTone(await load(p), concertLimits(iso(p) ?? 0));
          if (Object.keys(clamp).length) await patchPhoto(p, clamp);
        }
      }
      for (const [p, patch] of Object.entries(perPhoto)) if (todo.includes(p)) await patchPhoto(p, patch);

      // 2. per photo: masks, denoise by noise, export, check, fix
      let i = done.size;
      // noise is compared at the size it is exported at (a smaller export hides noise)
      const edge = Math.min(2048, exp?.longEdge || 2048);
      for (const p of todo) {
        ctx.checkCancelled();
        const t0 = Date.now();
        ctx.progress(i, paths.length, p);
        const r = { path: p, iso: iso(p) };
        try {
          if (aiMasks.length) {
            const containers = aiMasks.map((m) => aiMaskContainer(m, maskDefaults));
            const cur = await load(p);
            await patchPhoto(p, { masks: [...(cur.masks ?? []).filter((m) => !containers.some((c) => c.name === m.name)), ...containers] });
            const [res] = await bridge('rrweb_resolve_ai', { paths: [p], skipDenoise: true });
            if (res && !res.ok) throw new Error(`AI mask: ${res.error}`);
            r.masks = containers.map((c) => c.name);
          }
          let adj = await load(p);
          let before = null;
          if (mode !== 'keep') {
            // "very fast" goes by ISO only; the others measure the photo's noise (one GPU render, ~1-2 s)
            if (mode !== 'none') {
              try { before = await measureSource(p, adj, edge); r.noise = Math.round(before.noise * 100) / 100; } catch (e) { r.measureError = e.message; }
            }
            const d = chooseDenoise(mode, before?.noise, r.iso, thresholds);
            r.denoise = d.method;
            counts[d.method]++;
            const patch = d.method === 'none'
              ? { aiDenoiseEnabled: false, ...(d.colorNoiseReduction ? { colorNoiseReduction: Math.max(adj.colorNoiseReduction ?? 0, d.colorNoiseReduction) } : {}) }
              : { aiDenoiseEnabled: true, aiDenoiseMethod: d.method, aiDenoiseAmount: d.amount };
            adj = await patchPhoto(p, patch);
          } else { r.denoise = adj.aiDenoiseEnabled ? adj.aiDenoiseMethod ?? 'ai' : 'none'; counts.keep++; }

          if (exp) {
            let [out] = await exportPhotos(ctx, [p], exp);
            if (out.error || !out.output) throw new Error(out.error || 'export wrote no file');
            r.output = out.output;
            if (qa) {
              let [m] = await measureFiles([out.output], edge);
              const issues = judge(m, { denoise: r.denoise, before, grain: adj.grainAmount ?? 0 });
              r.qa = { median: round(m.median), whiteClip: round(m.whiteClip), blackClip: round(m.blackClip), noise: round(m.noise), grid: round(m.gridScore), issues: issues.map((x) => x.kind) };
              const patch = autoFix ? issues.map((x) => fixFor(x, adj, m)).filter(Boolean).reduce((a, b) => ({ ...a, ...b }), {}) : {};
              if (Object.keys(patch).length) {
                ctx.log(`${path.basename(p)}: ${issues.map((x) => x.kind).join(', ')} → fixing and exporting again`);
                adj = await patchPhoto(p, patch);
                await fsp.rm(out.output, { force: true });
                [out] = await exportPhotos(ctx, [p], exp);
                if (out.error || !out.output) throw new Error(out.error || 'export wrote no file');
                r.output = out.output;
                [m] = await measureFiles([out.output], edge);
                const after = judge(m, { denoise: adj.aiDenoiseEnabled ? adj.aiDenoiseMethod : 'none', before, grain: adj.grainAmount ?? 0 });
                fixes.push({ path: p, issues: issues.map((x) => `${x.kind}: ${x.detail}`), patch, remaining: after.map((x) => x.kind) });
                r.fixed = patch;
                r.qa.after = after.map((x) => x.kind);
                if (after.length) problems.push({ path: p, issues: after.map((x) => `${x.kind}: ${x.detail}`) });
              } else if (issues.length) problems.push({ path: p, issues: issues.map((x) => `${x.kind}: ${x.detail}`) });
            }
          }
          r.ok = true;
          // learn this server's speed per method, for the estimates offered next time
          if (exp && r.denoise) {
            const s = (Date.now() - t0) / 1000;
            const k = r.denoise === 'keep' ? null : r.denoise;
            if (k) { stats[k] = stats[k] ? Math.round((stats[k] * 0.8 + s * 0.2) * 10) / 10 : Math.round(s * 10) / 10; saveStats(); }
          }
        } catch (e) {
          if (e?.cancelled) throw e;
          r.ok = false;
          r.error = e.message ?? String(e);
          ctx.log(`${path.basename(p)} failed: ${r.error}`);
        }
        r.seconds = Math.round((Date.now() - t0) / 1000);
        ctx.result(r);
        (spec.done ??= []).push(p);
        notifyTab([p]);
        ctx.progress(++i, paths.length, null);
      }
    } finally {
      if (resume) bridge('resume_ai_jobs', {}).catch(() => {});
    }
    return { photos: paths.length, denoise: counts, exported: ctx.job.results.filter((r) => r.output).length, fixes, problems,
      failed: ctx.job.results.filter((r) => r.ok === false).map((r) => ({ path: r.path, error: r.error })) };
  }

  /** Noise of every photo, what each mode would do with it and how long each mode would take */
  async function analyze(ctx, { paths, thresholds }) {
    const isos = await exif(paths);
    const out = [];
    let i = 0;
    for (const p of paths) {
      ctx.checkCancelled();
      ctx.progress(i, paths.length, p);
      const iso = isoOf(isos[p]);
      let m = null;
      try { m = await measureSource(p); } catch (e) { ctx.log(`${path.basename(p)}: ${e.message}`); }
      const r = { path: p, iso, noise: m ? round(m.noise) : null, median: m ? round(m.median) : null };
      for (const mode of ['bm3d', 'mixed', 'ai']) r[mode] = chooseDenoise(mode, m?.noise, iso, thresholds).method;
      out.push(r);
      ctx.result(r);
      ctx.progress(++i, paths.length, null);
    }
    return { photos: paths.length, modes: estimates(out), thresholds: { ...NOISE, ...thresholds } };
  }

  function estimates(rows) {
    const sec = { ...DEFAULT_SECONDS, ...stats };
    const per = (mode) => rows.reduce((s, r) => s + sec[mode === 'none' ? 'none' : (r[mode] ?? 'none')], 0);
    const fmt = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
    return Object.fromEntries(Object.keys(MODES).map((mode) => {
      const s = per(mode);
      const split = mode === 'none' ? { none: rows.length } : rows.reduce((a, r) => ({ ...a, [r[mode]]: (a[r[mode]] ?? 0) + 1 }), {});
      return [mode, { description: MODES[mode], estimate: fmt(s), seconds: Math.round(s), denoise: split }];
    }));
  }

  return { onEvent, run, analyze, exportPhotos, measureFiles, measureSource, patchPhoto, load, estimates, exif };
}

const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
