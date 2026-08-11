import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDaemon } from '@heapcode/core';

/**
 * Bundled to dist/daemon.js and spawned detached by the CLI when nothing is
 * listening on the socket (docs/phase3-protocol-design.md §6). The daemon
 * itself lives in @heapcode/core; this is only the entry point, because the
 * CLI is what actually gets built and installed.
 *
 * That is also why the wasm directory is resolved here rather than in core:
 * esbuild copies the tree-sitter assets to dist/wasm beside this bundle
 * (esbuild.mjs:17-24), and this bundle is ESM, so `import.meta.url` is how
 * it finds itself — exactly what cli.tsx:23-24 does for the CLI process.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

void runDaemon({ wasmDir: join(__dirname, 'wasm') }).then((code: number) => {
  if (code !== 0) process.exit(code);
});
