import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { globalDir } from '@heapcode/core/node';

/**
 * Connector tools the person said to stop asking about — "Always allow" on
 * the permission card, kept across chats and restarts the way Claude Desktop
 * and Claude Code keep theirs. Either one tool, or every tool of a server
 * (a Notion connector brings a dozen; approving each in turn is the
 * frustration this exists for).
 *
 * One small file beside config.json, shared by Heap Chat and Heapnotes'
 * Ask, which run connectors the same way. Settings › MCP shows what is
 * trusted and takes it back.
 */
export interface McpTrust {
  /** Server keys, as they appear in tool names (`mcp__<server>__<tool>`). */
  servers: string[];
  /** Full tool names. */
  tools: string[];
}

export function mcpTrustFile(): string {
  return join(globalDir(), 'mcp-trust.json');
}

/** The key a server's tools are prefixed with — how McpManager names them. */
export function serverKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** `mcp__notion__search` → `notion`. */
export function serverOfTool(tool: string): string {
  return tool.startsWith('mcp__') ? (tool.slice(5).split('__')[0] ?? '') : '';
}

export function readMcpTrust(file = mcpTrustFile()): McpTrust {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<McpTrust>;
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return { servers: strings(raw.servers), tools: strings(raw.tools) };
  } catch {
    return { servers: [], tools: [] };
  }
}

function write(trust: McpTrust, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(trust, null, 2)}\n`);
}

export function isTrusted(tool: string, trust = readMcpTrust()): boolean {
  if (!tool.startsWith('mcp__')) return false;
  return trust.tools.includes(tool) || trust.servers.includes(serverOfTool(tool));
}

/** Stop asking: about this tool, or about every tool its server has. */
export function trustMcp(tool: string, scope: 'tool' | 'server', file = mcpTrustFile()): void {
  const trust = readMcpTrust(file);
  if (scope === 'server') {
    const server = serverOfTool(tool);
    if (server && !trust.servers.includes(server)) trust.servers.push(server);
  } else if (!trust.tools.includes(tool)) trust.tools.push(tool);
  write(trust, file);
}

/** Ask again about a server's tools — all of them, however they were trusted. */
export function forgetMcpTrust(serverName: string, file = mcpTrustFile()): void {
  const key = serverKey(serverName);
  const trust = readMcpTrust(file);
  write(
    {
      servers: trust.servers.filter((s) => s !== key),
      tools: trust.tools.filter((t) => serverOfTool(t) !== key),
    },
    file,
  );
}

/** For Settings: `'all'`, how many tools, or nothing trusted. */
export function trustFor(serverName: string, trust = readMcpTrust()): 'all' | number | undefined {
  const key = serverKey(serverName);
  if (trust.servers.includes(key)) return 'all';
  const n = trust.tools.filter((t) => serverOfTool(t) === key).length;
  return n || undefined;
}
