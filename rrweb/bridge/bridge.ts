// Radi UNUTAR pravog RapidRAW (Tauri) procesa, umjesto UI-ja.
// Prima pozive s relaya, zove pravi invoke(), vraća rezultat; prosljeđuje sve evente.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { EVENTS } from './events';

const RELAY: string = import.meta.env.VITE_RR_RELAY ?? 'ws://127.0.0.1:8780/bridge';
const s = document.getElementById('s')!;
let ws: WebSocket | undefined;
let calls = 0;

const send = (o: unknown) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
EVENTS.forEach((ev) => listen(ev, (e) => send({ event: ev, payload: e.payload })));

// Na Windowsu/macOS-u RapidRAW po defaultu crta preview izravno u nativni prozor (wgpu surface)
// i vraća "WGPU_RENDER" umjesto slike → browser ništa ne vidi. Bridge ga zato uvijek drži isključenim.
// Mora prije prvog obrade slike: GPU kontekst (i surface) se stvara lijeno.
type Settings = Record<string, unknown>;
async function disableNativeRenderer() {
  const s = await invoke<Settings>('load_settings');
  if (s.useWgpuRenderer !== false) await invoke('save_settings', { settings: { ...s, useWgpuRenderer: false } });
}

function connect() {
  const sock = new WebSocket(RELAY);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => { s.innerHTML = `<b>connected</b> → ${RELAY}`; };
  sock.onclose = () => { s.textContent = `relay offline, retry… (${RELAY})`; setTimeout(connect, 1000); };
  sock.onmessage = async (m) => {
    const { id, cmd, args } = JSON.parse(m.data);
    if (cmd === 'save_settings' && args?.settings) args.settings.useWgpuRenderer = false;
    try {
      const result: unknown = await invoke(cmd, args);
      const bytes = result instanceof ArrayBuffer ? new Uint8Array(result)
        : result instanceof Uint8Array ? result : null;
      if (bytes) {
        const frame = new Uint8Array(4 + bytes.byteLength);
        new DataView(frame.buffer).setUint32(0, id, true);
        frame.set(bytes, 4);
        sock.send(frame);
      } else send({ id, result: result ?? null });
    } catch (error) {
      send({ id, error: String(error) });
    }
    s.innerHTML = `<b>connected</b> → ${RELAY}<br>calls: ${++calls}<br>last: ${cmd}`;
  };
}
disableNativeRenderer().catch((e) => console.error('rrweb: useWgpuRenderer', e)).finally(connect);
