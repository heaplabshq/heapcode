import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

interface ConnectedServer {
  client: Client;
  tools: ToolDefinition[];
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
  private connecting?: Promise<void>;

  constructor(
    private readonly loadConfig: () =>
      | Promise<Record<string, McpServerConfig>>
      | Record<string, McpServerConfig>,
    private readonly onLog?: (line: string) => void,
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
      if (!config[name]) {
        void this.servers.get(name)!.client.close();
        this.servers.delete(name);
      }
    }

    for (const [name, server] of Object.entries(config)) {
      if (this.servers.has(name)) continue;
      try {
        const client = new Client({ name: CLIENT_NAME, version: '0.1.0' });
        const transport = server.url
          ? server.transport === 'sse'
            ? new SSEClientTransport(new URL(server.url))
            : new StreamableHTTPClientTransport(new URL(server.url))
          : new StdioClientTransport({
              command: server.command ?? '',
              args: server.args ?? [],
              env: { ...(process.env as Record<string, string>), ...server.env },
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
        this.servers.set(name, { client, tools });
        this.onLog?.(`connected "${name}" (${tools.length} tools)`);
      } catch (err) {
        this.onLog?.(`failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.servers.values()].flatMap((s) => s.tools);
  }

  connectedServerNames(): string[] {
    return [...this.servers.keys()];
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

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
