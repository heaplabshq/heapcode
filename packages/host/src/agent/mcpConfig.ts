import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigStore, McpServerConfig } from '../config/store.js';
import { projectConfigDir } from '../paths.js';

/**
 * MCP servers come from two places, merged: `mcpServers` in the global
 * `~/.heapcode/config.json` (personal servers you want everywhere) and
 * `<cwd>/.heapcode/mcp.json` (project-scoped servers, e.g. a filesystem
 * server pinned to this repo). A name defined in both is project-scoped —
 * the same "closest specificity wins" rule as `.heapcode/instructions/`'s
 * per-path overrides.
 */
export async function loadMcpServers(root: string, config: ConfigStore): Promise<Record<string, McpServerConfig>> {
  const { global, project } = await loadMcpServerSources(root, config);
  return { ...global, ...project };
}

/**
 * The same two sources, kept apart.
 *
 * A settings UI has to say which file a server came from, because only one of
 * them it may write to: the project file is meant to be committed, so it is
 * shown and left alone.
 */
export async function loadMcpServerSources(
  root: string,
  config: ConfigStore,
): Promise<{ global: Record<string, McpServerConfig>; project: Record<string, McpServerConfig> }> {
  const global = (await config.load()).mcpServers ?? {};
  let project: Record<string, McpServerConfig> = {};
  try {
    project = JSON.parse(await readFile(join(projectConfigDir(root), 'mcp.json'), 'utf8')) as Record<string, McpServerConfig>;
  } catch {
    // no project-scoped file — global only
  }
  return { global, project };
}

/** A server name that can be written to config and prefixed onto tool names. */
export function mcpNameProblem(name: string): string | undefined {
  if (!name.trim()) return 'Give the server a name.';
  if (!/^[\w-]+$/.test(name)) return 'Use letters, digits, - and _ only.';
  return undefined;
}

/**
 * One line of input into a server definition.
 *
 * Both hosts take the same two shapes -- a URL, or a command line -- because
 * that is the whole of what MCP configuration is, and asking a person to
 * choose a transport first is asking them to know something the string
 * already says. `https://…` is remote; anything else is a local command.
 *
 * Shared so the CLI and the browser cannot drift into accepting different
 * things, the way the two `clientInfo` names once did.
 */
export function parseMcpServerSpec(spec: string): McpServerConfig | { error: string } {
  const trimmed = spec.trim();
  if (!trimmed) return { error: 'Give a command to run, or a URL.' };

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { error: `Not a valid URL: ${trimmed}` };
    }
    // Streamable HTTP is the current transport; `sse` is the older one, and a
    // server that wants it says so in its own URL by convention.
    return { url: url.toString(), transport: /\/sse\b/.test(url.pathname) ? 'sse' : 'http' };
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0]!;
  return parts.length > 1 ? { command, args: parts.slice(1) } : { command };
}

/** How a stored server reads back — the same string `parseMcpServerSpec` accepts. */
export function describeMcpServer(server: McpServerConfig): string {
  if (server.url) return server.url;
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
}
