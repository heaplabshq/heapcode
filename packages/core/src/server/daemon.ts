import { appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AST_GRAMMAR_FILES, configureAstChunker } from '../rag/astChunker.js';
import { daemonLogFile, heapcodeHome } from './address.js';
import { HeapcodeServer } from './server.js';

export interface DaemonOptions {
  /**
   * Directory holding the tree-sitter runtime + grammar wasm assets. Supplied
   * by whichever host bundled this daemon, for the same reason
   * `ConnectOptions.daemonEntry` is: each host is what actually gets
   * installed, and only it knows where its own assets landed. Both hosts'
   * esbuild configs copy them to `dist/wasm` beside `dist/daemon.js`
   * (packages/cli/esbuild.mjs:17-24, packages/vscode/esbuild.mjs:17-23).
   *
   * Omitting it is not fatal, but see enableAstChunking for what it costs.
   */
  wasmDir?: string;
}

/**
 * Daemon entry point. Spawned detached by a host that found nothing
 * listening (docs/phase3-protocol-design.md §6); never started by a user
 * directly, though running it in the foreground is a perfectly good way to
 * watch what it does.
 *
 * A simultaneous-start loser exits 0 and quietly: whichever process bound
 * first owns the address, and the loser's client connects to the winner.
 *
 * Every log write is awaited rather than fired and forgotten. The one moment
 * this log matters is when startup fails — and a failed startup exits
 * immediately, which is exactly when an unawaited write gets truncated. That
 * bug turned a clear EINVAL into an empty log file and a client reporting
 * only "it did not start".
 */
export async function main(opts: DaemonOptions = {}): Promise<number> {
  const home = heapcodeHome();
  const logPath = daemonLogFile(home);
  const log = async (line: string): Promise<void> => {
    await appendFile(logPath, `${new Date().toISOString()} ${line}\n`).catch(() => {});
  };

  await enableAstChunking(opts.wasmDir, log);

  const server = new HeapcodeServer({
    home,
    onLog: (line) => void log(line),
    onIdle: () => void shutdown(0),
  });

  const shutdown = async (code: number): Promise<void> => {
    await server.close();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  try {
    await server.listen();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      // Someone else won the race — that is a success, not a failure.
      await log('another server already owns the address; exiting');
      return 0;
    }
    await log(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  await log(`listening on ${server.address} (pid ${process.pid})`);
  return new Promise<number>(() => {
    /* run until signalled or idle */
  });
}

/**
 * Wires AST-aware chunking before anything can index, mirroring what each
 * host already does for itself at startup (packages/cli/src/cli.tsx:23-24,
 * packages/vscode/src/extension.ts:40-54).
 *
 * This is not a nicety. RAG's embedding cache is keyed on `fnv1a(path:text)`
 * (packages/core/src/rag/chunker.ts:60), so a daemon that silently fell back
 * to the line-window chunker would produce different chunk boundaries than
 * the host that built the existing index — every chunk hash would miss, and
 * the whole workspace would re-embed with no error anywhere. Hence the
 * explicit log on the fallback path: a slow, expensive first index deserves a
 * reason in the log rather than a mystery.
 *
 * Exported so it can be tested without starting a daemon: `main()` binds a
 * socket and then never resolves, which makes it a poor unit under test.
 */
export async function enableAstChunking(
  wasmDir: string | undefined,
  log: (line: string) => Promise<void>,
): Promise<void> {
  if (!wasmDir) {
    await log('[rag] no wasm directory supplied — AST-aware chunking disabled, using line-window chunking');
    return;
  }
  try {
    await Promise.all(AST_GRAMMAR_FILES.map((f) => stat(join(wasmDir, f))));
    configureAstChunker((filename) => join(wasmDir, filename));
  } catch {
    await log(
      `[rag] AST-aware chunking unavailable (missing grammar assets in ${wasmDir}) — ` +
        'using line-window chunking; any existing index will re-embed in full',
    );
  }
}
