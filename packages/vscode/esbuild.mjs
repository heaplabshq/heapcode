import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

/**
 * AST-aware chunking (packages/core/src/rag/astChunker.ts) needs its
 * tree-sitter runtime + grammar wasm files as plain assets alongside the
 * bundle — esbuild doesn't see them since they're only ever read by
 * filesystem path at runtime, never imported. Copied once per build/watch
 * start; grammar wasm binaries never change during dev.
 */
function copyWasmAssets() {
  const outDir = 'dist/wasm';
  mkdirSync(outDir, { recursive: true });
  copyFileSync(require.resolve('web-tree-sitter/tree-sitter.wasm'), join(outDir, 'tree-sitter.wasm'));
  for (const grammar of ['typescript', 'tsx', 'javascript', 'python']) {
    copyFileSync(
      require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`),
      join(outDir, `tree-sitter-${grammar}.wasm`),
    );
  }
}
copyWasmAssets();

const ctx = await esbuild.context({
  // dist/daemon.js is the core server's entry point — the extension
  // autostarts it detached when nothing is listening on the socket
  // (docs/phase3-protocol-design.md §6). Its own entry, not a mode of
  // extension.js, because it runs outside any extension host.
  entryPoints: ['src/extension.ts', 'src/daemon.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outdir: 'dist',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
