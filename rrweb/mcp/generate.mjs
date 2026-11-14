// Generates what the MCP server and AI clients need from the AI Editor's sources (needs Node 22.18+, it imports .ts):
//   rrweb/relay/mcp-data.json            command catalog, adjustment reference, defaults, built-in skills (relay/mcp.mjs)
//   plugins/rapidraw/skills/<id>/SKILL.md the built-in skills as Agent Skills (Claude Code plugin, Claude.ai upload)
//   node rrweb/mcp/generate.mjs           write them
//   node rrweb/mcp/generate.mjs --check   fail if they are out of date (CI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkill } from '../relay/mcp.mjs';

process.removeAllListeners('warning'); // "reparsing catalog.ts as ES module"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');
const { AGENT_TOOL_CATALOG, ADJUSTMENT_REFERENCE } = await import(path.join(root, 'src/agent/catalog.ts'));
const defaults = JSON.parse(fs.readFileSync(path.join(root, 'src/utils/defaultAdjustments.json'), 'utf8'));
const version = fs.readFileSync(path.join(root, 'rrweb/VERSION'), 'utf8').trim();
const skillDir = path.join(root, 'src/agent/skills');
const raws = fs.readdirSync(skillDir).filter((f) => f.endsWith('.md')).sort().map((f) => fs.readFileSync(path.join(skillDir, f), 'utf8').trim());

const out = new Map();
out.set('rrweb/relay/mcp-data.json', JSON.stringify({ version, catalog: AGENT_TOOL_CATALOG, reference: ADJUSTMENT_REFERENCE.trim(), defaults, skills: raws }) + '\n');

const PLUGIN = 'plugins/rapidraw';
const skillMd = (s) => `---
name: ${s.id}
description: ${JSON.stringify(`${s.description} Edits the photo in RapidRAW through the rapidraw MCP server.`)}
metadata:
  title: ${JSON.stringify(s.name)}
  triggers: ${JSON.stringify(s.triggers.join(', '))}
  rapidraw-commands: ${JSON.stringify(s.commands.join(', '))}
---

<!-- mcp -->
> RapidRAW Web recipe. Use the \`rapidraw\` MCP server: \`rapidraw_status\`, then \`rapidraw_get_edit\` and
> \`rapidraw_preview\` of the photo, then run the steps below with \`rapidraw_run\` (command ids such as
> \`photo.ai-mask\`; parameters in \`rapidraw_commands\`) or slider changes with \`rapidraw_apply_adjustments\`.
> Check with \`rapidraw_preview\` and refine. \`rapidraw_undo\` reverts a run. Ask before exporting.
> Commands this recipe uses: ${s.commands.map((c) => `\`${c}\``).join(', ') || 'any'}.
<!-- /mcp -->

${s.content}
`;
for (const raw of raws) {
  const s = parseSkill(raw);
  out.set(`${PLUGIN}/skills/${s.id}/SKILL.md`, skillMd(s));
}

const pluginJson = path.join(root, PLUGIN, '.claude-plugin/plugin.json');
out.set(`${PLUGIN}/.claude-plugin/plugin.json`, JSON.stringify({ ...JSON.parse(fs.readFileSync(pluginJson, 'utf8')), version }, null, 2) + '\n');

// Agent Skills as zipped by the relay (/rr/skills.zip) for Claude.ai: the generated ones plus hand-written ones
const agentSkills = {};
const pluginSkills = path.join(root, PLUGIN, 'skills');
for (const id of fs.readdirSync(pluginSkills).sort()) {
  const rel = `${PLUGIN}/skills/${id}/SKILL.md`;
  agentSkills[id] = out.get(rel) ?? fs.readFileSync(path.join(root, rel), 'utf8');
}
const data = JSON.parse(out.get('rrweb/relay/mcp-data.json'));
out.set('rrweb/relay/mcp-data.json', JSON.stringify({ ...data, agentSkills }) + '\n');

let stale = [];
for (const [rel, content] of out) {
  const file = path.join(root, rel);
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (cur === content) continue;
  if (check) stale.push(rel);
  else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); console.log(`wrote ${rel}`); }
}
if (stale.length) { console.error(`Out of date (run node rrweb/mcp/generate.mjs):\n  ${stale.join('\n  ')}`); process.exit(1); }
