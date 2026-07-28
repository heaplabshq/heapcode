import { appendFile } from 'node:fs/promises';
import { daemonLogFile, heapcodeHome } from './address.js';
import { HeapcodeServer } from './server.js';

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
export async function main(): Promise<number> {
  const home = heapcodeHome();
  const logPath = daemonLogFile(home);
  const log = async (line: string): Promise<void> => {
    await appendFile(logPath, `${new Date().toISOString()} ${line}\n`).catch(() => {});
  };

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
