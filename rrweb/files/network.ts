// Kvaliteta previewa prema vezi sa serverom. RapidRAW već ima veličinu previewa (editorPreviewResolution) i kvalitetu
// live previewa (livePreviewQuality: performance / high / full); backend ih čita kod svakog rendera.
// Jednom po kartici (i na klik) mjeri ping i brzinu preuzimanja, predloži postavke, a za vrijeme rada prati
// stvarne previewe (apply_adjustments) i javi kad postanu spori.
import { call, onTiming } from '../shim/transport';
import { el } from './ui';

type Quality = 'performance' | 'high' | 'full';
type Reco = { resolution: number; quality: Quality; why: string };
type Measure = { mbps: number; rtt: number; at: number };

const QUALITY_LABEL: Record<Quality, string> = { performance: 'Performance', high: 'High', full: 'Full' };

export function recommend(mbps: number, rtt: number): Reco {
  if (mbps < 5 || rtt > 200) return { resolution: 1280, quality: 'performance', why: 'slow or distant connection' };
  if (mbps < 15) return { resolution: 1920, quality: 'performance', why: 'mobile-class connection' };
  if (mbps < 50) return { resolution: 1920, quality: 'high', why: 'good connection' };
  return { resolution: 2560, quality: 'high', why: 'fast connection (LAN)' };
}

async function measure(): Promise<Measure> {
  const rtts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await call('__rr_ping');
    rtts.push(performance.now() - t);
  }
  rtts.sort((a, b) => a - b);
  // preuzimanje: kreće s 1 MB i raste dok jedan dohvat ne traje ~1 s (najviše 16 MB)
  let bytes = 1 << 20;
  let mbps = 0;
  for (;;) {
    const t = performance.now();
    const r = await fetch(`/rr/speed?bytes=${bytes}&t=${Date.now()}`, { cache: 'no-store' });
    const n = (await r.arrayBuffer()).byteLength;
    const s = (performance.now() - t) / 1000;
    mbps = (n * 8) / s / 1e6;
    if (s > 0.8 || bytes >= 16 << 20) break;
    bytes = Math.min(bytes * 4, 16 << 20);
  }
  return { mbps, rtt: rtts[2], at: Date.now() };
}

export function mountNetwork(tabs: HTMLElement) {
  let last: Measure | null = null;
  let settings: Record<string, unknown> = {};
  const recent: { ms: number; bytes: number }[] = []; // zadnji previewi
  const badge = el('button', { class: 'rrn-badge', title: 'Connection to the server and preview quality' }, '…');
  const panel = el('div', { class: 'rrn-panel', hidden: true });
  tabs.append(badge);
  document.body.append(panel);

  const current = () => ({ resolution: Number(settings.editorPreviewResolution ?? 1920), quality: (settings.livePreviewQuality ?? 'high') as Quality });
  const differs = (r: Reco) => r.resolution !== current().resolution || r.quality !== current().quality;
  const previewStats = () => {
    if (recent.length < 3) return null;
    const ms = recent.reduce((s, x) => s + x.ms, 0) / recent.length;
    const kb = recent.reduce((s, x) => s + x.bytes, 0) / recent.length / 1024;
    return { ms, kb };
  };

  function render() {
    const r = last && recommend(last.mbps, last.rtt);
    const p = previewStats();
    const slow = p && p.ms > 400;
    badge.textContent = !last ? '…' : last.mbps >= 1000 ? `${(last.mbps / 1000).toFixed(1)} Gb/s`
      : `${last.mbps < 10 ? last.mbps.toFixed(1) : Math.round(last.mbps)} Mb/s`;
    badge.className = `rrn-badge${(r && differs(r)) || slow ? ' warn' : ''}`;
    const c = current();
    panel.replaceChildren(
      el('b', {}, 'Connection to the server'),
      el('p', {}, last ? `${last.mbps.toFixed(1)} Mbit/s download · ${Math.round(last.rtt)} ms ping` : 'Measuring…'),
      ...(p ? [el('p', { class: slow ? 'rrn-warn' : '' }, `Recent previews: ${Math.round(p.kb)} KB in ${Math.round(p.ms)} ms on average${slow ? ' (slow, a lower setting will feel smoother)' : ''}`)] : []),
      el('p', {}, `Current preview: ${c.resolution} px, ${QUALITY_LABEL[c.quality] ?? c.quality}`),
      ...(r ? [el('p', {}, el('b', {}, `Recommended: ${r.resolution} px, ${QUALITY_LABEL[r.quality]}`), ` (${r.why})`)] : []),
      el('div', { class: 'rrn-actions' },
        el('button', { onclick: () => test() }, 'Test again'),
        ...(r && differs(r) ? [el('button', { class: 'primary', onclick: () => apply(r) }, 'Apply (reloads the editor)')] : [])),
      el('p', { class: 'rrn-note' }, 'Sizes and quality can also be set in RapidRAW: Settings → Processing.'));
  }

  async function loadSettings() {
    settings = await call<Record<string, unknown>>('load_settings').catch(() => settings);
  }

  async function test() {
    last = null;
    render();
    try {
      await loadSettings();
      last = await measure();
      try { sessionStorage.setItem('rrweb-net', JSON.stringify(last)); } catch { /* nema storagea */ }
    } catch { /* relay nedostupan; pokušaj na klik */ }
    render();
    const r = last && recommend(last.mbps, last.rtt);
    if (r && differs(r)) panel.hidden = false; // predloži odmah
  }

  // RapidRAW drži postavke u memoriji UI-ja: nakon spremanja ga ponovno učitaj, inače bi ih prepisao starima
  async function apply(r: Reco) {
    await loadSettings();
    await call('save_settings', { settings: { ...settings, editorPreviewResolution: r.resolution, livePreviewQuality: r.quality } });
    location.reload();
  }

  onTiming((cmd, ms, bytes) => {
    if (cmd !== 'apply_adjustments' || bytes < 1024) return;
    recent.push({ ms, bytes });
    if (recent.length > 20) recent.shift();
    if (recent.length % 5 === 0) render();
  });
  badge.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) render(); };
  document.addEventListener('mousedown', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== badge) panel.hidden = true;
  });

  try { last = JSON.parse(sessionStorage.getItem('rrweb-net') ?? 'null'); } catch { last = null; }
  if (last) loadSettings().then(render);
  else setTimeout(test, 1500); // jednom po kartici, nakon što se RapidRAW učita
  render();
}
