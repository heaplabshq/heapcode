import esbuild from 'esbuild';
import { chmodSync } from 'node:fs';

const watch = process.argv.includes('--watch');

// NOTE: once CLI-M1 (get_symbols via core's tree-sitter symbol extraction)
// or CLI-M3 (RAG) land, this needs the same web-tree-sitter/tree-sitter-wasms
// asset-copy step packages/vscode/esbuild.mjs does — add `web-tree-sitter`
// and `tree-sitter-wasms` as direct deps of this package first (require.resolve
// only sees a package's own dependency tree under pnpm's strict node_modules).

const ctx = await esbuild.context({
  entryPoints: ['src/cli.tsx'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli.js',
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
  await ctx.dispose();
}
