// Release notes za vX.Y.Z-web: rrweb/RELEASE_NOTES.md + naslov upstream releasea + promjene rapidraw-web sloja
// (commitovi na main koji diraju rrweb/ i rrweb workflowe) od prethodnog -web taga.
// Treba punu git povijest i origin/main (actions/checkout s fetch-depth: 0).
//   node rrweb/release-notes.mjs v1.6.5-web > notes.md      (GH_TOKEN opcionalno, za GitHub API)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tag = process.argv[2] ?? '';
if (!/^v.+-web$/.test(tag)) throw new Error('usage: node rrweb/release-notes.mjs vX.Y.Z-web');
const up = tag.slice(0, -'-web'.length);
const LAYER = ['rrweb', '.github/README.md', '.github/workflows/rrweb-release.yml', '.github/workflows/rrweb-sync.yml'];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let title = `RapidRAW ${up}`;
try {
  const r = await fetch(`https://api.github.com/repos/CyberTimon/RapidRAW/releases/tags/${up}`,
    { headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {} });
  if (r.ok) title = (await r.json()).name || title;
} catch { /* bez naslova, ostaje "RapidRAW vX.Y.Z" */ }

const tags = git('tag', '--list', 'v*-web', '--sort=v:refname').split('\n').filter(Boolean);
const i = tags.indexOf(tag);
const prev = i > 0 ? tags[i - 1] : undefined;
let changes = '- First rapidraw-web release.';
if (prev) {
  // -web tag = upstream release + jedan overlay commit s main-a, napravljen u trenutku synca
  const since = git('log', '-1', '--format=%cI', prev);
  const until = git('log', '-1', '--format=%cI', tag);
  const log = git('log', 'origin/main', '--no-merges', `--since=${since}`, `--until=${until}`, '--format=- %s', '--', ...LAYER);
  changes = log || `- No changes to the web layer since ${prev}; this release follows RapidRAW.`;
}

process.stdout.write(readFileSync('rrweb/RELEASE_NOTES.md', 'utf8')
  .replaceAll('{{UPSTREAM_TAG}}', () => up)
  .replaceAll('{{UPSTREAM_TITLE}}', () => title)
  .replaceAll('{{RRWEB_CHANGES}}', () => changes));
