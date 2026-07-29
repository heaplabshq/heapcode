import { join } from 'node:path';
import { runDaemon } from '@heapcode/core';

/**
 * Bundled to dist/daemon.js and spawned detached by the extension when
 * nothing is listening on the socket (docs/phase3-protocol-design.md §6).
 * The daemon itself lives in @heapcode/core; this is only the entry point,
 * because the extension is what actually gets installed.
 *
 * It is deliberately its own entry rather than a mode of extension.js: this
 * process runs outside any extension host and must never import `vscode`.
 * The spawn sets ELECTRON_RUN_AS_NODE (see core's client.ts) because the
 * extension host's process.execPath is the editor binary, not node.
 *
 * The wasm directory is resolved here rather than in core for the same
 * reason the daemon entry itself is per-host: esbuild copies the tree-sitter
 * assets to dist/wasm beside this bundle (esbuild.mjs:17-23), and only the
 * installed host knows where that landed. `__dirname` is correct because
 * this entry is bundled as CJS (esbuild.mjs:37) — unlike the extension
 * itself, which reads the same directory through `context.extensionUri`
 * (extension.ts:44).
 */
void runDaemon({ wasmDir: join(__dirname, 'wasm') }).then((code: number) => {
  if (code !== 0) process.exit(code);
});
