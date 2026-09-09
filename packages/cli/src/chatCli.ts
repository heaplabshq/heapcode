import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalize,
  configFile,
  secretsFile,
  workspacesFile,
  ConfigStore,
  SecretsStore,
} from '@heapcode/host';
import { DEFAULT_PORT, WorkspaceStore, isLoopback } from '@heapcode/web-host';
import { startChatHost } from '@heapcode/chat-host';
import { connectToServer } from './server/client.js';
import { cliVersion } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The built Heap Chat SPA, copied to dist/chat beside dist/cli.js at build time. */
const staticDir = join(__dirname, 'chat');

/** Its own port, so `heapcode web` and `heapcode chat` can run side by side. */
export const DEFAULT_CHAT_PORT = DEFAULT_PORT + 1;

export interface ChatCliOptions {
  /** The folder to read. Defaults to the home directory, not the cwd. */
  folder?: string;
  port?: number;
  host?: string;
  dryRun?: boolean;
}

/**
 * `heapcode chat` — serve Heap Chat over a folder.
 *
 * Deliberately **not** defaulted to `process.cwd()` the way `heapcode web` is.
 * Heap Code is a tool you run inside a project; Heap Chat is one you point at
 * your documents, and defaulting to whatever directory the terminal happened
 * to be in would index a repo by accident on first run.
 */
export async function runChat(opts: ChatCliOptions = {}): Promise<number> {
  const root = canonicalize(opts.folder ? resolve(opts.folder) : homedir());
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_CHAT_PORT;

  const config = new ConfigStore(configFile());
  const secrets = new SecretsStore(secretsFile());

  const profile = await config.getActiveProfile();
  if (!profile) {
    process.stderr.write(
      'No provider connection configured yet.\nRun `heapcode` once to set one up, or `heapcode connection add`.\n',
    );
    return 1;
  }

  let running;
  try {
    running = await startChatHost({
      root,
      host,
      port,
      config,
      secrets,
      workspaces: new WorkspaceStore(workspacesFile()),
      staticDir,
      clientVersion: cliVersion(),
      connect: (hello) => connectToServer({ client: { name: 'heapchat', version: cliVersion() }, ...hello }),
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      process.stderr.write(
        `Port ${port} is already in use. Pass --port to pick another, e.g. \`heapcode chat --port ${port + 1}\`.\n`,
      );
      return 1;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  process.stdout.write(`\n  Heap Chat\n\n  ${running.url}\n\n`);
  process.stdout.write(`  Folder: ${root}\n`);
  process.stdout.write(`  Connection: ${profile.name} (${profile.model})\n\n`);

  if (!isLoopback(host)) {
    // Milder than `heapcode web`'s warning, and deliberately so: this host has
    // no tool that writes a file or runs a command. What is at stake is the
    // contents of the folder, which is quite enough to be worth saying.
    process.stdout.write(
      `  ⚠  Listening on ${host} — reachable from your network.\n` +
        `     Anyone who reaches this port AND has the token above can read\n` +
        `     every file in ${root}. Stop it when you're done.\n\n`,
    );
  }
  process.stdout.write('  Press Ctrl+C to stop.\n\n');

  if (opts.dryRun) {
    await running.close();
    return 0;
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}
