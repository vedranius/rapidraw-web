import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { Adjustments, INITIAL_ADJUSTMENTS, INITIAL_MASK_ADJUSTMENTS } from '../utils/adjustments';
import { CullingSuggestions, Invokes, Preset, StyleProfile } from '../components/ui/AppProperties';
import { Status } from '../components/ui/ExportImportProperties';
import { useEditorStore } from '../store/useEditorStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useProcessStore } from '../store/useProcessStore';
import { useUIStore } from '../store/useUIStore';
import { globalImageCache } from '../utils/ImageLRUCache';
import { calculateCenteredCrop } from '../utils/cropUtils';
import { withRotation } from '../hooks/useEditorActions';
import { Mask, SubMaskMode } from '../components/panel/right/Masks';
import type { AgentExecutionHooks, AgentStepResult } from './types';
import { computeHistogramFromUrl } from './context';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KNOWN_ADJUSTMENT_KEYS = new Set(Object.keys(INITIAL_ADJUSTMENTS));
const KNOWN_MASK_KEYS = new Set(Object.keys(INITIAL_MASK_ADJUSTMENTS));

function assertKnownMaskKeys(patch: Record<string, unknown>): void {
  const unknown = Object.keys(patch).filter((key) => !KNOWN_MASK_KEYS.has(key));
  if (unknown.length === 0) return;
  throw new Error(
    `Unknown local mask adjustment key(s): ${unknown.join(', ')}. Use tone, colour, detail or effects keys only.`,
  );
}

