import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds to dist/, which @heapcode/web-host serves as `staticDir`.
 *
 * `base: './'` keeps asset URLs relative so the bundle does not care what path
 * it is mounted at — which is what lets the same build be served by the web
 * host today and loaded from `file://` by Electron later (WEB_APP_PLAN §11).
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One file each: a local tool loading from localhost gains nothing from
    // code splitting, and a single bundle is one less moving part in Electron.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  server: {
    port: 5273,
    proxy: {
      // `pnpm dev` runs Vite standalone; the host still owns /rpc.
      '/rpc': { target: 'ws://127.0.0.1:7411', ws: true },
    },
  },
});
