// One-click update in the browser: a badge next to the version when a newer rapidraw-web release exists, a dialog
// with what's new, and "Update now", which installs it on the server (rrweb/relay/update.mjs). RapidRAW Web restarts,
// and the page reconnects by itself (shim/transport.ts).
import { call, on } from '../shim/transport';
import { el } from './ui';

type Update = { current: string | null; latest: string | null; available: boolean; canInstall: boolean; notes: string;
  url: string | null; phase: string; progress: number; error: string | null; manual: string | null };

let state: Update | null = null;
let dialog: HTMLElement | null = null;
const busy = (u: Update) => ['downloading', 'installing', 'restarting'].includes(u.phase);

// Release notes are Markdown: enough of it for headings, lists, bold and links, without injecting HTML
function renderNotes(md: string) {
  const box = el('div', { class: 'rru-notes' });
  let list: HTMLElement | null = null;
  const inline = (text: string): (Node | string)[] => {
    const out: (Node | string)[] = [];
    const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|`([^`]+)`/g;
    let at = 0;
    for (let m; (m = re.exec(text));) {
      out.push(text.slice(at, m.index));
      if (m[1]) out.push(el('b', {}, ...inline(m[1])));
      else if (m[2]) out.push(el('a', { href: m[3], target: '_blank', rel: 'noopener' }, m[2]));
      else out.push(el('code', {}, m[4]));
      at = re.lastIndex;
    }
    out.push(text.slice(at));
    return out;
  };
  // what's new only: the downloads table and the general part are for the GitHub page
  for (const raw of md.split(/^#{2,3} Downloads/m)[0].split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!list) box.append((list = el('ul')));
      list.append(el('li', {}, ...inline(li[1])));
      continue;
    }
    list = null;
    if (h) box.append(el(h[1].length <= 2 ? 'h3' : 'h4', {}, ...inline(h[2])));
    else if (line && !line.startsWith('|') && !line.startsWith('>')) box.append(el('p', {}, ...inline(line)));
  }
  return box;
}

function phaseText(u: Update) {
  if (u.phase === 'downloading') return `Downloading… ${Math.round(u.progress * 100)} %`;
  if (u.phase === 'installing') return 'Installing on the server…';
  if (u.phase === 'restarting') return 'Installed. RapidRAW Web is restarting; this page reconnects by itself.';
  if (u.phase === 'error') return `Update failed: ${u.error}${u.manual ? `. Install it by hand on the server: ${u.manual}` : ''}`;
  return u.canInstall ? 'Installs on the server and restarts RapidRAW Web (about a minute). Your edits are saved.'
    : 'This installation cannot update itself (started from the repository or an unknown package): download it from GitHub.';
}

function openDialog() {
  if (!state) return;
  dialog?.remove();
  const u = state;
  const go = el('button', { class: 'rru-go', onclick: () => { go.setAttribute('disabled', ''); call('__rr_update_apply').then(refresh, fail); } },
    u.phase === 'error' ? 'Try again' : 'Update now') as HTMLButtonElement;
  if (!u.canInstall || busy(u)) go.hidden = true;
  const bar = el('div', { class: 'rru-bar' }, el('div', { style: `width:${Math.round(u.progress * 100)}%` }));
  bar.hidden = u.phase !== 'downloading';
  dialog = el('div', { class: 'rru-back', onclick: (e: MouseEvent) => { if (e.target === dialog) close(); } },
    el('div', { class: 'rru' },
      el('h2', {}, `Update to ${u.latest}`),
      el('p', { class: 'rru-cur' }, `This server runs ${u.current}.`),
      renderNotes(u.notes),
      bar,
      el('p', { class: u.phase === 'error' ? 'rru-msg err' : 'rru-msg' }, phaseText(u)),
      el('div', { class: 'rru-actions' },
        ...(u.url ? [el('a', { href: u.url, target: '_blank', rel: 'noopener' }, 'Release on GitHub')] : []),
        el('span', { class: 'rru-grow' }),
        el('button', { onclick: close }, busy(u) ? 'Hide' : 'Later'), go)));
  document.body.append(dialog);
}
function close() { dialog?.remove(); dialog = null; }
const fail = (e: unknown) => show({ ...(state as Update), phase: 'error', error: String(e) });

let badge: HTMLElement;
function show(u: Update) {
  state = u;
  badge.hidden = !u.available;
  badge.textContent = busy(u) ? (u.phase === 'downloading' ? `Updating ${Math.round(u.progress * 100)} %` : 'Updating…') : `Update ${u.latest?.replace(/^.*-web-/, 'web ')}`;
  badge.title = `${u.latest} is available (this is ${u.current}). Click for what's new and a one-click update.`;
  if (dialog) openDialog();
}
const refresh = () => call<Update>('__rr_update_status').then(show, () => {});

export function mountUpdate(host: HTMLElement) {
  badge = el('button', { class: 'rru-badge', hidden: true, onclick: openDialog });
  host.append(badge);
  on('rr-update', (p) => show(p as Update));
  refresh();
  setInterval(refresh, 30 * 60000);
}
