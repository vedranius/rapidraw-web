import { invoke } from '@tauri-apps/api/core';
import type { AgentContext, AgentPlanResponse, AgentSkill, AgentStep } from './types';
import { buildToolCatalogText, AGENT_TOOL_IDS } from './catalog';
import { formatContextForPlanner } from './context';
import { buildSkillsText } from './skills';
import { Invokes } from '../components/ui/AppProperties';

const STYLE_WORDS = [
  'cinematic',
  'filmski',
  'film',
  'vintage',
  'retro',
  'noir',
  'black and white',
  'black & white',
  'crno bijelo',
  'crno-bijelo',
  'monochrome',
  'monokrom',
  'concert',
  'koncert',
  'portrait',
  'portret',
  'editorial',
  'moda',
  'moody',
  'airy',
  'soft',
  'bold',
  'vivid',
  'vibrant',
  'warm',
  'toplo',
  'cool',
  'hladno',
  'teal',
  'orange',
  'neon',
  'pastel',
  'faded',
  'fade',
  'grainy',
  'grain',
  'zrno',
  'halation',
  'glow',
  'film look',
  'look',
  'grade',
  'style',
  'stil',
  'izgled',
  'obrada',
  '50s',
  '60s',
  '70s',
  '80s',
  '90s',
  '1950',
  '1960',
  '1970',
  '1980',
  '1990',
  '2000',
  'portra',
  'ektar',
  'cinestill',
  'tri-x',
  'vision',
  'gold 200',
  'fuji',
];

// A request can be purely technical (export, metadata, culling).  Small local
// models tend to add an unrequested auto-tone/crop "to be helpful"; that is not
// acceptable when the photographer asked only for an export or a rating.
const EDIT_INTENT =
  /\b(exposure|ekspozicij\w*|brightness|contrast|highlights?|shadows?|whites?|blacks?|temperature|white balance|wb|tint|vibrance|saturation|hue|tone|tonovi?|color|colour|boja|grade|style|stil|look|izgled|crop|krop|aspect|ratio|straighten|ravnanj\w*|lens|le[cć]a|denoise|od[sš]umi|noise|šum|sum|sharpen|o[sš]tr\w*|clarity|jasno[cć]a|texture|structure|grain|zrno|vignette|vinjeta|fog|magla|glow|halation|mask|maska|retouch|obradi|uredi|popravi|fix|hdr|panorama|focus[ -]?stack|negative|negativ|preset|profile|profil|auto[ -]?tone|auto\s*ton\w*|automatsk\w*\s+ton\w*|obrad\w*|instagram|story|feed|social|mre[zž]\w*)\b/i;
const METADATA_INTENT =
  /\b(rating|rate|stars?|zvjezdic\w*|flag|reject|odbaci|pick|favorit|color label|colour label|oznaka|tag|tags|oznake|exif|caption|opis)\b/i;
const CULL_INTENT = /\b(cull|culling|selekcij\w*|odaberi najbolje|best of|burst|serija)\b/i;
const EXPORT_INTENT = /\b(export|exportiraj|izvezi|izvoz)\b/i;

function planScopeGuard(prompt: string, plan: AgentPlanResponse, explicitlySelectedSkill: boolean): AgentPlanResponse {
  if (explicitlySelectedSkill) return plan;
  const text = prompt.toLowerCase();
  const hasEdits = EDIT_INTENT.test(text);
  const hasExport = EXPORT_INTENT.test(text);
  const hasMetadata = METADATA_INTENT.test(text);
  const hasCull = CULL_INTENT.test(text);
  const pureExport = hasExport && !hasEdits;
  const pureMetadata = hasMetadata && !hasEdits && !hasExport;
  const pureCull = hasCull && !hasEdits && !hasExport && !hasMetadata;
  if (!pureExport && !pureMetadata && !pureCull) return plan;

  const allowed = new Set<string>(['photo.select', 'library.refresh']);
  if (/histogram/.test(text)) allowed.add('photo.histogram');
  if (/\b(inspect|provjeri|pregledaj|analiziraj)\b/.test(text)) allowed.add('photo.inspect');
  if (hasExport) allowed.add('library.export');
  if (pureCull) allowed.add('library.cull');
  if (hasMetadata) {
    allowed.add('library.rate');
    allowed.add('library.flag');
    allowed.add('library.color');
    allowed.add('library.tag');
    allowed.add('library.exif');
  }

  const removed: string[] = [];
  const steps = plan.steps.filter((step) => {
    if (allowed.has(step.tool)) return true;
    removed.push(step.tool);
    return false;
  });
  if (removed.length === 0) return plan;
  return {
    ...plan,
    steps,
    summary: `${plan.summary} Removed unrequested step(s): ${Array.from(new Set(removed)).join(', ')}.`,
  };
}

