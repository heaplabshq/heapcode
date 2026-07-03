import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from '@cortex/core';

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

interface ConnectedServer {
  client: Client;
  tools: ToolDefinition[];
}

export class McpManager implements vscode.Disposable {
  private servers = new Map<string, ConnectedServer>();
  private connecting?: Promise<void>;

  constructor(private readonly log: vscode.OutputChannel) {}

  dispose(): void {
    for (const [, server] of this.servers) void server.client.close();
    this.servers.clear();
  }

  private config(): Record<string, McpServerConfig> {
    return vscode.workspace
      .getConfiguration('cortex')
      .get<Record<string, McpServerConfig>>('mcpServers', {});
  }

  /** Connect configured servers (idempotent; drops removed ones). */
  ensureConnected(): Promise<void> {
    this.connecting ??= this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const config = this.config();

    for (const name of [...this.servers.keys()]) {
      if (!config[name]) {
        void this.servers.get(name)!.client.close();
        this.servers.delete(name);
      }
    }

    for (const [name, server] of Object.entries(config)) {
      if (this.servers.has(name)) continue;
      try {
        const client = new Client({ name: 'cortex-code', version: '0.1.0' });
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
        }));
        this.servers.set(name, { client, tools });
        this.log.appendLine(`[mcp] connected "${name}" (${tools.length} tools)`);
      } catch (err) {
        this.log.appendLine(
          `[mcp] failed to connect "${name}": ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.servers.values()].flatMap((s) => s.tools);
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
