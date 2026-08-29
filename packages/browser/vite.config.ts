import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.config.js';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'esnext',
    // An MV3 bundle must be self-contained: the platform forbids remote code,
    // so nothing may be fetched at runtime (PRD §7.2).
    modulePreload: false,
    rollupOptions: {
      input: { sidepanel: 'src/sidepanel/index.html' },
    },
  },
  // A side panel is a normal document, so Vite's dev server works, but the
  // extension is loaded unpacked from dist/ — see README.
  server: { port: 5174, strictPort: true, hmr: { port: 5174 } },
});
