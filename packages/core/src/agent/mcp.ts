import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isAuthFailure, McpOAuthProvider, type McpAuthStore } from './mcpAuth.js';
import type { ToolDefinition } from './tools.js';

/**
 * One MCP server as the user configures it. Both hosts read the same shape
 * from different places — the extension from `heapcode.mcpServers` in
 * workspace settings, the CLI from `~/.heapcode/config.json` merged with a
 * project's `.heapcode/mcp.json` — which is why the config *source* is
 * injected and only the shape lives here.
 */
export interface McpServerConfig {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse transport */
  url?: string;
  transport?: 'http' | 'sse';
}

const PREFIX = 'mcp__';

/**
 * Reported to every server as `clientInfo.name` in the initialize handshake.
 *
 * The two hosts used to disagree — 'heapcode' in the CLI, 'heap-code' in the
 * extension — so unifying them had to pick one. This is the identifier the
 * rest of the product already uses (the `heapcode` binary, the `heapcode.*`
 * settings namespace, the marketplace publisher, the `~/.heapcode` config
 * dir); 'heap-code' existed only as the extension's marketplace package
 * slug, whose human-facing form is the displayName "Heap Code". clientInfo
 * is an identifier, not a display name.
 */
const CLIENT_NAME = 'heapcode';

/**
 * Sent alongside CLIENT_NAME when the host doesn't supply its own. Both
 * hosts used to hardcode '0.1.0' here, which had been wrong for both for
 * several releases; a host that knows its version should pass it.
 */
const UNKNOWN_CLIENT_VERSION = '0.0.0';

interface ConnectedServer {
  client: Client;
  tools: ToolDefinition[];
  /**
   * The definition this connection was made from.
   *
   * Kept so a server whose command or URL was edited is reconnected rather
   * than left running the old one. Without it, `ensureConnected` saw a name
   * it already had and skipped it — which is fine for a list that only ever
   * grows, and wrong the moment a settings screen can edit an entry.
   */
  spec: string;
}

/**
 * Connects the configured MCP servers and exposes their tools to the agent.
 *
 * The CLI and the extension each maintained a copy of this that differed
 * only in how it reached the outside world, so both of those are now
 * injected: `loadConfig` (a promise or a plain value — the extension's
 * settings read is synchronous, the CLI's file read isn't) and `onLog`.
 * `dispose()` is a plain method, which structurally satisfies
 * `vscode.Disposable` without this file knowing that vscode exists.
 *
 * MCP tools go through the exact same permission system as workspace tools —
 * the `permission: 'execute'` + `untrustedOutput: true` markers on each
 * generated ToolDefinition are what wire that up.
 */
