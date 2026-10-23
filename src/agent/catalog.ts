import type { AgentToolDefinition } from './types';

/**
 * Complete RapidRAW adjustment surface, written for an AI planner and for
 * humans reading the command reference. Keep this in sync with
 * `src/utils/defaultAdjustments.json`: `settings.patch` can address every leaf.
 */
export const ADJUSTMENT_REFERENCE = `
Every slider below is a key of the adjustments object. Values are clamped by
RapidRAW when rendered, but stay inside these photographic ranges in plans.

TONE / BASIC
exposure -5..5 EV | brightness -100..100 | contrast -100..100
highlights -100..100 | shadows -100..100 | whites -100..100 | blacks -100..100
toneMapper "agx" | "basic" | baselineExposure boolean

COLOUR
temperature -100..100 | tint -100..100 | vibrance -100..100 | saturation -100..100 | hue -100..100
hsl: {reds, oranges, yellows, greens, aquas, blues, purples, magentas} each {hue: -100..100, saturation: -100..100, luminance: -100..100}
colorGrading: {balance -100..100, blending 0..100, shadows|midtones|highlights|global: {hue 0..360, saturation 0..100, luminance -100..100}}
colorCalibration: {shadowsTint, redHue, redSaturation, greenHue, greenSaturation, blueHue, blueSaturation} (-100..100)
whiteBalance: null or {temperature, tint} sampled values; do not invent unless asked
curves: {luma, red, green, blue} arrays of {x:0..255, y:0..255}; pointCurves for point mode
parametricCurve: {luma, red, green, blue} each {darks, shadows, highlights, lights, whiteLevel, blackLevel, split1, split2, split3}
curveMode: "point" | "parametric"

DETAIL
clarity -100..100 | dehaze -100..100 | structure -100..100
lumaNoiseReduction 0..100 | colorNoiseReduction 0..100
sharpness 0..100 | sharpnessThreshold 0..100
chromaticAberrationRedCyan -100..100 | chromaticAberrationBlueYellow -100..100

EFFECTS / FINISHING
grainAmount 0..100 | grainSize 0..100 | grainRoughness 0..100
vignetteAmount -100..100 | vignetteMidpoint 0..100 | vignetteFeather 0..100 | vignetteRoundness -100..100 | vignetteCenterX 0..1 | vignetteCenterY 0..1
glowAmount 0..100 | halationAmount 0..100 | flareAmount 0..100
lutData string|null | lutName string|null | lutPath string|null | lutIntensity 0..100 | lutSize number | lutIsSceneReferred boolean

GEOMETRY / CROP / LENS
aspectRatio 0 or ratio | crop {unit:"px"|"%", x,y,width,height}|null
rotation -45..45 degrees | orientationSteps 0..3 | flipHorizontal bool | flipVertical bool
transformDistortion, transformVertical, transformHorizontal, transformRotate, transformAspect, transformXOffset, transformYOffset: -100..100 (aspect/offsets scaled)
transformScale 50..150
lensCorrectionMode "auto"|"manual" | lensDistortionEnabled bool | lensTcaEnabled bool | lensVignetteEnabled bool
lensDistortionAmount, lensVignetteAmount, lensTcaAmount: -100..100
lensMaker string|null | lensModel string|null | lensDistortionParams object|null
guidedPerspective {enabled:boolean, lines:Array<{id,type:"vertical"|"horizontal",p1:{x,y},p2:{x,y}}>, autoCrop:boolean}

AI / DEPTH / LIGHT
lensBlurEnabled bool | lensBlurAmount 0..100 | lensBlurDiffusion 0..100 | lensBlurShape "circle"|"hexagon"|"octagon"|"ring"
lensBlurDepthMap string|null | lensBlurMinDepth/MaxDepth/MinFade/MaxFade 0..100
relightEnabled bool | relightNormalMap string|null | relightAmbient 0..100 | relightSoftness 0..100 | relightShine 0..100
relightShadows bool | relightShadowSoftness 0..100
relightLights array of {id,type:"point"|"spot"|"directional",x,y,depth,intensity,radius,angle,elevation,cone,feather,temperature,tint,color}
fogEnabled bool | fogDepthMap string|null | fogAmount 0..100 | fogStart 0..100 | fogDensity 0..100
fogHeight 0..100 | fogVariation 0..100 | fogGlow 0..100 | fogTemperature 0..100 | fogTint 0..100

MASKS
masks: Array<{id,name,opacity:0..100,visible:boolean,invert:boolean,subMasks:Array<{id,type,mode:"additive"|"subtractive"|"intersect",opacity,visible,invert,parameters}>,adjustments:MaskAdjustments}>
MaskAdjustments are the same tone/colour/detail/effects keys without geometry.
Prefer photo.ai-mask or photo.mask-adjust over hand-building masks.
aiPatches: generative/inpainting patch definitions; do not fabricate.
showClipping boolean is a viewer preference, not a look.
`.trim();