const ALIASES: Record<string, string[]> = {
  exposure: ['exposure', 'ekspozicija', 'ekspoziciju', 'svjetlost', 'svetlost'],
  brightness: ['brightness', 'bright', 'svjetlina', 'svetlina', 'sjaj'],
  contrast: ['contrast', 'kontrast'],
  highlights: ['highlights', 'highlights', 'svjetla', 'visoke svjetlosti', 'highlights'],
  shadows: ['shadows', 'sjene', 'shadow', 'sjenama'],
  whites: ['whites', 'bijele', 'bijelo'],
  blacks: ['blacks', 'crne', 'crno'],
  clarity: ['clarity', 'jasnoća', 'jasnoca'],
  dehaze: ['dehaze', 'dehaze', 'magla', 'izmaglica'],
  structure: ['structure', 'struktura', 'tekstura', 'texture'],
  sharpness: ['sharpness', 'oštrina', 'ostrina', 'sharp'],
  lumaNoiseReduction: [
    'luma noise reduction',
    'luminance noise reduction',
    'luma nr',
    'noise reduction',
    'odšumljavanje',
    'odsumljavanje',
    'denoise detail',
  ],
  colorNoiseReduction: ['color noise reduction', 'colour noise reduction', 'color nr', 'chroma noise', 'kromatski šum'],
  temperature: ['temperature', 'temperatura', 'wb temperature', 'toplina'],
  tint: ['tint', 'tint offset', 'tintovanje'],
  vibrance: ['vibrance', 'vibracija', 'živost'],
  saturation: ['saturation', 'saturacija', 'zasićenje', 'zasicenje'],
  hue: ['hue', 'nijansa'],
  grainAmount: ['grain amount', 'grain', 'zrno', 'granulacija'],
  grainSize: ['grain size', 'veličina zrna', 'velicina zrna'],
  grainRoughness: ['grain roughness', 'hrapavost zrna'],
  glowAmount: ['glow', 'sjaj', 'bloom'],
  halationAmount: ['halation', 'halacija'],
  flareAmount: ['flare', 'flair', 'bljesak'],
  vignetteAmount: ['vignette', 'vinjeta', 'vinjetiranje'],
  fogAmount: ['fog', 'magla'],
  exportQuality: ['quality', 'kvaliteta'],
};

const INCREASE =
  /(pove[cć]aj|pove[cć]ati|podigni|podignuti|digni|izvuci|izvu[cć]i|lift|raise|increase|boost|more|vi[sš]e|recover|open up)/i;
const DECREASE = /(smanji|smanjiti|snizi|sniziti|spusti|spustiti|dubok|dublje|crush|reduce|decrease|lower|less|manje)/i;

function normalizedDirection(text: string, keyIndex: number, keyLength: number, fallback: number): number {
  const before = text.slice(Math.max(0, keyIndex - 40), keyIndex);
  const after = text.slice(keyIndex + keyLength, keyIndex + keyLength + 20);
  if (INCREASE.test(before) || INCREASE.test(after)) return Math.abs(fallback);
  if (DECREASE.test(before) || DECREASE.test(after)) return -Math.abs(fallback);
  // A slider name without a number or a direction is not an instruction.
  // "soft stage lights" must not become "highlights +12".
  return 0;
}

function parseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function findValue(text: string, aliases: string[]): { value: number; explicit: boolean; signed: boolean } | null {
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}[^0-9+\\-]{0,24}([+\\-]?\\d+(?:[.,]\\d+)?)\\s*(ev|stops?|stop|%)?`, 'i');
    const match = text.match(regex);
    if (match) {
      let value = parseNumber(match[1]);
      if (value === null) continue;
      if (match[2] === '%' && ['exposure', 'brightness'].includes(alias)) value /= 100;
      return { value, explicit: true, signed: /^[+\-]/.test(match[1]) };
    }
  }
  return null;
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function ratioFrom(text: string): string | null {
  const match = text.match(/\b(\d{1,2})\s*[:x×]\s*(\d{1,2})\b/i);
  if (match) return `${match[1]}:${match[2]}`;
  if (/\b(square|kvadrat|1:1)\b/i.test(text)) return '1:1';
  if (/\b(portrait crop|portretni crop|4:5|4x5)\b/i.test(text)) return '4:5';
  if (/\b(16:9|16x9|wide crop)\b/i.test(text)) return '16:9';
  return null;
}

function variantFrom(text: string): string {
  if (/\b(soft|mekano|nježno|njezno)\b/i.test(text)) return 'Soft';
  if (/\b(bold|hrabro|jako|punchy)\b/i.test(text)) return 'Bold';
  if (/\b(film|filmski|analog|35mm)\b/i.test(text)) return 'Film';
  if (/\b(airy|pro-zračno|prozracno|light and airy|high-key)\b/i.test(text)) return 'Airy';
  if (/\b(noir|dramatic|dramatično|dramaticno|low-key)\b/i.test(text)) return 'Noir';
  if (/\b(vivid|vibrant|živopisno|zivopisno|saturated)\b/i.test(text)) return 'Vivid';
  if (/\b(editorial|fashion|moda|magazin)\b/i.test(text)) return 'Editorial';
  return 'Balanced';
}

function buildPatch(text: string): { patch: Record<string, unknown>; labels: string[] } {
  const patch: Record<string, unknown> = {};
  const labels: string[] = [];
  const keys: Array<[string, number]> = [
    ['exposure', 0.2],
    ['brightness', 8],
    ['contrast', 10],
    ['highlights', 12],
    ['shadows', 12],
    ['whites', 8],
    ['blacks', 8],
    ['clarity', 8],
    ['dehaze', 8],
    ['structure', 8],
    ['sharpness', 8],
    ['lumaNoiseReduction', 10],
    ['colorNoiseReduction', 10],
    ['temperature', 8],
    ['tint', 5],
    ['vibrance', 8],
    ['saturation', 8],
    ['hue', 5],
    ['grainAmount', 8],
    ['grainSize', 8],
    ['grainRoughness', 8],
    ['glowAmount', 8],
    ['halationAmount', 8],
    ['flareAmount', 8],
    ['vignetteAmount', 8],
    ['fogAmount', 8],
  ];

  for (const [key, fallback] of keys) {
    const aliases = ALIASES[key] || [key];
    const found = findValue(text, aliases);
    const aliasIndex = aliases
      .map((alias) => text.toLowerCase().indexOf(alias.toLowerCase()))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    const hasKey = aliasIndex !== undefined && aliasIndex >= 0;
    if (!found && !hasKey) continue;
    if (!hasKey) continue;
    const direction = normalizedDirection(text, aliasIndex, aliases[0].length, fallback);
    // "Smanji exposure za 0.10" contains an unsigned number; the verb still
    // decides the sign. An explicit "-0.10" always wins.
    const value = found
      ? found.signed
        ? found.value
        : direction < 0
          ? -Math.abs(found.value)
          : found.value
      : direction;
    if (!Number.isFinite(value) || value === 0) continue;
    patch[key] = value;
    labels.push(`${key} ${value > 0 ? '+' : ''}${value}`);
  }

  // A bare "warm" / "cool" request is a real colour instruction.
  if (patch.temperature === undefined) {
    if (/\b(warm|topli|topla|toplo|toplije|zlatno|zlatni)\b/i.test(text)) {
      patch.temperature = 7;
      labels.push('temperature +7');
    } else if (/\b(cool|hladni|hladna|hladno|hladnije|plavo|plavi)\b/i.test(text)) {
      patch.temperature = -7;
      labels.push('temperature -7');
    }
  }

  if (
    patch.colorNoiseReduction !== undefined &&
    /color|colour|chroma|krom/i.test(text) &&
    !/luma|luminance|luminancij/i.test(text)
  ) {
    delete patch.lumaNoiseReduction;
    const index = labels.findIndex((label) => label.startsWith('lumaNoiseReduction '));
    if (index >= 0) labels.splice(index, 1);
  }

  if (/crno[ -]?bijelo|black[ -]?(and|&)[ -]?white|monochrome|monokrom/i.test(text)) {
    patch.saturation = -100;
    patch.contrast = Math.max(12, Number(patch.contrast || 0));
    patch.grainAmount = Math.max(10, Number(patch.grainAmount || 0));
    labels.push('monochrome conversion');
  }

  return { patch, labels };
}

function skillSteps(skill: AgentSkill | null, prompt: string): AgentStep[] {
  if (!skill) return [];
  const steps: AgentStep[] = [];
  const add = (tool: string, params: Record<string, unknown> = {}, note?: string) => {
    if (!steps.some((step) => step.tool === tool)) steps.push({ tool, params, note });
  };
  if (skill.id === 'concert-hero') {
    add('photo.inspect', {}, 'Provjeri svjetlo i histogram prije obrade.');
    add('photo.auto-tone', {}, 'Sadržajno auto izlaganje kao baza.');
    add(
      'photo.prompt-style',
      { prompt, variant: variantFrom(prompt), intensity: 78 },
      'Koncertni look s toplim svjetlom i zaštićenim svjetlima.',
    );
  } else if (skill.id === 'clean-portrait') {
    add('photo.inspect', {}, 'Provjeri kožu i svjetla.');
    add('photo.auto-tone', {}, 'Nježna baza.');
    add(
      'photo.ai-mask',
      { type: 'subject', name: 'Subject lift', patch: { exposure: 0.12, shadows: 8, clarity: 2 } },
      'Lokalno podigni subjekt.',
    );
    add('photo.prompt-style', { prompt, variant: 'Soft', intensity: 55 }, 'Prirodan, mekan portrait look.');
  } else if (skill.id === 'high-iso-rescue') {
    add('photo.inspect', {}, 'Provjeri ISO i šum.');
    add('photo.denoise', { intensity: 45, method: 'ai' }, 'AI denoise prije oštrenja.');
    add('photo.auto-tone', {}, 'Vrati ton nakon denoisea.');
  } else if (skill.id === 'hdr-bracket') {
    add('photo.hdr', {}, 'Spoji bracket.');
    add('photo.inspect', {}, 'Provjeri spojeni rezultat.');
  } else if (skill.id === 'panorama') {
    add('photo.panorama', {}, 'Spoji panoramu.');
  } else if (skill.id === 'focus-stack') {
    add('photo.focus-stack', {}, 'Složi fokus.');
  } else if (skill.id === 'documentary-noir') {
    add('photo.inspect', {}, 'Provjeri histogram.');
    add('photo.prompt-style', { prompt, variant: 'Noir', intensity: 75 }, 'Dokumentarni crno-bijeli look.');
  } else if (skill.id === 'editorial-colour') {
    add('photo.inspect', {}, 'Odaberi paletu.');
    add('photo.auto-tone', {}, 'Čista baza.');
    add('photo.prompt-style', { prompt, variant: variantFrom(prompt), intensity: 80 }, 'Urednički color grade.');
  } else if (skill.id === 'cull-burst') {
    add('library.cull', {}, 'Sadržajna selekcija serije.');
  } else if (skill.id === 'social-export') {
    const ratio = ratioFrom(prompt) || '4:5';
    add('photo.crop', { ratio }, `Krop za društvene mreže (${ratio}).`);
    add('photo.histogram', {}, 'Provjeri ekspoziciju prije izvoza.');
    add('library.export', {}, 'Izvezi odabrane fotografije.');
  }
  return steps;
}

/**
 * Deterministic local planner. It is intentionally conservative: it handles
 * concrete RapidRAW operations and measurable slider commands, and leaves
 * ambiguous creative language to the AI planner. It never pretends that an AI
 * provider was used.
 */
export function planLocally(
  prompt: string,
  context: AgentContext,
  activeSkill: AgentSkill | null = null,
): AgentPlanResponse {
  const text = prompt.toLowerCase();
  // A skill is a deliberate workflow choice. Do not auto-apply a full recipe
  // just because one trigger word appears in an otherwise specific command;
  // the AI planner may match skills, but the deterministic fallback stays
  // conservative and only uses an explicitly selected skill.
  const skill = activeSkill;
  const steps = skillSteps(skill, prompt);
  const add = (tool: string, params: Record<string, unknown> = {}, note?: string) => {
    if (!steps.some((step) => step.tool === tool)) steps.push({ tool, params, note });
  };
  const has = (tool: string) => steps.some((step) => step.tool === tool);

  if (/\b(undo|poništi|ponisti|vrati zadnje)\b/i.test(text)) add('history.undo', {}, 'Vrati zadnju promjenu.');
  if (/\b(redo|ponovi)\b/i.test(text)) add('history.redo', {}, 'Ponovi promjenu.');

  if (/\b(denoise|odšumi|odsumi|odšumljavanje|odsumljavanje|noise reduction|ukloni šum|ukloni sum)\b/i.test(text)) {
    const value = findValue(text, ALIASES.lumaNoiseReduction)?.value;
    const intensity =
      value !== null && value !== undefined ? (Math.abs(value) > 1 ? Math.abs(value) : Math.abs(value) * 100) : 45;
    add('photo.denoise', { intensity: Math.round(intensity), method: 'ai' }, 'Denoise prije kreativne obrade.');
  }

  if (/\b(hdr|bracket|bracketing|spoji ekspozicije|merge exposures)\b/i.test(text) && !has('photo.hdr')) {
    add('photo.hdr', {}, 'HDR spajanje bracketa.');
  }
  if (/\b(panorama|pano|spoji panoramu|stitch)\b/i.test(text) && !has('photo.panorama')) {
    add('photo.panorama', {}, 'Spajanje panorame.');
  }
  if (
    /\b(focus[ -]?stack|fokus[ -]?stack|stack focus|fokusiraj sve|dubina polja)\b/i.test(text) &&
    !has('photo.focus-stack')
  ) {
    add('photo.focus-stack', {}, 'Focus stacking.');
  }
  if (/\b(negative|negativ|pozitiv)\b/i.test(text) && /\b(sken|scan|film)\b/i.test(text)) {
    add('photo.negative', {}, 'Pretvori negativ u pozitiv.');
  }
  if (/\b(cull|selekcija|odaberi najbolje|izbaci loše|izbaci lose|best of)\b/i.test(text)) {
    add('library.cull', {}, 'Sadržajna selekcija.');
  }

  if (
    /\b(auto[ -]?tone|auto[ -]?adjust|poboljšaj|poboljsaj|popravi|ispravi ekspoziciju|uravnoteži|uravnotezi|fix exposure)\b/i.test(
      text,
    )
  ) {
    add('photo.auto-tone', {}, 'Auto ton kao sigurna baza.');
  }

  if ((has('photo.hdr') || has('photo.panorama') || has('photo.focus-stack')) && !has('photo.auto-tone')) {
    add('photo.auto-tone', {}, 'Uravnoteži spojeni rezultat bez HDR izgleda.');
  }

  if (/\b(auto[ -]?straighten|straighten|poravnaj|ispravi horizont|horizont|nagnuto)\b/i.test(text)) {
    add('photo.auto-straighten', {}, 'Poravnaj horizont.');
  }

  if (/\b(auto[ -]?lens|lens correction|korekcija objektiva|distorzija|vinjetiranje objektiva)\b/i.test(text)) {
    add('photo.auto-lens', {}, 'Profil objektiva.');
  }

  const ratio = ratioFrom(text);
  if (ratio) add('photo.crop', { ratio }, `Krop ${ratio}.`);

  const ratingMatch = text.match(/\b([0-5])\s*(star|stars|zvjezdic|zvjezdice)\b/i);
  if (ratingMatch) add('library.rate', { rating: Number(ratingMatch[1]) }, `Ocjena ${ratingMatch[1]} zvjezdica.`);
  if (/\b(reject|odbaci|odbij|označi kao loše|oznaci kao lose)\b/i.test(text)) {
    add('library.flag', { flag: 'reject' }, 'Označi kao odbačeno.');
  } else if (/\b(pick|odaberi|označi|oznaci|favorit)\b/i.test(text) && !has('library.cull')) {
    add('library.flag', { flag: 'pick' }, 'Označi kao odabrano.');
  }

  const folderMatch = prompt.match(/((?:[A-Za-z]:\\|\/)[^\s"']+)/);
  if (/\b(export|izvezi|izvoz|exportiraj)\b/i.test(text)) {
    const sameFolder = /\b(originalnu mapu|pored originala|u istu mapu|next to the original|same folder)\b/i.test(text);
    if (folderMatch?.[1] || sameFolder) {
      const outputFolder = sameFolder
        ? 'originalFolder'
        : folderMatch![1].replace(/^[`"']+/, '').replace(/[`"'.,;:!?]+$/, '');
      const format = /\b(tiff|tif)\b/i.test(text) ? 'tiff' : /\b(png)\b/i.test(text) ? 'png' : 'jpeg';
      const longEdgeMatch = text.match(/\b(?:long edge|duža strana|duza strana|resize)\D{0,8}(\d{3,5})\b/i);
      add(
        'library.export',
        {
          outputFolder,
          format,
          quality: 90,
          ...(longEdgeMatch ? { longEdge: Number(longEdgeMatch[1]) } : {}),
        },
        sameFolder ? 'Izvezi pored originala.' : 'Izvezi u navedenu mapu.',
      );
    }
  }

  const { patch, labels } = buildPatch(text);
  if (Object.keys(patch).length > 0) {
    add('settings.patch', { patch }, `Postavke: ${labels.join(', ')}.`);
  }

  const creative = hasAny(text, STYLE_WORDS);
  const explicitlyStyle = /\b(style|stil|look|izgled|grade|obrada|uredi|edit|make it|napravi|pretvori)\b/i.test(text);
  const alreadyStyled = has('photo.prompt-style');
  const hasConcreteOperation = steps.some((step) => step.tool !== 'photo.inspect');
  if (
    !alreadyStyled &&
    (creative || (explicitlyStyle && !hasConcreteOperation && !Object.keys(patch).length && !has('photo.auto-tone')))
  ) {
    add(
      'photo.prompt-style',
      {
        prompt,
        variant: variantFrom(text),
        intensity: 78,
      },
      'Generiraj koherentan look iz opisa.',
    );
  }

  if (/\bhistogram\b/i.test(text) && !has('photo.histogram')) {
    add('photo.histogram', {}, 'Provjeri histogram nakon promjene.');
  }

  if (steps.length === 0) {
    add('photo.inspect', {}, 'Nema dovoljno konkretne naredbe; provjeri trenutno stanje.');
  }

  const selected = context.selectedPath?.split(/[\\/]/).pop() || '';
  const summary = steps.length
    ? `Lokalni plan${skill ? ` (${skill.name})` : ''}${selected ? ` za ${selected}` : ''}: ${steps.length} koraka.`
    : 'Nisam pronašao izvršivu naredbu.';
  return { summary, steps, planner: 'local', rejected: [] };
}

export async function planWithAi(
  prompt: string,
  context: AgentContext,
  activeSkill: AgentSkill | null,
  explicitlySelectedSkill = false,
): Promise<AgentPlanResponse> {
  const result = await invoke<AgentPlanResponse>(Invokes.PlanEditAgent, {
    prompt,
    context: formatContextForPlanner(context),
    catalog: buildToolCatalogText(),
    skills: buildSkillsText(activeSkill),
    toolIds: AGENT_TOOL_IDS,
  });
  return planScopeGuard(prompt, { ...result, planner: result.planner || 'ai' }, explicitlySelectedSkill);
}

export function describeLocalFallback(reason: string): string {
  return `AI planer nije dostupan (${reason}). Koristim ugrađeni lokalni planer — rezultat je i dalje stvarna RapidRAW obrada.`;
}
