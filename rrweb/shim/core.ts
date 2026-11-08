import { call, onChannel } from './transport';

let nextChannel = 0;

// Tauri `Channel`: the marker is turned into a real Channel by rrweb/bridge/bridge.ts; messages come back as
// binary frames (or JSON for non-binary payloads) and are dispatched by rrweb/shim/transport.ts.
export class Channel<T = unknown> {
  onmessage?: (message: T) => void;
  private readonly channelId: number;

  constructor() {
    this.channelId = ++nextChannel;
    onChannel(this.channelId, (payload) => this.onmessage?.(payload as T));
  }

  toJSON() {
    return `__RR_CHANNEL__:${this.channelId}`;
  }
}

export const invoke = <T>(cmd: string, args?: Record<string, unknown>) => call<T>(cmd, args ?? {});
export const convertFileSrc = (path: string) => `/files?path=${encodeURIComponent(path)}`;
export const isTauri = () => false;
