#!/usr/bin/env node
// A stand-in for the Claude Code CLI in process.test.mjs: reads one stream-json user message, answers like `claude -p`.
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const msg = JSON.parse(input.split('\n')[0]);
  const text = msg.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const images = msg.message.content.filter((c) => c.type === 'image').length;
  const model = process.argv[process.argv.indexOf('--model') + 1];
  let answer;
  if (text.includes('repair one photo')) answer = { patch: { exposure: -1.5 }, why: 'highlights were blown' };
  else if (text.includes('plan the edit')) answer = { adjustments: { exposure: 0.3, brightness: 12 }, aiMasks: [{ type: 'face', name: 'Face lift', patch: { exposure: 0.3 } }], perPhoto: { 0: { shadows: 10 } }, autoTone: true, notes: 'warm' };
  else answer = { photos: Array.from({ length: images }, (_, i) => ({ index: i, score: i === 0 ? 8 : 3, keep: i === 0, eyesClosed: i !== 0, note: 'ok' })) };
  const leaked = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY'].filter((k) => process.env[k]);
  const out = [
    { type: 'system', subtype: 'init', apiKeySource: process.env.FAKE_CLAUDE_KEY_SOURCE ?? 'none', model },
    { type: 'result', subtype: 'success', is_error: leaked.length > 0, result: leaked.length ? `leaked ${leaked}` : JSON.stringify(answer), usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  process.stdout.write(out.map((o) => JSON.stringify(o)).join('\n') + '\n');
});
