import { appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AST_GRAMMAR_FILES, configureAstChunker } from '../rag/astChunker.js';
import { daemonLogFile, heapcodeHome } from './address.js';
import { HeapcodeServer } from './server.js';

export interface DaemonOptions {
  /**
   * This bundle's own path, so the daemon can notice it has been rebuilt.
   *
   * A daemon outlives the session that spawned it -- that is the point of it --
   * which means it also outlives a `pnpm build`. It then keeps answering with
   * the code it started with, and every client sees a fix that is demonstrably
   * on disk fail to take effect, with nothing anywhere saying why. That cost a
   * real debugging session: a rebuilt bundle, a restarted host, and a daemon
   * from the previous day quietly serving the old behaviour.
   *
   * Supplied by the host for the same reason `wasmDir` is: the host is what
   * gets built and installed, so only it knows where its bundle landed.
   */
  entryFile?: string;
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
  if (opts.entryFile) void retireOnRebuild(opts.entryFile, server, log, shutdown);
  return new Promise<number>(() => {
    /* run until signalled, idle, or rebuilt */
  });
}

/** How often the daemon checks whether it has been rebuilt underneath itself. */
const REBUILD_POLL_MS = 5_000;

/**
 * Exit once this bundle has been rebuilt and nothing is still using us.
 *
 * Polled rather than watched: `fs.watch` on a file esbuild replaces by rename
 * stops reporting after the first swap, which is precisely the case that has to
 * keep working. A stat every few seconds costs nothing next to what the daemon
 * is otherwise doing.
 *
 * It never interrupts work: a rebuild mid-run leaves the run alone and the
 * exit waits for it, because killing a live agent because a file changed on
 * disk is worse than serving stale code for another minute.
 *
 * It waits for *work*, not for hosts. The first version waited until no
 * session was attached, and a session lives as long as its host does -- a
 * browser tab left open, an editor window, a terminal. Nobody quits all three,
 * so nothing ever retired and the whole thing was ornamental: the daemon went
 * on serving the old build with a line in its log saying it intended not to.
 * Dropping an idle session costs a reconnect, which hosts do silently on their
 * next request.
 *
 * The next client finds nothing listening and spawns a daemon from the new
 * bundle.
 */
export async function retireOnRebuild(
  entryFile: string,
  server: { busy: boolean },
  log: (line: string) => Promise<void>,
  shutdown: (code: number) => Promise<void>,
  pollMs: number = REBUILD_POLL_MS,
): Promise<void> {
  const startedWith = await stat(entryFile).catch(() => undefined);
  if (!startedWith) return;

  let announced = false;
  const timer = setInterval(() => {
    void (async () => {
      const current = await stat(entryFile).catch(() => undefined);
      if (!current) return;
      if (current.mtimeMs === startedWith.mtimeMs && current.size === startedWith.size) return;

      if (!announced) {
        announced = true;
        await log(`${entryFile} was rebuilt; retiring as soon as nothing is running`);
      }
      if (server.busy) return;

      clearInterval(timer);
      await log('nothing running; exiting so the next client starts the new build');
      await shutdown(0);
    })();
  }, pollMs);
  timer.unref?.();
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
