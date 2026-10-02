import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const r = (p) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: r('./bridge'),
  envPrefix: ['VITE_'],
  build: { outDir: r('./dist-bridge'), emptyOutDir: true },
});
