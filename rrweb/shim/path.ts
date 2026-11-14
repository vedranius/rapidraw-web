import { call } from './transport';
export const homeDir = () => call<string>('__rr_home');
// Same result as Tauri's dirname for the relay's paths (POSIX or Windows); computed locally, no round trip.
export const dirname = async (path: string): Promise<string> => {
  const trimmed = path.replace(/(?<=.)[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) throw new Error(`path ${path} has no parent`);
  const parent = trimmed.slice(0, cut);
  if (parent === '') return trimmed[0];
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${trimmed[cut]}` : parent;
};
