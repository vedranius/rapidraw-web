import type { AgentSkill } from './types';
import concertHero from './skills/concert-hero.md?raw';
import portraitClean from './skills/portrait-clean.md?raw';
import hdrBracket from './skills/hdr-bracket.md?raw';
import panorama from './skills/panorama.md?raw';
import focusStack from './skills/focus-stack.md?raw';
import highIsoRescue from './skills/high-iso-rescue.md?raw';
import documentaryNoir from './skills/documentary-noir.md?raw';
import editorialColour from './skills/editorial-colour.md?raw';
import socialExport from './skills/social-export.md?raw';
import cullBurst from './skills/cull-burst.md?raw';

const CUSTOM_SKILLS_KEY = 'rapidraw.editAgent.customSkills.v1';

interface Frontmatter {
  name?: string;
  description?: string;
  triggers?: string;
  'allowed-tools'?: string;
  [key: string]: string | undefined;
}

function parseList(value?: string): string[] {
  if (!value) return [];
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function parseSkill(raw: string, builtIn: boolean): AgentSkill {
  const trimmed = raw.trim();
  let frontmatter: Frontmatter = {};
  let content = trimmed;
  if (trimmed.startsWith('---')) {
    const end = trimmed.indexOf('\n---', 3);
    if (end >= 0) {
      const block = trimmed.slice(3, end).trim();
      content = trimmed.slice(end + 4).trim();
      frontmatter = {};
      for (const line of block.split('\n')) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (match) frontmatter[match[1]] = match[2].trim();
      }
    }
  }
  const name = frontmatter.name || 'Untitled skill';
  const id = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    id,
    name,
    description: frontmatter.description || '',
    triggers: parseList(frontmatter.triggers),
    allowedTools: parseList(frontmatter['allowed-tools']),
    content,
    builtIn,
  };
}

export function parseSkillMarkdown(raw: string): AgentSkill {
  return parseSkill(raw, false);
}

export const BUILT_IN_SKILLS: AgentSkill[] = [
  concertHero,
  portraitClean,
  hdrBracket,
  panorama,
  focusStack,
  highIsoRescue,
  documentaryNoir,
  editorialColour,
  socialExport,
  cullBurst,
].map((raw) => parseSkill(raw, true));

export function loadCustomSkills(): AgentSkill[] {
  try {
    const raw = localStorage.getItem(CUSTOM_SKILLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((skill) => skill && typeof skill.name === 'string' && typeof skill.content === 'string')
      .map((skill) => ({
        id: String(skill.id || skill.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-'),
        name: String(skill.name),
        description: String(skill.description || ''),
        triggers: Array.isArray(skill.triggers) ? skill.triggers.map(String) : parseList(skill.triggers),
        allowedTools: Array.isArray(skill.allowedTools)
          ? skill.allowedTools.map(String)
          : parseList(skill.allowedTools),
        content: String(skill.content),
        builtIn: false,
      }));
  } catch {
    return [];
  }
}

export function getAllSkills(): AgentSkill[] {
  return [...BUILT_IN_SKILLS, ...loadCustomSkills()];
}

export function saveCustomSkill(skill: Omit<AgentSkill, 'builtIn' | 'id'> & { id?: string }): AgentSkill {
  const id =
    skill.id ||
    skill.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const next: AgentSkill = {
    id,
    name: skill.name.trim() || 'Untitled skill',
    description: skill.description.trim(),
    triggers: skill.triggers.filter(Boolean),
    allowedTools: skill.allowedTools.filter(Boolean),
    content: skill.content.trim(),
    builtIn: false,
  };
  const custom = loadCustomSkills().filter((entry) => entry.id !== id);
  localStorage.setItem(CUSTOM_SKILLS_KEY, JSON.stringify([...custom, next]));
  return next;
}

export function deleteCustomSkill(id: string): void {
  const custom = loadCustomSkills().filter((entry) => entry.id !== id);
  localStorage.setItem(CUSTOM_SKILLS_KEY, JSON.stringify(custom));
}

export function serializeSkillForPrompt(skill: AgentSkill): string {
  return [
    `SKILL: ${skill.name}`,
    `DESCRIPTION: ${skill.description}`,
    `TRIGGERS: ${skill.triggers.join(', ')}`,
    `ALLOWED TOOLS: ${skill.allowedTools.join(', ') || 'all'}`,
    skill.content,
  ].join('\n');
}

export function buildSkillsText(activeSkill: AgentSkill | null): string {
  if (activeSkill) {
    return `The user selected this skill. Follow it unless the explicit request contradicts it.\n\n${serializeSkillForPrompt(activeSkill)}`;
  }
  const summaries = getAllSkills()
    .map((skill) => `- ${skill.name}: ${skill.description} (triggers: ${skill.triggers.join(', ')})`)
    .join('\n');
  return `Available skills. If one clearly matches the request, follow its recipe even though the full text is not shown.\n${summaries}`;
}

export function matchSkill(prompt: string): AgentSkill | null {
  const lower = prompt.toLowerCase();
  let best: { skill: AgentSkill; score: number } | null = null;
  for (const skill of getAllSkills()) {
    let score = 0;
    if (lower.includes(skill.name.toLowerCase())) score += 10;
    for (const trigger of skill.triggers) {
      if (trigger && lower.includes(trigger.toLowerCase())) score += 3;
    }
    if (score > 0 && (!best || score > best.score)) best = { skill, score };
  }
  return best?.skill ?? null;
}
