import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds straight into the VS Code extension's media dir with stable file
// names, so the extension can reference main.js / main.css without a manifest.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../vscode/media/webview',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: 'main[extname]',
      },
    },
  },
});