export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  /**
   * Why the last connection attempt for a name failed.
   *
   * Kept because "not connected" on its own is the least useful thing a
   * settings screen can say. Both web hosts construct this manager without an
   * `onLog`, so until this existed the reason was formatted into a string and
   * dropped on the floor — a server that needs OAuth, a typo'd URL and an
   * npx package that isn't installed all looked identical.
   */
  private failures = new Map<string, string>();
  /** Servers that answered 401 and have a sign-in waiting to be started. */
  private needsAuth = new Set<string>();
  /** One per server, for sign-ins someone is driving. */
  private providers = new Map<string, McpOAuthProvider>();
  /** The same, for connection attempts — see `connectProvider`. */
  private connectProviders = new Map<string, McpOAuthProvider>();
  private connecting?: Promise<void>;

  constructor(
    private readonly loadConfig: () =>
      | Promise<Record<string, McpServerConfig>>
      | Record<string, McpServerConfig>,
    private readonly onLog?: (line: string) => void,
    /** This host's own version, reported to servers in the handshake. */
    private readonly clientVersion: string = UNKNOWN_CLIENT_VERSION,
    /**
     * Where OAuth tokens live, and the loopback URI the browser returns to.
     *
     * Both host-supplied, and both absent for a host that has nowhere to put
     * a token or no way to open a browser — in which case a server behind
     * OAuth reports `needsAuth` and stops, which is still better than the
     * bare 401 it used to report.
     */
    private readonly authStore?: McpAuthStore,
    private readonly redirectUri?: string,
  ) {}

  dispose(): void {
    for (const [, server] of this.servers) void server.client.close();
    this.servers.clear();
  }

  /** Connect configured servers (idempotent; drops removed ones). */
  ensureConnected(): Promise<void> {
    this.connecting ??= this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const config = await this.loadConfig();

    for (const name of [...this.servers.keys()]) {
      const wanted = config[name];
      if (wanted && this.servers.get(name)!.spec === JSON.stringify(wanted)) continue;
      void this.servers.get(name)!.client.close();
      this.servers.delete(name);
    }

    for (const name of [...this.failures.keys()]) {
      if (!(name in config)) this.failures.delete(name);
    }
    for (const name of [...this.needsAuth]) {
      if (!(name in config)) this.needsAuth.delete(name);
    }

    for (const [name, server] of Object.entries(config)) {
      if (this.servers.has(name)) continue;
      try {
        const client = new Client({ name: CLIENT_NAME, version: this.clientVersion || UNKNOWN_CLIENT_VERSION });
        // Attached only when the host can complete a login. Given one, the
        // SDK sends a stored token, refreshes it when stale, and re-registers
        // if the callback moved — all before `connect` returns.
        const authProvider = server.url ? this.connectProvider(name) : undefined;
        const transport = server.url
          ? server.transport === 'sse'
            ? new SSEClientTransport(new URL(server.url), { authProvider })
            : new StreamableHTTPClientTransport(new URL(server.url), { authProvider })
          : new StdioClientTransport({
              command: server.command ?? '',
              args: server.args ?? [],
              env: { ...childEnv(), ...server.env },
            });
        await client.connect(transport);
        const listed = await client.listTools();
        const tools: ToolDefinition[] = listed.tools.map((t) => ({
          name: sanitize(`${PREFIX}${name}__${t.name}`),
          description: `[MCP: ${name}] ${t.description ?? t.name}`,
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
          permission: 'execute',
          // Third-party server output — same injection posture as fetch_url.
          untrustedOutput: true,
        }));
        this.servers.set(name, { client, tools, spec: JSON.stringify(server) });
        this.failures.delete(name);
        this.needsAuth.delete(name);
        this.onLog?.(`connected "${name}" (${tools.length} tools)`);
      } catch (err) {
        // A 401 is the server working correctly and refusing us, which is a
        // waiting state rather than a fault: the remedy is a sign-in, not a
        // correction to what was typed.
        const awaiting = Boolean(server.url) && isAuthFailure(err);
        if (awaiting) this.needsAuth.add(name);
        else this.needsAuth.delete(name);
        const reason = awaiting
          ? this.canSignIn()
            ? 'Not signed in. Choose Sign in to authorize this server.'
            : explainConnectFailure(err)
          : explainConnectFailure(err);
        this.failures.set(name, reason);
        this.onLog?.(`failed to connect "${name}": ${reason}`);
      }
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.servers.values()].flatMap((s) => s.tools);
  }

  connectedServerNames(): string[] {
    return [...this.servers.keys()];
  }

  /** Why `name` is not connected, if the last attempt failed. */
  failureFor(name: string): string | undefined {
    return this.failures.get(name);
  }

  /**
   * Whether this host has somewhere to keep tokens.
   *
   * That, not the redirect URI, is what decides it: `heapcode web` knows its
   * callback at startup, but a terminal opens an ephemeral port per login and
   * passes it to `providerFor` then. Requiring the URI up front would have
   * told every terminal it could not sign in.
   */
  canSignIn(): boolean {
    return Boolean(this.authStore);
  }

  /** `name` answered 401 and a sign-in would connect it. */
  awaitingSignIn(name: string): boolean {
    return this.needsAuth.has(name) && this.canSignIn();
  }

  /**
   * The provider for a sign-in the person is driving.
   *
   * `redirectOverride` is for a host that cannot know its callback until the
   * login starts: a terminal opens an ephemeral loopback port per sign-in, so
   * the URI differs from the one this manager was built with, and a provider
   * cached under the other one would register against the wrong port. Keyed
   * by both, because a registration is only valid for the URI it was made for.
   */
  providerFor(name: string, redirectOverride?: string): McpOAuthProvider | undefined {
    return this.cachedProvider(this.providers, name, redirectOverride ?? this.redirectUri, true);
  }

  /**
   * The provider a connection attempt uses.
   *
   * Separate from the one above, and non-owning, so that reconnecting while
   * someone is on a consent screen cannot overwrite the `state` and verifier
   * their login depends on. It shares the same store, so a token it refreshes
   * and a client it registers are the real ones.
   */
  private connectProvider(name: string): McpOAuthProvider | undefined {
    return this.cachedProvider(this.connectProviders, name, this.redirectUri, false);
  }

  private cachedProvider(
    cache: Map<string, McpOAuthProvider>,
    name: string,
    redirect: string | undefined,
    owned: boolean,
  ): McpOAuthProvider | undefined {
    if (!this.authStore || !redirect) return undefined;
    const key = `${name}\u0000${redirect}`;
    let provider = cache.get(key);
    if (!provider) {
      provider = new McpOAuthProvider(name, this.authStore, redirect, owned);
      cache.set(key, provider);
    }
    return provider;
  }

  /** The configured URL for `name`, which a login has to be aimed at. */
  async serverUrl(name: string): Promise<string | undefined> {
    return (await this.loadConfig())[name]?.url;
  }

  /** Forget one server's tokens and registration, and drop its connection. */
  async signOut(name: string): Promise<void> {
    await this.authStore?.clear(name);
    for (const cache of [this.providers, this.connectProviders]) {
      for (const key of [...cache.keys()]) {
        if (key.startsWith(`${name}\u0000`)) cache.delete(key);
      }
    }
    const server = this.servers.get(name);
    if (server) {
      void server.client.close();
      this.servers.delete(name);
    }
  }

  isMcpTool(name: string): boolean {
    return name.startsWith(PREFIX);
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    const withoutPrefix = toolName.slice(PREFIX.length);
    const sep = withoutPrefix.indexOf('__');
    const serverName = withoutPrefix.slice(0, sep);
    const realTool = withoutPrefix.slice(sep + 2);
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP server "${serverName}" is not connected.`);

    const result = await server.client.callTool({ name: realTool, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
      .join('\n');
    return text || JSON.stringify(result);
  }
}

/**
 * Environment variables an MCP server is allowed to inherit.
 *
 * Matched case-insensitively, which covers both `HTTPS_PROXY` and
 * `https_proxy` and Windows' own casing of `SystemRoot`.
 */
const INHERITED_ENV: ReadonlySet<string> = new Set(
  [
    // Finding an interpreter, and the places one expects to write.
    'path',
    'home',
    'shell',
    'user',
    'logname',
    'tmpdir',
    // The SDK's own list carries TERM, and a server that formats output for a
    // terminal misbehaves without it.
    'term',
    // Text handling and dates, which change a server's *output* when absent.
    'lang',
    'lc_all',
    'lc_ctype',
    'tz',
    // Windows: node's own spawn misbehaves without SystemRoot, and package
    // managers keep their caches under APPDATA.
    'systemroot',
    'systemdrive',
    'windir',
    'pathext',
    'comspec',
    'appdata',
    'localappdata',
    'programdata',
    'programfiles',
    'programfiles(x86)',
    'temp',
    'tmp',
    'userprofile',
    'username',
    'homedrive',
    'homepath',
    'processor_architecture',
    'number_of_processors',
    'os',
    // Reaching the network at all, on a machine behind a proxy or a corporate
    // CA. Dropping these does not fail loudly — it fails as a timeout inside
    // someone else's code, which is the worst way for this to go wrong.
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'ssl_cert_file',
    'ssl_cert_dir',
    'node_extra_ca_certs',
    'requests_ca_bundle',
    'curl_ca_bundle',
  ].map((name) => name.toLowerCase()),
);

/**
 * The environment a stdio MCP server is started with.
 *
 * An allowlist, because the alternative was the whole of `process.env`. These
 * servers are third-party programs, usually fetched from a registry at the
 * moment they start (`npx -y …`, `uvx …`), and handing each one a copy of
 * every exported variable gave it whatever happened to be in the shell —
 * provider keys, cloud credentials, tokens for services it has no connection
 * to. None of that is needed to list a directory or fetch a stock price.
 *
 * What a server genuinely requires it declares in its own config, and that is
 * merged over this.
 *
 * The SDK ships `getDefaultEnvironment()` doing the same thing, and its list
 * is the starting point for this one — `StdioClientTransport` uses it whenever
 * a caller passes no `env` at all, which is to say the leak here was this file
 * opting out of a safe default rather than a default nobody had written. This
 * is a superset for two reasons the SDK's list does not cover: proxy and CA
 * variables, without which a server on a corporate network fails as a timeout
 * rather than an error, and locale and timezone, which silently change what a
 * server returns rather than whether it works.
 */
export function childEnv(
  source: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !INHERITED_ENV.has(name.toLowerCase())) continue;
    // An exported bash function, which is what Shellshock was made of. The
    // SDK's own default environment skips these and so does this.
    if (value.startsWith('()')) continue;
    env[name] = value;
  }
  return env;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * A connection failure in the terms of the person who configured the server.
 *
 * The distinction that matters is authentication. A remote server that
 * answers 401 is working correctly and refusing us, which is a different
 * situation from a bad URL or a missing package, and the only one whose
 * remedy is not "fix what you typed". Hosted connectors (Notion, Linear,
 * Sentry) all sit behind OAuth, so this is the failure a person is most
 * likely to hit first and least likely to diagnose from "not connected".
 */
export function explainConnectFailure(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);

  if (code === 401 || code === 403 || /\b(401|403)\b|unauthorized|invalid_token/i.test(message)) {
    return 'This server requires sign-in (OAuth), which Heap Code cannot do yet. A server that accepts a token in its command environment will work.';
  }
  if (code === 'ENOENT' || /ENOENT|command not found|spawn .* ENOENT/i.test(message)) {
    return `Could not run that command — is it installed and on PATH? (${message})`;
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(message)) {
    return `Could not reach that URL: ${message}`;
  }
  return message;
}
