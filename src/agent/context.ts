import type { AgentContext, AgentHistogramStats } from './types';
import { useEditorStore } from '../store/useEditorStore';
import { useSettingsStore } from '../store/useSettingsStore';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

export async function computeHistogramFromUrl(url: string | null | undefined): Promise<AgentHistogramStats | null> {
  if (!url) return null;
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const width = 160;
    const height = Math.max(1, Math.round((image.naturalHeight / Math.max(1, image.naturalWidth)) * width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    const luma: number[] = [];
    let shadowClip = 0;
    let highlightClip = 0;
    let saturationSum = 0;
    const pixels = width * height;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      luma.push(y);
      if (r <= 2 && g <= 2 && b <= 2) shadowClip += 1;
      if (r >= 253 && g >= 253 && b >= 253) highlightClip += 1;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      saturationSum += max === 0 ? 0 : (max - min) / max;
    }
    luma.sort((a, b) => a - b);
    const median = percentile(luma, 0.5);
    const p05 = percentile(luma, 0.05);
    const p95 = percentile(luma, 0.95);
    const shadowClipRatio = shadowClip / Math.max(1, pixels);
    const highlightClipRatio = highlightClip / Math.max(1, pixels);
    let tone: AgentHistogramStats['tone'] = 'balanced';
    if (median < 0.12) tone = 'underexposed';
    else if (median < 0.28) tone = 'low-key';
    else if (median > 0.78) tone = 'overexposed';
    else if (median > 0.62) tone = 'high-key';

    let warning: string | undefined;
    if (highlightClipRatio > 0.02) warning = 'More than 2% of pixels are pure white; recover highlights.';
    else if (shadowClipRatio > 0.03) warning = 'More than 3% of pixels are crushed to black; lift shadows.';
    else if (median < 0.12) warning = 'The preview is severely underexposed.';
    else if (median > 0.82) warning = 'The preview is severely overexposed.';

    return {
      median: Number(median.toFixed(3)),
      p05: Number(p05.toFixed(3)),
      p95: Number(p95.toFixed(3)),
      shadowClip: Number(shadowClipRatio.toFixed(3)),
      highlightClip: Number(highlightClipRatio.toFixed(3)),
      meanSaturation: Number((saturationSum / Math.max(1, pixels)).toFixed(3)),
      tone,
      warning,
    };
  } catch {
    return null;
  }
}

export async function buildAgentContext(targetPaths: string[]): Promise<AgentContext> {
  const editor = useEditorStore.getState();
  const settings = useSettingsStore.getState();
  const selected = editor.selectedImage;
  const histogram = await computeHistogramFromUrl(editor.finalPreviewUrl || selected?.thumbnailUrl || null);
  const exif = (selected?.exif || {}) as Record<string, unknown>;
  const compactExif: Record<string, unknown> = {};
  for (const key of [
    'Make',
    'Model',
    'LensModel',
    'Lens',
    'ISO',
    'FNumber',
    'ExposureTime',
    'FocalLength',
    'DateTimeOriginal',
    'Artist',
    'ImageDescription',
  ]) {
    if (exif[key] !== undefined && exif[key] !== null && exif[key] !== '') compactExif[key] = exif[key];
  }

  let adjustments: AgentContext['adjustments'] = null;
  if (editor.adjustments) {
    const { lutData, lensBlurDepthMap, fogDepthMap, relightNormalMap, aiPatches, masks, ...rest } = editor.adjustments;
    adjustments = {
      ...rest,
      // Binary/base64 maps and full LUT tables would bloat every planning
      // request. Tell the model that they exist, but keep the values local.
      lutApplied: !!lutData,
      lensBlurDepthMap: lensBlurDepthMap ? '[depth map present]' : null,
      fogDepthMap: fogDepthMap ? '[depth map present]' : null,
      relightNormalMap: relightNormalMap ? '[normal map present]' : null,
      aiPatches: (aiPatches || []).map((patch) => ({
        id: patch.id,
        name: patch.name,
        visible: patch.visible,
        prompt: patch.prompt,
        subMasks: patch.subMasks?.map((subMask) => ({
          id: subMask.id,
          type: subMask.type,
          mode: subMask.mode,
          opacity: subMask.opacity,
          visible: subMask.visible,
        })),
      })),
      masks: (masks || []).map((mask) => ({
        id: mask.id,
        name: mask.name,
        opacity: mask.opacity,
        visible: mask.visible,
        invert: mask.invert,
        subMasks: mask.subMasks?.map((subMask) => ({
          id: subMask.id,
          type: subMask.type,
          mode: subMask.mode,
          opacity: subMask.opacity,
          visible: subMask.visible,
        })),
        adjustments: mask.adjustments,
      })),
    } as unknown as AgentContext['adjustments'];
  }

  return {
    selectedPath: selected?.path || null,
    selectedPaths: targetPaths,
    image: selected
      ? {
          width: selected.width,
          height: selected.height,
          isRaw: selected.isRaw,
          exif: compactExif,
        }
      : null,
    adjustments: adjustments as AgentContext['adjustments'],
    histogram,
    app: {
      language: settings.appSettings?.language,
      theme: settings.appSettings?.theme,
      provider: settings.appSettings?.promptAi?.provider,
      aiModel: settings.appSettings?.promptAi?.model ?? null,
    },
  };
}

export function formatContextForPlanner(context: AgentContext): string {
  return JSON.stringify({
    selectedPath: context.selectedPath,
    selectedPaths: context.selectedPaths,
    image: context.image,
    histogram: context.histogram,
    app: context.app,
    // Current adjustment values are last so a context truncation still keeps
    // the file, EXIF and histogram that the planner needs most.
    adjustments: context.adjustments
      ? Object.fromEntries(
          Object.entries(context.adjustments).filter(([key]) => key !== 'activeTools' && key !== 'pointCurves'),
        )
      : null,
  });
}
