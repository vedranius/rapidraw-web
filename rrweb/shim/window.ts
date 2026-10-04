// Prozor u browseru nema smisla: svaka metoda je async no-op.
// Ako je zadnji argument callback (onResized, listen...), vraća unlisten fn.
const stub: any = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'label') return 'main';
    if (prop === 'then') return undefined;
    return async (...a: unknown[]) => (typeof a[a.length - 1] === 'function' ? () => {} : undefined);
  },
});
export const getCurrentWindow = () => stub;
