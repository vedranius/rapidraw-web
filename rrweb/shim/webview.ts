// Webview drag/drop is not available in the browser; keep the API shape so the UI can render.
const stub: any = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'label') return 'main';
    if (prop === 'then') return undefined;
    return async (...a: unknown[]) => (typeof a[a.length - 1] === 'function' ? () => {} : undefined);
  },
});
export type DragDropEvent = { type: string; paths?: string[] };
export const getCurrentWebview = () => stub;
