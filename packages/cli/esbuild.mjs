import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

/**
 * Same reasoning as packages/vscode/esbuild.mjs: get_symbols (CLI-M1) needs
 * web-tree-sitter's runtime + grammar wasm files as plain assets alongside
 * the bundle — esbuild doesn't see them since they're only ever read by
 * filesystem path at runtime (configureAstChunker in cli.tsx), never
 * imported. Copied once per build/watch start.
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
  // dist/daemon.js is the core server's entry point — the CLI autostarts it
  // detached when nothing is listening (docs/phase3-protocol-design.md §6).
  entryPoints: ['src/cli.tsx', 'src/daemon.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: 'dist',
  // The createRequire line works around a well-known esbuild+ESM-output
  // limitation: bundled CJS deps that call require('some-builtin') (e.g.
  // signal-exit → require('assert')) hit esbuild's synthesized __require
  // shim, which throws at runtime for anything not statically bundled.
  // Defining a real `require` here makes esbuild wire straight to it
  // instead of generating that throwing shim.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
  // fsevents: optional native/binary dep some transitive packages probe for
  // at require-time; keeping it external matches guardrail #5 (no
  // native-module dependency the CLI can't run without).
  external: ['fsevents'],
  // react-devtools-core: Ink's optional DEV-mode devtools hook statically
  // imports it; esbuild's ESM output hoists that import to top-level
  // regardless of the runtime DEV-env-var guard around it, so `external`
  // alone leaves an unresolvable import in the shipped bundle. Alias to a
  // local no-op stub instead — see react-devtools-core-stub.js.
  alias: { 'react-devtools-core': './react-devtools-core-stub.js' },
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('watching...');
} else {
  await ctx.rebuild();
  chmodSync('dist/cli.js', 0o755);
  chmodSync('dist/daemon.js', 0o755);
  await ctx.dispose();
}
