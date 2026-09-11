import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalize,
  configFile,
  secretsFile,
  workspacesFile,
  ConfigStore,
  SecretsStore,
} from '@heapcode/host';
import { DEFAULT_PORT, WorkspaceStore, isLoopback, startWebHost } from '@heapcode/web-host';
import { ChatSession } from '@heapcode/chat-host';
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
/** Heap Chat's bundle, mounted under /chat so the two share an origin and a token. */
const chatStaticDir = join(__dirname, 'chat');

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
      // Straight to the terminal the person launched this from: a sign-in
      // ends in a browser tab they then close, so the reason has to survive
      // somewhere they can still read it.
      onLog: (line) => process.stdout.write(`  ${line}\n`),
      root,
      host,
      port,
      config,
      secrets,
      // The folder picker's "Recent" list. Supplied by the CLI rather than
      // defaulted inside the host, so a host that does not offer switching
      // never quietly starts writing a file the user did not ask for.
      workspaces: new WorkspaceStore(workspacesFile()),
      staticDir,
      clientVersion: cliVersion(),
      loadInstructions: loadProjectInstructions,
      connect: (hello) => connectToServer({ client: { name: 'heapcode-web', version: cliVersion() }, ...hello }),
      // Heap Chat, alongside — the switcher in the rail is a link, and a link
      // only works if both products answer on this origin under this token.
      // The session is built on the first browser that opens /chat, so a
      // `heapcode web` nobody switches in pays nothing for it.
      mount: {
        path: '/chat',
        staticDir: chatStaticDir,
        createSession: (deps) =>
          new ChatSession({
            // The same folder the code session is pointed at.
            //
            // This reverses the reasoning that governs the standalone command,
            // and the distinction is real: `heapcode chat` is invoked with no
            // project context, so defaulting it to wherever the terminal
            // happened to be would index a repo by accident. Here you
            // deliberately ran `heapcode web` in this folder, and the toggle
            // is a view onto the same work — landing somewhere unrelated is
            // the surprising behaviour, not the safe one.
            //
            // It also inherits the workspace's existing index (both products
            // key it by root), so the toggle costs nothing instead of starting
            // a fresh embedding run over the home directory.
            root: deps.root,
            config: deps.config,
            secrets: deps.secrets,
            connect: deps.connect,
            // The same registry the code product uses: one /oauth/callback
            // on this origin answers for whichever side began the sign-in.
            mcpLogins: deps.mcpLogins,
            // Mounted here, so its attachment URLs must carry the prefix.
            basePath: '/chat',
            clientVersion: deps.clientVersion,
            workspaces: deps.workspaces,
            lan: deps.lan,
          }),
      },
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
  process.stdout.write(`  Connection: ${profile.name} (${profile.model})\n\n`);

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