function assertKnownAdjustmentKeys(patch: Record<string, unknown>): void {
  const unknown = Object.keys(patch).filter((key) => !KNOWN_ADJUSTMENT_KEYS.has(key));
  if (unknown.length === 0) return;
  const suggestion = unknown.includes('texture') ? ' RapidRAW calls texture "structure".' : '';
  throw new Error(
    `Unknown RapidRAW adjustment key(s): ${unknown.join(', ')}.${suggestion} ` +
      'Use settings.patch only with keys from the command reference, or map the intent to an existing control.',
  );
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `rr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge settings like the backend does: objects merge, arrays/primitives replace. */
export function mergeAdjustmentPatch<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(next[key])) {
      next[key] = mergeAdjustmentPatch(next[key] as Record<string, unknown>, value);
    } else {
      next[key] = clone(value);
    }
  }
  return next as T;
}

function dottedSet(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('The adjustment path is empty.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = clone(value);
}

function pathsFrom(params: Record<string, unknown>, hooks: AgentExecutionHooks): string[] {
  const requested = Array.isArray(params.paths)
    ? (params.paths as unknown[]).filter((path): path is string => typeof path === 'string' && path.length > 0)
    : [];
  if (requested.length > 0) return requested;
  if (typeof params.path === 'string' && params.path.length > 0) return [params.path];
  if (hooks.targetPaths.length > 0) return hooks.targetPaths;
  const selected = useEditorStore.getState().selectedImage?.path;
  return selected ? [selected] : [];
}

function firstPath(params: Record<string, unknown>, hooks: AgentExecutionHooks): string {
  const paths = pathsFrom(params, hooks);
  if (paths.length === 0) throw new Error('Select at least one photo first.');
  return paths[0];
}

async function waitForSelected(path: string, timeoutMs = 20000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = useEditorStore.getState();
    if (state.selectedImage?.path === path && state.selectedImage.isReady) return;
    await sleep(120);
  }
  throw new Error(`The photo did not finish loading: ${path}`);
}

async function waitForSelectedSoft(path: string, timeoutMs = 20000): Promise<void> {
  await waitForSelected(path, timeoutMs).catch(() => {
    // A very large TIFF can take longer than expected. The file is already
    // saved, so later steps can still address it by path.
  });
}

async function ensureSelectedPath(path: string, hooks: AgentExecutionHooks): Promise<void> {
  if (useEditorStore.getState().selectedImage?.path === path) return;
  hooks.selectImage(path);
  await waitForSelected(path);
}

function markCachesDirty(paths: string[]): void {
  paths.forEach((path) => globalImageCache.delete(path));
}

async function saveLiveAdjustments(path: string, adjustments: Adjustments): Promise<void> {
  await invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path, adjustments });
}

async function applySettingsPatch(patch: Record<string, unknown>, paths: string[]): Promise<string> {
  if (paths.length === 0) throw new Error('No photo is selected.');
  assertKnownAdjustmentKeys(patch);
  const selected = useEditorStore.getState().selectedImage;
  const selectedIncluded = !!selected && paths.includes(selected.path);
  let liveMessage = '';

  if (selectedIncluded) {
    const state = useEditorStore.getState();
    const next = mergeAdjustmentPatch(
      state.adjustments as unknown as Record<string, unknown>,
      patch,
    ) as unknown as Adjustments;
    state.setEditor({ adjustments: next, showOriginal: false, previewOverride: null });
    state.pushHistory(next);
    await saveLiveAdjustments(selected.path, next);
    liveMessage = `Updated ${selected.path.split(/[\\/]/).pop()}. `;
  }

  const otherPaths = selected ? paths.filter((path) => path !== selected.path) : paths;
  if (otherPaths.length > 0) {
    await invoke(Invokes.ApplyAdjustmentsToPaths, { paths: otherPaths, adjustments: patch });
  }
  markCachesDirty(paths);
  return `${liveMessage}${otherPaths.length > 0 ? `Applied to ${otherPaths.length} more photo(s).` : 'Saved.'}`;
}

async function reloadPaths(paths: string[], hooks: AgentExecutionHooks): Promise<void> {
  markCachesDirty(paths);
  await hooks.reloadAdjustments(paths);
}

async function generateAiMaskParameters(
  type: string,
  selectedPath: string,
  dimensions: { width: number; height: number },
  params: Record<string, unknown>,
): Promise<unknown> {
  const adjustments = useEditorStore.getState().adjustments;
  const transformAdjustments = {
    ...adjustments,
    rotation: adjustments.rotation || 0,
    orientationSteps: adjustments.orientationSteps || 0,
    crop: adjustments.crop || null,
  };
  const base = {
    jsAdjustments: transformAdjustments,
    flipHorizontal: !!adjustments.flipHorizontal,
    flipVertical: !!adjustments.flipVertical,
    orientationSteps: adjustments.orientationSteps || 0,
    rotation: adjustments.rotation || 0,
    path: selectedPath,
    taskId: `agent-mask-${Date.now()}`,
  };
  if (type === 'subject') {
    const start = [Math.max(0, dimensions.width * 0.02), Math.max(0, dimensions.height * 0.02)];
    const end = [dimensions.width * 0.98, dimensions.height * 0.98];
    return invoke(Invokes.GenerateAiSubjectMask, { ...base, startPoint: start, endPoint: end, skipRefinement: false });
  }
  if (type === 'sky') return invoke(Invokes.GenerateAiSkyMask, base);
  if (type === 'foreground') return invoke(Invokes.GenerateAiForegroundMask, base);
  return invoke('generate_ai_depth_mask', {
    ...base,
    minDepth: Number(params.minDepth ?? 20),
    maxDepth: Number(params.maxDepth ?? 100),
    minFade: Number(params.minFade ?? 15),
    maxFade: Number(params.maxFade ?? 15),
    feather: Number(params.feather ?? 10),
  });
}

function maskType(type: string): Mask {
  if (type === 'sky') return Mask.AiSky;
  if (type === 'foreground') return Mask.AiForeground;
  if (type === 'depth') return Mask.AiDepth;
  return Mask.AiSubject;
}

function withMaskDefaults(patch: Record<string, unknown>): Record<string, unknown> {
  return mergeAdjustmentPatch(clone(INITIAL_MASK_ADJUSTMENTS) as unknown as Record<string, unknown>, patch);
}

function ratioToNumber(ratio: string | undefined): number | null {
  if (!ratio) return null;
  const normalized = ratio.toLowerCase().trim().replace('×', ':');
  if (normalized === 'original' || normalized === 'izvorno') return 0;
  if (normalized === 'square' || normalized === 'kvadrat') return 1;
  const match = normalized.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return width / height;
}

async function readSelectedPathOrThrow(): Promise<string> {
  const selected = useEditorStore.getState().selectedImage;
  if (!selected) throw new Error('Open a photo in the editor first.');
  return selected.path;
}

async function snapshotPaths(paths: string[]) {
  return invoke('snapshot_sidecars', { paths });
}

export { snapshotPaths };

/**
 * Execute one safe, auditable agent command against the live RapidRAW state.
 */
export async function executeAgentStep(
  tool: string,
  params: Record<string, unknown>,
  hooks: AgentExecutionHooks,
): Promise<Omit<AgentStepResult, 'startedAt' | 'finishedAt'>> {
  const selected = useEditorStore.getState().selectedImage;

  switch (tool) {
    case 'photo.inspect': {
      const path = selected?.path || hooks.targetPaths[0] || 'none';
      const histogram = await computeHistogramFromUrl(
        useEditorStore.getState().finalPreviewUrl || selected?.thumbnailUrl || null,
      );
      return {
        tool,
        ok: true,
        message: selected
          ? `Inspected ${path.split(/[\\/]/).pop()} (${selected.width}×${selected.height}).`
          : 'No photo is open; using the current selection.',
        data: {
          path,
          selectedPaths: hooks.targetPaths,
          width: selected?.width,
          height: selected?.height,
          isRaw: selected?.isRaw,
          exif: selected?.exif,
          adjustments: useEditorStore.getState().adjustments,
          histogram,
        },
      };
    }

    case 'photo.select': {
      const path = String(params.path || '');
      if (!path) throw new Error('A file path is required.');
      hooks.selectImage(path);
      await waitForSelected(path);
      // A deliberate photo.select narrows the working target. Later steps
      // should act on the photo the user named, not on the old multi-selection.
      hooks.targetPaths = [path];
      return { tool, ok: true, message: `Opened ${path.split(/[\\/]/).pop()}.`, data: { path } };
    }

    case 'photo.histogram': {
      const histogram = await computeHistogramFromUrl(
        useEditorStore.getState().finalPreviewUrl || selected?.thumbnailUrl || null,
      );
      if (!histogram) throw new Error('The preview histogram is not available yet.');
      return {
        tool,
        ok: true,
        message: histogram.warning
          ? `Median ${histogram.median.toFixed(2)}, ${histogram.warning.toLowerCase()}`
          : `Exposure OK: median ${histogram.median.toFixed(2)}, highlights clipped ${(histogram.highlightClip * 100).toFixed(1)}%.`,
        data: histogram,
      };
    }

    case 'settings.patch': {
      const patch = (params.patch ?? params.settings ?? {}) as Record<string, unknown>;
      if (!isObject(patch) || Object.keys(patch).length === 0) throw new Error('The settings patch is empty.');
      const paths = pathsFrom(params, hooks);
      const message = await applySettingsPatch(patch, paths);
      return { tool, ok: true, message, data: { paths, keys: Object.keys(patch) } };
    }

    case 'settings.set': {
      const path = String(params.path || '');
      if (!path) throw new Error('A dotted adjustment path is required.');
      assertKnownAdjustmentKeys({ [path.split('.')[0]]: true });
      const patch: Record<string, unknown> = {};
      dottedSet(patch, path, params.value);
      const paths = pathsFrom(params, hooks);
      const message = await applySettingsPatch(patch, paths);
      return { tool, ok: true, message, data: { path, value: params.value } };
    }

    case 'settings.reset': {
      const paths = pathsFrom(params, hooks);
      const section = String(params.section || 'all').toLowerCase();
      if (section === 'all') {
        await invoke(Invokes.ResetAdjustmentsForPaths, { paths });
        await reloadPaths(paths, hooks);
        return { tool, ok: true, message: `Reset all edits on ${paths.length} photo(s).`, data: { paths } };
      }
      const sections: Record<string, string[]> = {
        basic: [
          'exposure',
          'brightness',
          'contrast',
          'highlights',
          'shadows',
          'whites',
          'blacks',
          'toneMapper',
          'baselineExposure',
        ],
        color: [
          'temperature',
          'tint',
          'vibrance',
          'saturation',
          'hue',
          'hsl',
          'colorGrading',
          'colorCalibration',
          'whiteBalance',
        ],
        curves: ['curves', 'pointCurves', 'parametricCurve', 'curveMode'],
        details: [
          'clarity',
          'dehaze',
          'structure',
          'lumaNoiseReduction',
          'colorNoiseReduction',
          'sharpness',
          'sharpnessThreshold',
          'chromaticAberrationRedCyan',
          'chromaticAberrationBlueYellow',
        ],
        effects: [
          'grainAmount',
          'grainSize',
          'grainRoughness',
          'vignetteAmount',
          'vignetteMidpoint',
          'vignetteFeather',
          'vignetteRoundness',
          'vignetteCenterX',
          'vignetteCenterY',
          'glowAmount',
          'halationAmount',
          'flareAmount',
          'lutData',
          'lutName',
          'lutPath',
          'lutSize',
          'lutIntensity',
          'lensBlurEnabled',
          'relightEnabled',
          'fogEnabled',
        ],
        geometry: [
          'crop',
          'aspectRatio',
          'rotation',
          'orientationSteps',
          'flipHorizontal',
          'flipVertical',
          'transformDistortion',
          'transformVertical',
          'transformHorizontal',
          'transformRotate',
          'transformAspect',
          'transformScale',
          'transformXOffset',
          'transformYOffset',
          'guidedPerspective',
        ],
        masks: ['masks', 'aiPatches'],
      };
      const keys = sections[section];
      if (!keys) throw new Error(`Unknown section "${section}".`);
      const patch = Object.fromEntries(
        keys.map((key) => [key, clone((INITIAL_ADJUSTMENTS as unknown as Record<string, unknown>)[key])]),
      );
      await applySettingsPatch(patch, paths);
      return { tool, ok: true, message: `Reset ${section} on ${paths.length} photo(s).`, data: { paths, section } };
    }

    case 'photo.auto-tone': {
      const paths = pathsFrom(params, hooks);
      const selectedPath = selected?.path;
      if (selectedPath && paths.length === 1 && paths[0] === selectedPath) {
        const results = await invoke<Record<string, unknown>>(Invokes.CalculateAutoAdjustments, {
          jsAdjustments: useEditorStore.getState().adjustments,
        });
        const message = await applySettingsPatch(results, paths);
        return { tool, ok: true, message: `Auto tone applied. ${message}`, data: results };
      }
      await invoke(Invokes.ApplyAutoAdjustmentsToPaths, { paths });
      await reloadPaths(paths, hooks);
      return { tool, ok: true, message: `Auto tone applied to ${paths.length} photo(s).`, data: { paths } };
    }

    case 'photo.auto-straighten': {
      const paths = pathsFrom(params, hooks);
      const selectedPath = selected?.path;
      if (selectedPath && paths.includes(selectedPath)) {
        const rotation = await invoke<number | null>(Invokes.CalculateAutoStraighten, {
          jsAdjustments: useEditorStore.getState().adjustments,
        });
        if (rotation === null || Math.abs(rotation) < 0.01) {
          return { tool, ok: true, message: 'No horizon to correct; the photo is already level.' };
        }
        const state = useEditorStore.getState();
        const next = withRotation(state.adjustments, state.selectedImage, rotation);
        state.setEditor({ adjustments: next });
        state.pushHistory(next);
        await saveLiveAdjustments(selectedPath, next);
        markCachesDirty([selectedPath]);
        return { tool, ok: true, message: `Straightened by ${rotation.toFixed(2)}°.` };
      }
      await invoke(Invokes.ApplyAutoStraightenToPaths, { paths });
      await reloadPaths(paths, hooks);
      return { tool, ok: true, message: `Auto straighten applied to ${paths.length} photo(s).` };
    }

    case 'photo.auto-lens': {
      const paths = pathsFrom(params, hooks);
      await invoke('apply_auto_lens_correction_to_paths', { paths });
      await reloadPaths(paths, hooks);
      return { tool, ok: true, message: `Lens profile applied to ${paths.length} photo(s).`, data: { paths } };
    }

    case 'photo.crop': {
      const path = firstPath(params, hooks);
      await ensureSelectedPath(path, hooks);
      const state = useEditorStore.getState();
      const image = state.selectedImage;
      if (!image) throw new Error('The photo is not loaded.');
      const ratioParam = String(params.ratio || '');
      const aspectRatio = ratioToNumber(ratioParam);
      const rotation = params.rotation !== undefined ? Number(params.rotation) : state.adjustments.rotation || 0;
      const orientationSteps =
        params.orientationSteps !== undefined
          ? ((Number(params.orientationSteps) % 4) + 4) % 4
          : state.adjustments.orientationSteps || 0;
      const patch: Record<string, unknown> = { rotation, orientationSteps };
      if (aspectRatio !== null) {
        patch.aspectRatio = aspectRatio;
        patch.crop =
          aspectRatio === 0
            ? null
            : calculateCenteredCrop(image.width, image.height, orientationSteps, aspectRatio, rotation);
      }
      const message = await applySettingsPatch(patch, [path]);
      return {
        tool,
        ok: true,
        message: ratioParam ? `Cropped to ${ratioParam}. ${message}` : `Geometry updated. ${message}`,
        data: { path, aspectRatio, rotation, orientationSteps },
      };
    }

    case 'photo.flip': {
      const path = firstPath(params, hooks);
      await ensureSelectedPath(path, hooks);
      const axis = String(params.axis || 'horizontal').toLowerCase();
      const state = useEditorStore.getState();
      const patch =
        axis === 'vertical'
          ? { flipVertical: !state.adjustments.flipVertical }
          : { flipHorizontal: !state.adjustments.flipHorizontal };
      const message = await applySettingsPatch(patch, [path]);
      return { tool, ok: true, message: `Flipped ${axis}. ${message}` };
    }

    case 'photo.ai-mask': {
      const path = firstPath(params, hooks);
      await ensureSelectedPath(path, hooks);
      const state = useEditorStore.getState();
      const image = state.selectedImage;
      if (!image) throw new Error('The photo is not loaded.');
      const type = String(params.type || 'subject').toLowerCase();
      const maskPatch = (params.patch ?? {}) as Record<string, unknown>;
      assertKnownMaskKeys(maskPatch);
      const parameters = await generateAiMaskParameters(
        type,
        path,
        { width: image.width, height: image.height },
        params,
      );
      const subMaskId = uuid();
      const container = {
        id: uuid(),
        name: String(params.name || `AI ${type}`),
        opacity: Number(params.opacity ?? 100),
        visible: true,
        invert: false,
        subMasks: [
          {
            id: subMaskId,
            name: String(params.name || type),
            type: maskType(type),
            mode: SubMaskMode.Additive,
            opacity: 100,
            visible: true,
            invert: false,
            parameters,
          },
        ],
        adjustments: withMaskDefaults(maskPatch),
      };
      const current = state.adjustments;
      const next = { ...current, masks: [...(current.masks || []), container] } as Adjustments;
      state.setEditor({ adjustments: next });
      state.pushHistory(next);
      await saveLiveAdjustments(path, next);
      markCachesDirty([path]);
      return {
        tool,
        ok: true,
        message: `Added a local ${type} mask with ${Object.keys(maskPatch).length || 0} adjustment(s).`,
        data: { path, mask: container.name },
      };
    }

    case 'photo.mask-adjust': {
      const path = firstPath(params, hooks);
      await ensureSelectedPath(path, hooks);
      const state = useEditorStore.getState();
      const identifier = String(params.mask || '');
      const patch = (params.patch ?? {}) as Record<string, unknown>;
      assertKnownMaskKeys(patch);
      const masks = clone(state.adjustments.masks || []);
      const existing = masks.find((mask) => mask.id === identifier || mask.name === identifier);
      if (existing) {
        existing.adjustments = mergeAdjustmentPatch(
          existing.adjustments as unknown as Record<string, unknown>,
          patch,
        ) as typeof existing.adjustments;
      } else {
        masks.push({
          id: uuid(),
          name: identifier || 'Local adjustment',
          opacity: 100,
          visible: true,
          invert: false,
          subMasks: [
            {
              id: uuid(),
              type: Mask.All,
              mode: SubMaskMode.Additive,
              opacity: 100,
              visible: true,
              invert: false,
              parameters: {},
            },
          ],
          adjustments: withMaskDefaults(patch) as unknown as (typeof masks)[number]['adjustments'],
        });
      }
      const next = { ...state.adjustments, masks } as Adjustments;
      state.setEditor({ adjustments: next });
      state.pushHistory(next);
      await saveLiveAdjustments(path, next);
      markCachesDirty([path]);
      return {
        tool,
        ok: true,
        message: existing ? `Updated mask "${identifier}".` : `Created whole-image mask "${identifier}".`,
      };
    }

    case 'photo.ai-lens-blur':
    case 'photo.ai-relight':
    case 'photo.ai-fog': {
      const path = firstPath(params, hooks);
      await ensureSelectedPath(path, hooks);
      const state = useEditorStore.getState();
      const patch: Record<string, unknown> = {};
      if (tool === 'photo.ai-lens-blur') {
        patch.lensBlurEnabled = true;
        if (!state.adjustments.lensBlurDepthMap) {
          patch.lensBlurDepthMap = await invoke<string>('generate_full_image_depth_map');
        }
        if (params.amount !== undefined) patch.lensBlurAmount = Number(params.amount);
        if (params.shape) patch.lensBlurShape = params.shape;
        if (params.minDepth !== undefined) patch.lensBlurMinDepth = Number(params.minDepth);
        if (params.maxDepth !== undefined) patch.lensBlurMaxDepth = Number(params.maxDepth);
      } else if (tool === 'photo.ai-relight') {
        patch.relightEnabled = true;
        if (!state.adjustments.relightNormalMap) {
          patch.relightNormalMap = await invoke<string>('generate_relight_normal_map');
        }
        if (params.ambient !== undefined) patch.relightAmbient = Number(params.ambient);
        if (params.softness !== undefined) patch.relightSoftness = Number(params.softness);
        if (params.shine !== undefined) patch.relightShine = Number(params.shine);
      } else {
        patch.fogEnabled = true;
        if (!state.adjustments.fogDepthMap) {
          patch.fogDepthMap = await invoke<string>('generate_full_image_depth_map');
        }
        if (params.amount !== undefined) patch.fogAmount = Number(params.amount);
        if (params.start !== undefined) patch.fogStart = Number(params.start);
        if (params.density !== undefined) patch.fogDensity = Number(params.density);
        if (params.glow !== undefined) patch.fogGlow = Number(params.glow);
        if (params.temperature !== undefined) patch.fogTemperature = Number(params.temperature);
      }
      const message = await applySettingsPatch(patch, [path]);
      return { tool, ok: true, message: `${tool.split('.').pop()} enabled. ${message}` };
    }

    case 'photo.denoise': {
      const paths = pathsFrom(params, hooks);
      const rawIntensity = Number(params.intensity ?? 45);
      const intensity = rawIntensity > 1 ? rawIntensity / 100 : rawIntensity;
      const method = String(params.method || 'ai').toLowerCase();
      // `batch_denoise_images` writes the new TIFF/PNG copies and returns their
      // paths, so the agent does not need to drive the interactive modal.
      const saved: string[] = await invoke('batch_denoise_images', { paths, intensity, method });
      if (saved.length === 0 && paths.length > 0) {
        throw new Error('Denoising did not produce a file. Check the AI model status and the log.');
      }
      await hooks.refreshLibrary();
      if (saved[0]) {
        hooks.selectImage(saved[0]);
        await waitForSelectedSoft(saved[0]);
      }
      return {
        tool,
        ok: true,
        message: `Denoised ${saved.length}/${paths.length} photo(s)${saved[0] ? `; saved ${saved[0].split(/[\\/]/).pop()}` : ''}.`,
        data: { saved },
      };
    }

    case 'photo.hdr': {
      const paths = pathsFrom(params, hooks);
      if (paths.length < 2) throw new Error('HDR needs at least two exposure-bracketed frames.');
      await invoke(Invokes.MergeHdr, { paths });
      const saved: string = await invoke(Invokes.SaveHdr, { firstPathStr: paths[0] });
      await hooks.refreshLibrary();
      hooks.selectImage(saved);
      await waitForSelectedSoft(saved);
      return { tool, ok: true, message: `HDR merged and saved as ${saved.split(/[\\/]/).pop()}.`, data: { saved } };
    }

    case 'photo.panorama': {
      const paths = pathsFrom(params, hooks);
      if (paths.length < 2) throw new Error('Panorama needs at least two overlapping frames.');
      await invoke(Invokes.StitchPanorama, { paths });
      const saved: string = await invoke(Invokes.SavePanorama, { firstPathStr: paths[0] });
      await hooks.refreshLibrary();
      hooks.selectImage(saved);
      await waitForSelectedSoft(saved);
      return { tool, ok: true, message: `Panorama saved as ${saved.split(/[\\/]/).pop()}.`, data: { saved } };
    }

    case 'photo.focus-stack': {
      const paths = pathsFrom(params, hooks);
      if (paths.length < 2) throw new Error('Focus stacking needs at least two frames.');
      await invoke(Invokes.StitchFocusStack, { paths });
      const saved: string = await invoke(Invokes.SaveFocusStack, { firstPathStr: paths[0] });
      await hooks.refreshLibrary();
      hooks.selectImage(saved);
      await waitForSelectedSoft(saved);
      return { tool, ok: true, message: `Focus stack saved as ${saved.split(/[\\/]/).pop()}.`, data: { saved } };
    }

    case 'photo.negative': {
      const paths = pathsFrom(params, hooks);
      const saved: string[] = await invoke('convert_negatives', {
        paths,
        params: { red_weight: 1, green_weight: 1, blue_weight: 1, exposure: 0, contrast: 1 },
      });
      await hooks.refreshLibrary();
      if (saved[0]) {
        hooks.selectImage(saved[0]);
        await waitForSelectedSoft(saved[0]);
      }
      return { tool, ok: true, message: `Converted ${saved.length} negative(s).`, data: { saved } };
    }

    case 'photo.style-profile': {
      const paths = pathsFrom(params, hooks);
      const profiles: StyleProfile[] = await invoke(Invokes.ListStyleProfiles);
      const wantedName = String(params.name || '').toLowerCase();
      const wantedId = String(params.id || '');
      const profile = profiles.find(
        (entry) => (wantedId && entry.id === wantedId) || (wantedName && entry.name.toLowerCase() === wantedName),
      );
      if (!profile) {
        throw new Error(`Style profile "${params.name || params.id}" was not found.`);
      }
      await invoke(Invokes.ApplyStyleProfileToPaths, {
        paths,
        profileId: profile.id,
        intensity: params.intensity !== undefined ? Number(params.intensity) : null,
      });
      await reloadPaths(paths, hooks);
      await hooks.refreshLibrary();
      return {
        tool,
        ok: true,
        message: `Applied "${profile.name}" to ${paths.length} photo(s).`,
        data: { profile: profile.name },
      };
    }

    case 'photo.prompt-style': {
      const paths = pathsFrom(params, hooks);
      const prompt = String(params.prompt || '').trim();
      if (!prompt) throw new Error('Describe the look in words first.');
      const candidates: StyleProfile[] = await invoke(Invokes.GenerateStyleCandidates, {
        prompt,
        useAi: params.useAi !== false,
      });
      if (!candidates.length) throw new Error('The look generator returned no candidates.');
      const variant = String(params.variant || 'Balanced').toLowerCase();
      const profile =
        candidates.find((entry) => entry.name.toLowerCase().endsWith(variant)) ||
        candidates.find((entry) => entry.name.toLowerCase().includes(variant)) ||
        candidates[0];
      await invoke(Invokes.ApplyCustomStyleProfile, {
        paths,
        profile,
        intensity: params.intensity !== undefined ? Number(params.intensity) : null,
      });
      await reloadPaths(paths, hooks);
      await hooks.refreshLibrary();
      return {
        tool,
        ok: true,
        message: `Generated and applied "${profile.name}" to ${paths.length} photo(s).`,
        data: { profile: profile.name, candidates: candidates.map((entry) => entry.name) },
      };
    }

    case 'photo.lut': {
      const path = firstPath(params, hooks);
      await ensureSelectedPath(path, hooks);
      const lutPath = String(params.path || '');
      if (!lutPath) throw new Error('A LUT path is required.');
      const result = await invoke<{ size: number }>('load_and_parse_lut', { path: lutPath });
      const patch = {
        lutPath,
        lutName: lutPath.split(/[\\/]/).pop() || 'LUT',
        lutSize: result.size,
        lutIntensity: params.intensity !== undefined ? Number(params.intensity) : 100,
        lutIsSceneReferred: false,
      };
      const message = await applySettingsPatch(patch, [path]);
      return { tool, ok: true, message: `Loaded LUT. ${message}` };
    }

    case 'photo.preset': {
      const paths = pathsFrom(params, hooks);
      const presets: Array<{ preset?: Preset; folder?: { children?: Preset[] } }> = await invoke(Invokes.LoadPresets);
      const flattened: Preset[] = [];
      const collectPresets = (entries: Array<{ preset?: Preset; folder?: { children?: unknown } }>) => {
        for (const entry of entries) {
          if (entry.preset) flattened.push(entry.preset);
          const children = entry.folder?.children;
          if (Array.isArray(children)) collectPresets(children as typeof entries);
        }
      };
      collectPresets(presets);
      const wantedName = String(params.name || '').toLowerCase();
      const wantedId = String(params.id || '');
      const preset = flattened.find(
        (entry) => (wantedId && entry.id === wantedId) || (wantedName && entry.name.toLowerCase() === wantedName),
      );
      if (!preset) throw new Error(`Preset "${params.name || params.id}" was not found.`);
      const message = await applySettingsPatch(preset.adjustments as unknown as Record<string, unknown>, paths);
      return { tool, ok: true, message: `Applied preset "${preset.name}". ${message}` };
    }

    case 'photo.copy-settings': {
      const source = selected;
      if (!source) throw new Error('Open the source photo first.');
      const paths = pathsFrom(params, hooks).filter((path) => path !== source.path);
      if (paths.length === 0) throw new Error('Choose at least one destination photo.');
      const adjustments = clone(useEditorStore.getState().adjustments) as Record<string, unknown>;
      // Geometry and masks are composition decisions. Copy them only when the
      // request explicitly asks for them; otherwise a batch sync can silently
      // crop every frame like the source.
      if (params.includeMasks !== true) {
        adjustments.masks = [];
        adjustments.aiPatches = [];
      }
      if (params.includeCrop !== true) {
        delete adjustments.crop;
        delete adjustments.aspectRatio;
        delete adjustments.rotation;
        delete adjustments.orientationSteps;
        delete adjustments.flipHorizontal;
        delete adjustments.flipVertical;
        delete adjustments.transformDistortion;
        delete adjustments.transformVertical;
        delete adjustments.transformHorizontal;
        delete adjustments.transformRotate;
        delete adjustments.transformAspect;
        delete adjustments.transformScale;
        delete adjustments.transformXOffset;
        delete adjustments.transformYOffset;
        delete adjustments.guidedPerspective;
      }
      await invoke(Invokes.ApplyAdjustmentsToPaths, { paths, adjustments });
      markCachesDirty(paths);
      return { tool, ok: true, message: `Copied settings to ${paths.length} photo(s).`, data: { paths } };
    }

    case 'library.rate': {
      const paths = pathsFrom(params, hooks);
      const rating = Math.max(0, Math.min(5, Number(params.rating ?? 0)));
      await invoke(Invokes.SetRatingForPaths, { paths, rating });
      await hooks.refreshLibrary();
      return { tool, ok: true, message: `Rated ${paths.length} photo(s) ${rating} star(s).` };
    }

    case 'library.flag': {
      const paths = pathsFrom(params, hooks);
      const flag = params.flag === null || params.flag === 'null' ? null : String(params.flag || 'pick');
      await invoke(Invokes.SetFlagForPaths, { paths, flag });
      await hooks.refreshLibrary();
      return { tool, ok: true, message: `Set flag ${flag || 'none'} on ${paths.length} photo(s).` };
    }

    case 'library.color': {
      const paths = pathsFrom(params, hooks);
      const color = params.color === null || params.color === 'null' ? null : String(params.color || '');
      await invoke(Invokes.SetColorLabelForPaths, { paths, color });
      await hooks.refreshLibrary();
      return { tool, ok: true, message: `Set colour label ${color || 'none'} on ${paths.length} photo(s).` };
    }

    case 'library.tag': {
      const paths = pathsFrom(params, hooks);
      const tags = Array.isArray(params.tags) ? params.tags.map(String) : [];
      const remove = Array.isArray(params.remove) ? params.remove.map(String) : [];
      for (const tag of tags) {
        await invoke(Invokes.AddTagForPaths, { paths, tag });
      }
      for (const tag of remove) {
        await invoke(Invokes.RemoveTagForPaths, { paths, tag });
      }
      await hooks.refreshLibrary();
      return {
        tool,
        ok: true,
        message: `Updated tags on ${paths.length} photo(s): +${tags.length} / -${remove.length}.`,
      };
    }

    case 'library.exif': {
      const paths = pathsFrom(params, hooks);
      const fields = (params.fields ?? {}) as Record<string, string>;
      if (!isObject(fields) || Object.keys(fields).length === 0) throw new Error('Provide at least one EXIF field.');
      await invoke(Invokes.UpdateExifFields, { paths, updates: fields });
      await hooks.refreshLibrary();
      return {
        tool,
        ok: true,
        message: `Updated ${Object.keys(fields).length} EXIF field(s) on ${paths.length} photo(s).`,
      };
    }

    case 'library.cull': {
      const paths = pathsFrom(params, hooks);
      const suggestions = await invoke(Invokes.CullImages, {
        paths,
        settings: {
          groupSimilar: true,
          similarityThreshold: Number(params.similarityThreshold ?? 28),
          filterBlurry: true,
          blurThreshold: Number(params.blurThreshold ?? params.minSharpness ?? 100),
        },
      });
      const groups = (suggestions as { similarGroups?: unknown[] })?.similarGroups?.length || 0;
      const blurry = (suggestions as { blurryImages?: unknown[] })?.blurryImages?.length || 0;
      // Show the same rich review dialog the manual culling workflow uses.
      // The agent does not apply rejects on its own; the photographer decides.
      useUIStore.getState().setUI({
        cullingModalState: {
          isOpen: true,
          suggestions: suggestions as CullingSuggestions,
          progress: null,
          error: null,
          pathsToCull: paths,
        },
      });
      return {
        tool,
        ok: true,
        message: `Culling analysed ${paths.length} photo(s): ${groups} similar group(s), ${blurry} soft frame(s). Review the suggestions in the culling dialog.`,
        data: suggestions,
      };
    }

    case 'library.export': {
      const unknown = Object.keys(params).filter(
        (key) => !['outputFolder', 'format', 'quality', 'longEdge', 'paths'].includes(key),
      );
      if (unknown.length > 0) {
        throw new Error(
          `Unsupported export option(s): ${unknown.join(', ')}. Supported: outputFolder, format, quality, longEdge, paths.`,
        );
      }
      const paths = pathsFrom(params, hooks);
      // Models often copy sentence punctuation into a path ("…/out.").
      // Trim quotes and terminal punctuation, but never a root slash.
      const requestedFolder = String(params.outputFolder || '')
        .trim()
        .replace(/^[`"']+/, '')
        .replace(/[`"'.,;:!?]+$/, '');
      const exportToOriginal = /^(originalfolder|original folder|original|pored originala|u originalnu mapu)$/i.test(
        requestedFolder,
      );
      const outputFolder = exportToOriginal ? 'originalFolderDummy' : requestedFolder;
      if (!exportToOriginal) {
        if (!outputFolder) throw new Error('An absolute output folder, or "originalFolder", is required for export.');
        if (!/^([A-Za-z]:[\\/]|\/)/.test(outputFolder)) {
          throw new Error(`Export folder must be an absolute path: ${outputFolder}`);
        }
      }
      const format = String(params.format || 'jpeg').toLowerCase();
      if (!['jpeg', 'png', 'tiff'].includes(format)) {
        throw new Error(`Unsupported export format: ${format}. Use jpeg, png or tiff.`);
      }
      const quality = Math.max(1, Math.min(100, Number(params.quality ?? 90)));
      const longEdge = params.longEdge !== undefined ? Number(params.longEdge) : undefined;
      if (longEdge !== undefined && (!Number.isFinite(longEdge) || longEdge < 64)) {
        throw new Error('Export longEdge must be a number of at least 64 pixels.');
      }
      // `export_images` starts a background batch and returns immediately, so
      // the agent must (a) make sure the destination exists and (b) wait for the
      // real export-complete/export-error event before reporting success.
      if (!exportToOriginal) {
        try {
          await invoke(Invokes.CreateFolder, { path: outputFolder });
        } catch (error) {
          if (!String(error).toLowerCase().includes('already exists')) {
            throw new Error(`Could not create export folder ${outputFolder}: ${String(error)}`);
          }
        }
      }
      if (useProcessStore.getState().exportState.status === Status.Exporting) {
        throw new Error('An export is already running. Wait for it to finish before starting another.');
      }
      useProcessStore.getState().setExportState({
        status: Status.Exporting,
        progress: { current: 0, total: paths.length },
        errorMessage: '',
      });
      const selectedPath = selected?.path;
      try {
        await invoke(Invokes.ExportImages, {
          paths,
          outputFolderOrFile: outputFolder,
          isExplicitFilePath: false,
          baseOriginFolders: [],
          exportSettings: {
            filenameTemplate: null,
            jpegQuality: quality,
            tiffBitDepth: 16,
            keepMetadata: true,
            preserveTimestamps: true,
            resize: longEdge && longEdge > 0 ? { mode: 'longEdge', value: longEdge, dontEnlarge: true } : null,
            border: null,
            pad: null,
            stripGps: false,
            watermark: null,
            exportMasks: false,
            preserveFolders: false,
            destinationType: exportToOriginal ? 'originalFolder' : 'customFolder',
            subfolder: '',
          },
          outputFormat: format,
          currentEditPath: selectedPath && paths.includes(selectedPath) ? selectedPath : null,
          currentEditAdjustments:
            selectedPath && paths.includes(selectedPath) ? useEditorStore.getState().adjustments : null,
        });
      } catch (error) {
        useProcessStore.getState().setExportState({
          status: Status.Error,
          errorMessage: String(error),
        });
        throw error;
      }

      const started = Date.now();
      const timeoutMs = Math.max(180_000, paths.length * 120_000);
      while (Date.now() - started < timeoutMs) {
        const state = useProcessStore.getState().exportState;
        if (state.status === Status.Success) {
          await hooks.refreshLibrary();
          const destination = exportToOriginal ? 'alongside the originals' : `to ${outputFolder}`;
          return {
            tool,
            ok: true,
            message: `Exported ${paths.length} ${format.toUpperCase()} file(s) ${destination}.`,
            data: { outputFolder: exportToOriginal ? 'originalFolder' : outputFolder, format, quality },
          };
        }
        if (state.status === Status.Error) {
          throw new Error(state.errorMessage || 'The export failed.');
        }
        if (state.status === Status.Cancelled || state.status === Status.Cancelling) {
          throw new Error('The export was cancelled.');
        }
        await sleep(250);
      }
      const timeoutMessage = `Export timed out after ${Math.round(timeoutMs / 1000)} s. Check the export log.`;
      useProcessStore.getState().setExportState({ status: Status.Error, errorMessage: timeoutMessage });
      throw new Error(timeoutMessage);
    }

    case 'library.refresh': {
      await hooks.refreshLibrary();
      return { tool, ok: true, message: 'Library refreshed.' };
    }

    case 'app.setting': {
      const patch = (params.patch ?? {}) as Record<string, unknown>;
      const current = useSettingsStore.getState().appSettings;
      if (!current) throw new Error('App settings are not loaded yet.');
      const next = mergeAdjustmentPatch(current as unknown as Record<string, unknown>, patch);
      await useSettingsStore.getState().handleSettingsChange(next as unknown as typeof current);
      return { tool, ok: true, message: `Updated app setting(s): ${Object.keys(patch).join(', ')}.` };
    }

    case 'history.undo': {
      const state = useEditorStore.getState();
      if (state.historyIndex <= 0) throw new Error('There is nothing to undo.');
      state.undo();
      const next = useEditorStore.getState().adjustments;
      const path = useEditorStore.getState().selectedImage?.path;
      if (path) await saveLiveAdjustments(path, next);
      return { tool, ok: true, message: 'Undid the last edit.' };
    }

    case 'history.redo': {
      const state = useEditorStore.getState();
      if (state.historyIndex >= state.history.length - 1) throw new Error('There is nothing to redo.');
      state.redo();
      const next = useEditorStore.getState().adjustments;
      const path = useEditorStore.getState().selectedImage?.path;
      if (path) await saveLiveAdjustments(path, next);
      return { tool, ok: true, message: 'Redid the last edit.' };
    }

    default:
      throw new Error(`Unknown RapidRAW command "${tool}".`);
  }
}

export async function executePlan(
  steps: Array<{ tool: string; params?: Record<string, unknown>; note?: string }>,
  hooks: AgentExecutionHooks,
  onProgress?: (index: number, result: AgentStepResult) => void,
  shouldAbort?: () => boolean,
  onStart?: (index: number) => void,
): Promise<AgentStepResult[]> {
  const results: AgentStepResult[] = [];
  // File-producing operations (RAW denoise, HDR, panorama, focus stack,
  // negative conversion) change the working file. Subsequent steps that do not
  // name paths must edit the new result, not the original source frames.
  const activeHooks: AgentExecutionHooks = { ...hooks, targetPaths: [...hooks.targetPaths] };
  const redirectedFrom = new Set<string>();
  for (let index = 0; index < steps.length; index++) {
    if (shouldAbort?.()) break;
    const step = steps[index];
    const effectiveParams = { ...(step.params || {}) };
    // A new file (denoise/HDR/stack) becomes the working photo. If a later
    // edit still names the original sources, redirect it to the new result.
    const requestedPaths = Array.isArray(effectiveParams.paths)
      ? (effectiveParams.paths as unknown[]).filter((path): path is string => typeof path === 'string')
      : [];
    const isSourceOperation = [
      'photo.denoise',
      'photo.hdr',
      'photo.panorama',
      'photo.focus-stack',
      'photo.negative',
    ].includes(step.tool);
    if (
      !isSourceOperation &&
      redirectedFrom.size > 0 &&
      requestedPaths.length > 0 &&
      requestedPaths.every((path) => redirectedFrom.has(path)) &&
      !activeHooks.targetPaths.every((path) => requestedPaths.includes(path))
    ) {
      effectiveParams.paths = [...activeHooks.targetPaths];
    }

    onStart?.(index);
    const startedAt = Date.now();
    try {
      const result = await executeAgentStep(step.tool, effectiveParams, activeHooks);
      const finished: AgentStepResult = {
        ...result,
        startedAt,
        finishedAt: Date.now(),
      };
      results.push(finished);
      onProgress?.(index, finished);

      const data = (finished.data || {}) as { saved?: unknown; path?: unknown };
      if (step.tool === 'photo.select' && typeof (step.params || {}).path === 'string') {
        activeHooks.targetPaths = [String((step.params || {}).path)];
        redirectedFrom.clear();
      }
      if (step.tool === 'photo.denoise' && Array.isArray(data.saved) && data.saved.length > 0) {
        activeHooks.targetPaths.forEach((path) => redirectedFrom.add(path));
        activeHooks.targetPaths = data.saved.map(String);
      }
      if (['photo.hdr', 'photo.panorama', 'photo.focus-stack'].includes(step.tool) && typeof data.saved === 'string') {
        activeHooks.targetPaths.forEach((path) => redirectedFrom.add(path));
        activeHooks.targetPaths = [data.saved];
      }
      if (step.tool === 'photo.negative' && Array.isArray(data.saved) && data.saved.length > 0) {
        activeHooks.targetPaths.forEach((path) => redirectedFrom.add(path));
        activeHooks.targetPaths = data.saved.map(String);
      }
    } catch (error) {
      const finished: AgentStepResult = {
        tool: step.tool,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: Date.now(),
      };
      results.push(finished);
      onProgress?.(index, finished);
      break;
    }
  }
  return results;
}

export function describeResult(result: AgentStepResult): string {
  if (result.ok) return result.message;
  return `Failed: ${result.message}`;
}

export function announceFailure(result: AgentStepResult): void {
  if (!result.ok) toast.error(`RapidRAW command failed: ${result.message}`);
}

export async function restoreSnapshots(snapshots: unknown, paths: string[], hooks: AgentExecutionHooks): Promise<void> {
  await invoke(Invokes.RestoreSidecars, { snapshots });
  await reloadPaths(paths, hooks);
  await hooks.refreshLibrary();
}

/** Remove generated files only when a plan makes a new file and the user asks. */
export async function openGeneratedFile(path: string, hooks: AgentExecutionHooks): Promise<void> {
  await hooks.refreshLibrary();
  hooks.selectImage(path);
}

export function showAgentProgress(message: string): void {
  useProcessStore.getState().setProcess({ aiModelDownloadStatus: message });
}

export function closeAgentModal(): void {
  useUIStore.getState().setUI({ editAgentModalState: { isOpen: false, targetPaths: [] } });
}
