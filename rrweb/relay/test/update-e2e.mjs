// End-to-end check of one-click updates, run by .github/workflows/rrweb-update-test.yml with the Node.js and the
// update.mjs of an INSTALLED older release:  RR_TAG=<installed tag> <bundled node> update-e2e.mjs <path to update.mjs>
// Exits 0 once the new release is downloaded, verified and handed to the installer, 1 on an error.
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const { createUpdater } = await import(pathToFileURL(process.argv[2]).href);
const u = createUpdater({
  work: path.join(os.tmpdir(), 'rrweb-e2e', 'remote'),
  headless: true,
  quitBridge: () => console.log('[e2e] quit requested'),
  notify: (s) => { if (s.phase !== 'downloading') console.log(`[e2e] ${s.phase}${s.error ? `: ${s.error}` : ''}`); },
});
const st = await u.check(true);
console.log(`[e2e] installed ${st.current}, latest ${st.latest}, kind ${u.install?.kind}, canInstall ${st.canInstall}`);
if (!st.canInstall) process.exit(1);
await u.apply();
for (;;) {
  const { phase, error } = u.view();
  if (phase === 'restarting') process.exit(0);
  if (phase === 'error') { console.error(error); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}
