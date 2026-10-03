// Jedna WebSocket veza prema relayu. Binarni odgovori: [u32 LE id][payload].
type Pending = { res: (v: any) => void; rej: (e: any) => void; cmd: string; t0: number };
type Handler = (payload: unknown) => void;

const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ipc`;
const pending = new Map<number, Pending>();
const handlers = new Map<string, Set<Handler>>();
const queue: string[] = [];
// trajanje i veličina odgovora (rrweb/files/network.ts prati previewe: apply_adjustments)
const timings = new Set<(cmd: string, ms: number, bytes: number) => void>();
export const onTiming = (fn: (cmd: string, ms: number, bytes: number) => void) => timings.add(fn);
const done = (p: Pending, bytes: number) => timings.forEach((fn) => fn(p.cmd, performance.now() - p.t0, bytes));
let ws: WebSocket;
let seq = 0;
let backoff = 250;

function connect() {
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    backoff = 250;
    while (queue.length) ws.send(queue.shift()!);
  };
  ws.onmessage = (m) => {
    if (m.data instanceof ArrayBuffer) {
      const id = new DataView(m.data).getUint32(0, true);
      const p = pending.get(id);
      pending.delete(id);
      if (p) { done(p, m.data.byteLength - 4); p.res(m.data.slice(4)); }
      return;
    }
    const msg = JSON.parse(m.data);
    if (msg.event !== undefined) {
      handlers.get(msg.event)?.forEach((h) => h(msg.payload));
      return;
    }
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    done(p, m.data.length);
    'error' in msg ? p.rej(msg.error) : p.res(msg.result);
  };
  ws.onclose = () => {
    pending.forEach((p) => p.rej('rrweb: connection lost'));
    pending.clear();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
}
connect();

export function call<T>(cmd: string, args: unknown = {}): Promise<T> {
  seq = (seq + 1) >>> 0 || 1;
  const id = seq;
  const frame = JSON.stringify({ id, cmd, args });
  return new Promise<T>((res, rej) => {
    pending.set(id, { res, rej, cmd, t0: performance.now() });
    ws.readyState === WebSocket.OPEN ? ws.send(frame) : queue.push(frame);
  });
}

// Event kao da je stigao s backenda (Files tab: osvježi RapidRAW library nakon izmjena na disku)
export function emitLocal(event: string, payload: unknown = null) {
  handlers.get(event)?.forEach((h) => h(payload));
}

export function on(event: string, h: Handler): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(h);
  return () => { handlers.get(event)?.delete(h); };
}