export const AGENT_TOOL_CATALOG: AgentToolDefinition[] = [
  {
    id: 'photo.inspect',
    label: 'Inspect current photo',
    category: 'inspect',
    description:
      'Read the selected photo(s): path, dimensions, EXIF, current adjustments, mask list and preview histogram. Use this first when the request depends on the current state or when a previous step changed it.',
    params: '{}',
    examples: ['{"tool":"photo.inspect","params":{}}'],
  },
  {
    id: 'photo.select',
    label: 'Open a photo',
    category: 'inspect',
    description:
      'Open one photo in the editor by exact path. Only use paths that exist in the current selection/context.',
    params: '{ path: string }',
  },
  {
    id: 'photo.histogram',
    label: 'Measure exposure and clipping',
    category: 'inspect',
    description:
      'Measure the rendered preview: median luma, 5th/95th percentile, shadow/highlight clipping and saturation. Use after tone/colour changes to verify the result is not underexposed, blown out or wildly saturated.',
    params: '{}',
    examples: ['{"tool":"photo.histogram","params":{}}'],
  },
  {
    id: 'settings.patch',
    label: 'Set any adjustment',
    category: 'tone',
    description:
      'Merge any RapidRAW adjustment keys into the current photo, or apply the same patch to paths. Arrays replace, objects merge. This is the universal slider/curve/mask/LUT/transform command. Prefer a coherent, modest edit; never use it to invent unsupported keys.',
    params: '{ patch: object, paths?: string[] }',
    examples: [
      '{"tool":"settings.patch","params":{"patch":{"exposure":-0.25,"shadows":18,"highlights":-22,"clarity":5}}}',
      '{"tool":"settings.patch","params":{"patch":{"temperature":6,"tint":3,"contrast":12,"saturation":-4}}}',
    ],
    requiresImage: true,
  },
  {
    id: 'settings.set',
    label: 'Set one adjustment value',
    category: 'tone',
    description:
      'Set a single dotted adjustment path such as "hsl.reds.saturation" or "colorGrading.shadows.hue". Use when there is exactly one value to change.',
    params: '{ path: string, value: any, paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'settings.reset',
    label: 'Reset adjustments',
    category: 'tone',
    description:
      'Reset all edits or one section (basic, colour, curves, details, effects, geometry, masks) on the selection. Destructive; only on explicit request.',
    params: '{ section?: "all"|"basic"|"color"|"curves"|"details"|"effects"|"geometry"|"masks", paths?: string[] }',
    destructive: true,
    requiresImage: true,
  },
  {
    id: 'photo.auto-tone',
    label: 'Auto tone (content aware)',
    category: 'tone',
    description:
      'Run RapidRAW content-aware auto analysis for exposure, highlights, shadows, whites, blacks, contrast and vibrance. This is the safe professional starting point. Optional paths.',
    params: '{ paths?: string[] }',
    examples: ['{"tool":"photo.auto-tone","params":{}}'],
    requiresImage: true,
  },
  {
    id: 'photo.auto-straighten',
    label: 'Auto straighten',
    category: 'geometry',
    description: 'Detect and correct horizon/vertical tilt. Do this before crop and creative grading. Optional paths.',
    params: '{ paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'photo.auto-lens',
    label: 'Auto lens correction',
    category: 'geometry',
    description: 'Apply matching lensfun profile: distortion, TCA and vignetting. Optional paths.',
    params: '{ paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'photo.crop',
    label: 'Crop and rotate',
    category: 'geometry',
    description:
      'Crop to an aspect ratio or set rotation/orientation. Use ratio strings: "original", "1:1", "4:5", "5:4", "3:2", "2:3", "16:9", "9:16". Crops are centred around the current framing.',
    params: '{ ratio?: string, rotation?: number, orientationSteps?: 0..3, paths?: string[] }',
    examples: ['{"tool":"photo.crop","params":{"ratio":"4:5"}}'],
    requiresImage: true,
  },
  {
    id: 'photo.flip',
    label: 'Flip image',
    category: 'geometry',
    description: 'Flip horizontally or vertically. Use only when asked or when a scan is mirrored.',
    params: '{ axis: "horizontal"|"vertical", paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'photo.ai-mask',
    label: 'Add AI mask',
    category: 'mask',
    description:
      'Create a subject, sky, foreground or depth mask and apply local adjustments to it. Use for "brighten the subject", "darken the sky", "warm the foreground". Keep local edits modest.',
    params: '{ type: "subject"|"sky"|"foreground"|"depth", name?: string, patch: MaskAdjustments, opacity?: 0..100 }',
    examples: [
      '{"tool":"photo.ai-mask","params":{"type":"subject","name":"Subject lift","patch":{"exposure":0.18,"shadows":10}}}',
      '{"tool":"photo.ai-mask","params":{"type":"sky","name":"Sky drama","patch":{"exposure":-0.3,"contrast":12,"saturation":-8}}}',
    ],
    requiresImage: true,
  },
  {
    id: 'photo.mask-adjust',
    label: 'Adjust an existing mask',
    category: 'mask',
    description:
      'Merge adjustments into an existing mask by name or id. If the mask is missing, create a whole-image mask with that name and patch.',
    params: '{ mask: string, patch: object }',
    requiresImage: true,
  },
  {
    id: 'photo.ai-lens-blur',
    label: 'AI depth lens blur',
    category: 'ai',
    description:
      'Enable depth-based lens blur. Requires a depth map; use only on a normal photo that has one available. Optional amount/shape.',
    params: '{ amount?: 0..100, shape?: "circle"|"hexagon"|"octagon"|"ring", minDepth?: 0..100, maxDepth?: 0..100 }',
    requiresImage: true,
  },
  {
    id: 'photo.ai-relight',
    label: 'AI relight',
    category: 'ai',
    description: 'Enable relighting with a normal map and optional ambient/shine settings. Only when asked.',
    params: '{ ambient?: 0..100, softness?: 0..100, shine?: 0..100 }',
    requiresImage: true,
  },
  {
    id: 'photo.ai-fog',
    label: 'AI fog',
    category: 'ai',
    description: 'Enable depth fog with amount, start, density, glow and temperature. Only when asked.',
    params: '{ amount?: 0..100, start?: 0..100, density?: 0..100, glow?: 0..100, temperature?: 0..100 }',
    requiresImage: true,
  },
  {
    id: 'photo.denoise',
    label: 'RAW denoise',
    category: 'operations',
    description:
      'Run RapidRAW denoise and save a new TIFF/PNG beside the source. Use AI for high-ISO RAW, bm3d for a cleaner low-noise result, raw9 where available. Do this before sharpening/grading; do not denoise a clean low-ISO file.',
    params: '{ intensity: 0..100, method: "ai"|"bm3d"|"raw9", paths?: string[] }',
    examples: ['{"tool":"photo.denoise","params":{"intensity":45,"method":"ai"}}'],
    requiresImage: true,
  },
  {
    id: 'photo.hdr',
    label: 'HDR merge',
    category: 'operations',
    description:
      'Merge a bracketed exposure set into a new HDR TIFF/PNG. Requires at least two exposed frames with the same framing. Returns the saved path; later steps can edit it.',
    params: '{ paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'photo.panorama',
    label: 'Panorama stitch',
    category: 'operations',
    description:
      'Stitch two or more overlapping frames into a new panorama file. Source paths are required when the selection is not the pano set.',
    params: '{ paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'photo.focus-stack',
    label: 'Focus stack',
    category: 'operations',
    description: 'Merge a focus-bracketed set into a new stacked TIFF. Requires two or more frames of identical size.',
    params: '{ paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'photo.negative',
    label: 'Convert negative',
    category: 'operations',
    description:
      'Convert film negatives to positive with default film parameters and save a new TIFF. Only on scanned negatives.',
    params: '{ paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'photo.style-profile',
    label: 'Apply RapidRAW style profile',
    category: 'colour',
    description:
      'Apply a saved RapidRAW style profile by exact name or id. Use for curated film/concert looks and learned profiles. Intensity 0..100.',
    params: '{ name?: string, id?: string, intensity?: 0..100, paths?: string[] }',
    examples: ['{"tool":"photo.style-profile","params":{"name":"Concert Gold","intensity":80}}'],
    requiresImage: true,
  },
  {
    id: 'photo.prompt-style',
    label: 'Generate a look from words',
    category: 'colour',
    description:
      'Use the full RapidRAW prompt-to-look engine: eight structural variants, AI/offline interpretation, LUTs, histogram safety gate and per-image adaptation. Choose the variant by name when the user asks for soft/bold/film/airy/noir/vivid/editorial; otherwise Balanced.',
    params:
      '{ prompt: string, variant?: "Balanced"|"Soft"|"Bold"|"Film"|"Airy"|"Noir"|"Vivid"|"Editorial", intensity?: 0..100, useAi?: boolean, paths?: string[] }',
    examples: [
      '{"tool":"photo.prompt-style","params":{"prompt":"cinematic teal and orange concert, glowing stage","variant":"Balanced","intensity":80}}',
    ],
    requiresImage: true,
  },
  {
    id: 'photo.lut',
    label: 'Load a LUT',
    category: 'colour',
    description:
      'Load a .cube LUT from an absolute path and apply it with intensity. Use only when the user provides a LUT path; never invent one.',
    params: '{ path: string, intensity?: 0..100 }',
    requiresImage: true,
  },
  {
    id: 'photo.preset',
    label: 'Apply a preset',
    category: 'colour',
    description: 'Apply a saved RapidRAW preset by exact name or id. Prefer style profiles for photographic looks.',
    params: '{ name?: string, id?: string, paths?: string[] }',
    requiresImage: true,
  },
  {
    id: 'photo.copy-settings',
    label: 'Copy settings to photos',
    category: 'colour',
    description:
      'Copy the current photo adjustments to other paths. Masks and crop/geometry are excluded unless includeMasks/includeCrop are explicitly true. Use only when the user asks to sync/match a set; portrait and concert frames often need different exposure.',
    params: '{ paths: string[], includeMasks?: boolean, includeCrop?: boolean }',
    requiresImage: true,
  },
  {
    id: 'library.rate',
    label: 'Set star rating',
    category: 'library',
    description: 'Set 0-5 stars on the selected paths. Explicit request only.',
    params: '{ rating: 0..5, paths?: string[] }',
  },
  {
    id: 'library.flag',
    label: 'Pick or reject',
    category: 'library',
    description: 'Set pick, reject or clear flag on the selected paths. Explicit request only.',
    params: '{ flag: "pick"|"reject"|null, paths?: string[] }',
  },
  {
    id: 'library.color',
    label: 'Set colour label',
    category: 'library',
    description: 'Set a colour label (red, yellow, green, blue, purple) or clear it. Explicit request only.',
    params: '{ color: "red"|"yellow"|"green"|"blue"|"purple"|null, paths?: string[] }',
  },
  {
    id: 'library.tag',
    label: 'Add or remove tags',
    category: 'library',
    description: 'Add/remove metadata tags on selected photos. Use short, factual tags.',
    params: '{ tags?: string[], remove?: string[], paths?: string[] }',
  },
  {
    id: 'library.exif',
    label: 'Edit EXIF fields',
    category: 'library',
    description:
      'Write textual EXIF fields such as Artist, Copyright, Caption/Description. Provide a map of key to value; empty value removes the field.',
    params: '{ fields: Record<string,string>, paths?: string[] }',
  },
  {
    id: 'library.cull',
    label: 'AI culling',
    category: 'library',
    description:
      'Run RapidRAW content-aware culling on paths. Returns suggestions; it does not apply them automatically. Use only for a real burst/event set, not a single photo.',
    params: '{ paths?: string[], minSharpness?: number, checkComposition?: boolean }',
  },
  {
    id: 'library.export',
    label: 'Export photos',
    category: 'library',
    description:
      'Export selected photos with a simple preset. Requires an absolute output folder, or "originalFolder" to save beside each source. Explicit request only.',
    params:
      '{ outputFolder: string | "originalFolder", format?: "jpeg"|"png"|"tiff", quality?: 1..100, longEdge?: number, paths?: string[] }',
    destructive: true,
  },
  {
    id: 'library.refresh',
    label: 'Refresh library',
    category: 'library',
    description:
      'Regenerate thumbnails and reload the image list after an operation that created files outside the current selection.',
    params: '{}',
  },
  {
    id: 'app.setting',
    label: 'Change app setting',
    category: 'app',
    description:
      'Patch a persisted AppSettings key (for example "editorPreviewResolution", "enableLivePreviews", "rawHighlightCompression", "thumbnailSize"). Use only on explicit request. Never change keybinds/language/root folders spontaneously.',
    params: '{ patch: object }',
    examples: ['{"tool":"app.setting","params":{"patch":{"editorPreviewResolution":2560}}}'],
    destructive: true,
  },
  {
    id: 'history.undo',
    label: 'Undo last edit',
    category: 'inspect',
    description: 'Undo the last editor history entry for the active photo.',
    params: '{}',
  },
  {
    id: 'history.redo',
    label: 'Redo last edit',
    category: 'inspect',
    description: 'Redo the last undone editor history entry for the active photo.',
    params: '{}',
  },
];

export const AGENT_TOOL_IDS = AGENT_TOOL_CATALOG.map((tool) => tool.id);

export function buildToolCatalogText(): string {
  const tools = AGENT_TOOL_CATALOG.map(
    (tool) =>
      `- ${tool.id} (${tool.label}) [${tool.category}]${tool.destructive ? ' [DESTRUCTIVE]' : ''}\n  ${tool.description}\n  params: ${tool.params}`,
  ).join('\n');
  return `${tools}\n\nADJUSTMENT KEY REFERENCE\n${ADJUSTMENT_REFERENCE}`;
}

export function getTool(id: string): AgentToolDefinition | undefined {
  return AGENT_TOOL_CATALOG.find((tool) => tool.id === id);
}
