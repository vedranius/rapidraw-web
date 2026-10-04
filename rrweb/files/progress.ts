// Što se događa dok čekaš: kod otvaranja fotke (dohvat s računala koje je dijeli, pa dekodiranje RAW-a), na
// thumbnailima koji još nisu gotovi (library i filmstrip: u redu, dohvat, renderiranje) i ukupno u traci na vrhu.
// Relayu javlja i prikaz (editor ili library), da dok je fotka otvorena ne radi teške thumbnaile.
// Podatke daje relay (__rr_progress, __rr_thumbs, __rr_thumbs_summary); RapidRAW-ov UI se ne dira, oznake se samo
// dodaju preko njegovih elemenata.
import { call, onCall } from '../shim/transport';
import { el, fmtSize } from './ui';

type Load = { phase: 'downloading' | 'decoding' | 'offline'; fetched?: number; total?: number; rate?: number; decodeMs?: number };
type Thumb = { state: 'queued' | 'preparing' | 'downloading' | 'rendering'; pos?: number; eta?: number | null; paused?: boolean; fetched?: number; total?: number };
type Summary = { left: number; heavy: number; paused: boolean; eta: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = (p: string) => p.split('?vc=')[0].split(/[\\/]/).pop() ?? p;
const secs = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);

export function mountProgress(tabs: HTMLElement) {
  const names = new Map<string, string>(); // naziv na pločici → putanja (iz update_thumbnail_queue)

  // --- otvaranje fotke u editoru ---
  const pill = el('div', { class: 'rrl-load', hidden: true });
  document.body.append(pill);
  type Cur = { path: string; t0: number; decodeFrom: number; downloaded: boolean };
  let current: Cur | null = null;

  async function watchLoad(cur: Cur) {
    await sleep(400); // brzo otvaranje bez treptanja
    while (current === cur) {
      const p = await call<Load>('__rr_progress', { path: cur.path }).catch(() => null);
      if (current !== cur) break;
      if (p) render(cur, p);
      await sleep(400);
    }
  }

  function render(cur: Cur, p: Load) {
    const name = base(cur.path);
    let text: string;
    let frac: number | null = null;
    if (p.phase === 'offline') text = `${name} · the computer with this folder is not connected`;
    else if (p.phase === 'downloading' && p.total) {
      cur.downloaded = true;
      frac = (p.fetched ?? 0) / p.total;
      const left = p.total - (p.fetched ?? 0);
      text = `${name} · downloading ${fmtSize(p.fetched ?? 0)} of ${fmtSize(p.total)}`
        + (p.rate ? ` · ${fmtSize(p.rate)}/s · ~${secs(left / p.rate)} left` : '');
    } else if (p.phase === 'downloading') { cur.downloaded = true; text = `${name} · starting the download…`; } else {
      cur.decodeFrom ||= cur.downloaded ? performance.now() : cur.t0; // lokalna fotka: dekodira se od početka
      const s = (performance.now() - cur.decodeFrom) / 1000;
      text = `${name} · decoding RAW… ${s.toFixed(1)} s${p.decodeMs ? ` (usually ~${(p.decodeMs / 1000).toFixed(1)} s)` : ''}`;
      if (p.decodeMs) frac = Math.min(0.95, s * 1000 / p.decodeMs);
    }
    pill.replaceChildren(el('div', {}, text), ...(frac !== null ? [el('div', { class: 'rrl-bar' }, el('i', { style: `width:${Math.round(frac * 100)}%` }))] : []));
    pill.hidden = false;
  }

  onCall((cmd, args, result) => {
    const a = args as { path?: unknown; paths?: unknown };
    if (cmd === 'update_thumbnail_queue' && Array.isArray(a?.paths)) {
      for (const p of a.paths) if (typeof p === 'string') names.set(base(p), p);
      scheduleThumbs();
    }
    if (cmd !== 'load_image' || typeof a?.path !== 'string') return;
    const cur: Cur = { path: a.path, t0: performance.now(), decodeFrom: 0, downloaded: false };
    current = cur;
    watchLoad(cur);
    result.then(() => {}, () => {}).finally(() => { if (current === cur) { current = null; pill.hidden = true; } });
  });

  // --- thumbnaili koji još nisu gotovi ---
  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleThumbs(ms = 600) { thumbTimer ??= setTimeout(() => { thumbTimer = null; updateThumbs(); }, ms); }

  // short: filmstrip (male pločice)
  function label(t: Thumb, short: boolean) {
    if (t.state === 'rendering') return short ? 'Rendering' : 'Rendering…';
    if (t.state === 'preparing') return short ? 'Preview…' : 'Fetching preview…';
    if (t.state === 'downloading') return `${short ? '' : 'Downloading '}${t.total ? Math.round(((t.fetched ?? 0) / t.total) * 100) : 0} %`;
    if (t.paused) return short ? 'Paused' : 'Paused while you edit';
    if (!t.pos) return 'Queued';
    return short ? `#${t.pos}${t.eta ? ` · ${secs(t.eta)}` : ''}` : `Queued #${t.pos}${t.eta ? ` · ~${secs(t.eta)}` : ''}`;
  }

  // Pločice bez thumbnaila: library grid (naziv u .truncate) i filmstrip u editoru (naziv u data-tooltip)
  function waitingTiles() {
    const res: { host: HTMLElement; tile: HTMLElement; path: string; short: boolean }[] = [];
    const add = (tile: HTMLElement, host: HTMLElement, name: string, short: boolean) => {
      const path = names.get(name);
      if (tile.querySelector('img') || !path) { tile.querySelector('.rrt-badge')?.remove(); return; }
      res.push({ host, tile, path, short });
    };
    for (const tile of document.querySelectorAll<HTMLElement>('[data-bench-id="thumbnail"]')) {
      add(tile, (tile.firstElementChild as HTMLElement) ?? tile, tile.querySelector('.truncate')?.textContent?.trim() ?? '', false);
    }
    for (const tile of document.querySelectorAll<HTMLElement>('div[data-tooltip]')) {
      if (tile.dataset.benchId || !tile.querySelector('svg.lucide-image, img') || !tile.offsetParent) continue;
      add(tile, tile, tile.dataset.tooltip ?? '', true);
    }
    return res;
  }

  async function updateThumbs() {
    const waiting = waitingTiles();
    if (waiting.length) {
      const st = await call<Record<string, Thumb>>('__rr_thumbs', { paths: [...new Set(waiting.map((w) => w.path))] }).catch(() => ({} as Record<string, Thumb>));
      for (const { host, tile, path, short } of waiting) {
        const t = st[path];
        let badge = tile.querySelector<HTMLElement>('.rrt-badge');
        if (!t || tile.querySelector('img')) { badge?.remove(); continue; }
        if (!badge) {
          badge = el('div', { class: `rrt-badge${short ? ' short' : ''}` });
          host.append(badge);
        }
        badge.textContent = label(t, short);
      }
    }
    // dok ima pločica bez slike, osvježavaj; inače čekaj sljedeći zahtjev za thumbnailima
    if (waiting.length && document.visibilityState === 'visible') scheduleThumbs(1000);
    else if (waiting.length) scheduleThumbs(3000);
  }

  // --- ukupno, u traci na vrhu (i za thumbnaile koji se ne vide) ---
  const total = el('span', { class: 'rrf-thumbs', hidden: true, title: 'Thumbnails still to make. Heavy ones (edited photos) wait while a photo is open in the editor, so editing stays fast.' });
  tabs.insertBefore(total, tabs.querySelector('.rrf-tag'));
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    const s = await call<Summary>('__rr_thumbs_summary').catch(() => null);
    if (!s || !s.left) { total.hidden = true; return; }
    total.hidden = false;
    total.textContent = s.paused && s.heavy ? `Thumbnails ${s.left} · paused while editing` : `Thumbnails ${s.left}${s.eta ? ` · ~${secs(s.eta)}` : ''}`;
  }, 2000);
  // pločice se pojavljuju i pri pomicanju (virtualni grid)
  document.addEventListener('scroll', () => scheduleThumbs(300), { capture: true, passive: true });

  // Prikaz za relay: dok je fotka otvorena u editoru nema teških thumbnaila; povratak u library ih odmah nastavlja.
  // Javlja se pri promjeni i svakih 5 s (relay bez javljanja >30 s, npr. zatvorena kartica, radi kao prije)
  let inEditor: boolean | null = null;
  let sentAt = 0;
  setInterval(() => {
    // editor ostaje u DOM-u i kad se vratiš u library (samo skriven)
    const now = !!document.querySelector<HTMLElement>('[data-bench-id="back-to-library"]')?.offsetParent;
    if (now !== inEditor || Date.now() - sentAt > 5000) {
      call('__rr_view', { mode: now ? 'editor' : 'library' }).catch(() => {});
      sentAt = Date.now();
      if (!now) scheduleThumbs(300);
    }
    inEditor = now;
  }, 1000);
}
