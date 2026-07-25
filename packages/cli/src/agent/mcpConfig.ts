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
  const global = (await config.load()).mcpServers ?? {};
  let project: Record<string, McpServerConfig> = {};
  try {
    project = JSON.parse(await readFile(join(projectConfigDir(root), 'mcp.json'), 'utf8')) as Record<string, McpServerConfig>;
  } catch {
    // no project-scoped file — global only
  }
  return { ...global, ...project };
}
