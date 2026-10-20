import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Builds to dist/, which `heapcode web` serves at /notes. */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  server: {
    port: 5276,
    proxy: {
      '/rpc': { target: 'ws://127.0.0.1:7412', ws: true },
    },
  },
});
