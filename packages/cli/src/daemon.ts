import { runDaemon } from '@heapcode/core';

/**
 * Bundled to dist/daemon.js and spawned detached by the CLI when nothing is
 * listening on the socket (docs/phase3-protocol-design.md §6). The daemon
 * itself lives in @heapcode/core; this is only the entry point, because the
 * CLI is what actually gets built and installed.
 */
void runDaemon().then((code: number) => {
  if (code !== 0) process.exit(code);
});
