import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, configFile, secretsFile, ConfigStore, SecretsStore } from '@heapcode/host';
import { DEFAULT_PORT, isLoopback, startWebHost } from '@heapcode/web-host';
import { loadProjectInstructions } from './memory.js';
import { connectToServer } from './server/client.js';
import { cliVersion } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The built SPA, copied to dist/web beside dist/cli.js at build time
 * (esbuild.mjs). Same reasoning as dist/wasm and dist/daemon.js: only the host
 * that actually gets installed knows where its own assets landed.
 */
const staticDir = join(__dirname, 'web');

export interface WebCliOptions {
  port?: number;
  host?: string;
  /** Print the URL and exit rather than serving — used by tests. */
  dryRun?: boolean;
}

/**
 * `heapcode web` — serve the browser UI for this workspace.
 *
 * The CLI's job here is only the three things a shared package cannot know:
 * where this host's config lives, where its bundled daemon sits (supplied by
 * `connectToServer` in ./server/client.js), and its own version. Everything
 * else is @heapcode/web-host.
 */
export async function runWeb(opts: WebCliOptions = {}): Promise<number> {
  const root = canonicalize(process.cwd());
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_PORT;

  const config = new ConfigStore(configFile());
  const secrets = new SecretsStore(secretsFile());

  const profile = await config.getActiveProfile();
  if (!profile) {
    process.stderr.write(
      'No provider profile configured yet.\nRun `heapcode` once to set one up, or `heapcode profile add`.\n',
    );
    return 1;
  }

  let running;
  try {
    running = await startWebHost({
      root,
      host,
      port,
      config,
      secrets,
      staticDir,
      clientVersion: cliVersion(),
      loadInstructions: loadProjectInstructions,
      connect: (hello) => connectToServer({ client: { name: 'heapcode-web', version: cliVersion() }, ...hello }),
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      process.stderr.write(
        `Port ${port} is already in use. Pass --port to pick another, e.g. \`heapcode web --port ${port + 1}\`.\n`,
      );
      return 1;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  process.stdout.write(`\n  Heap Code Web\n\n  ${running.url}\n\n`);
  process.stdout.write(`  Workspace: ${root}\n`);
  process.stdout.write(`  Profile:   ${profile.name} (${profile.agentModel || profile.model})\n\n`);

  if (!isLoopback(host)) {
    // Loud, because this is the one flag that turns a personal tool into a
    // network service that runs shell commands (WEB_APP_PLAN §6.2).
    process.stdout.write(
      `  ⚠  Listening on ${host} — reachable from your network.\n` +
        `     Anyone who reaches this port AND has the token above can run\n` +
        `     commands on this machine as you. Stop it when you're done.\n\n`,
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
