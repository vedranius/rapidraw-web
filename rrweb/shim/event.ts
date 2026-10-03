import { on } from './transport';
export type UnlistenFn = () => void;
type Ev<T> = { event: string; id: number; payload: T };
export async function listen<T>(event: string, handler: (e: Ev<T>) => void): Promise<UnlistenFn> {
  return on(event, (payload) => handler({ event, id: 0, payload: payload as T }));
}
export async function once<T>(event: string, handler: (e: Ev<T>) => void): Promise<UnlistenFn> {
  const un = on(event, (payload) => { un(); handler({ event, id: 0, payload: payload as T }); });
  return un;
}
