// PoC: putanja na SERVERU unosi se ručno. Kasnije: modal sa server-side browserom.
import { call } from './transport';
type OpenOpts = { directory?: boolean; multiple?: boolean; defaultPath?: string; title?: string };
export async function open(opts: OpenOpts = {}): Promise<string | string[] | null> {
  const def = opts.defaultPath ?? (await call<string>('__rr_home'));
  const v = window.prompt(`${opts.title ?? (opts.directory ? 'Folder' : 'Datoteka')} na serveru:`, def);
  if (!v) return null;
  return opts.multiple ? v.split(';').map((s) => s.trim()).filter(Boolean) : v.trim();
}
export async function save(opts: { defaultPath?: string; title?: string } = {}): Promise<string | null> {
  const v = window.prompt(`${opts.title ?? 'Spremi kao'} (putanja na serveru):`, opts.defaultPath ?? '');
  return v ? v.trim() : null;
}
export const ask = async (msg: string) => window.confirm(msg);
export const confirm = ask;
export const message = async (msg: string) => window.alert(msg);
