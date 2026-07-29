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
 */
void runDaemon().then((code: number) => {
  if (code !== 0) process.exit(code);
});
