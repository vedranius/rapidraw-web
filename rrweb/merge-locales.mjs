// Merge upstream locale conflicts without dropping the AI-layer keys.
// Upstream wins on shared keys; keys that exist only in our side are kept.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const conflicted = git('diff', '--name-only', '--diff-filter=U')
  .split('\n')
  .filter((file) => file.startsWith('src/i18n/locales/') && file.endsWith('.json'));

const merge = (theirs, ours) => {
  if (!theirs || typeof theirs !== 'object' || Array.isArray(theirs)) return theirs;
  if (!ours || typeof ours !== 'object' || Array.isArray(ours)) return theirs;
  const out = { ...theirs };
  for (const [key, value] of Object.entries(ours)) {
    if (!(key in out)) out[key] = value;
    else if (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = merge(out[key], value);
    }
  }
  return out;
};

for (const file of conflicted) {
  const ours = JSON.parse(git('show', `:2:${file}`));
  const theirs = JSON.parse(git('show', `:3:${file}`));
  writeFileSync(file, `${JSON.stringify(merge(theirs, ours), null, 2)}\n`);
  git('add', file);
  console.log(`merged locales: ${file}`);
}

if (!conflicted.length) {
  console.log('no locale conflicts');
}
