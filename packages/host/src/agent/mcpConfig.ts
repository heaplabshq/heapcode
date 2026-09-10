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

/**
 * `KEY=value` lines into the shape config stores.
 *
 * A server that needs a credential now has to say so — `childEnv` no longer
 * passes the shell's own variables through — so there has to be somewhere to
 * write one that is not a text editor open on config.json.
 *
 * Values are taken verbatim after the first `=`, since a token may contain
 * one. Surrounding quotes are stripped, because pasting from a `.env` file is
 * how most of these will arrive.
 */
export function parseMcpServerEnv(text: string): Record<string, string> | { error: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) return { error: `Write one KEY=value per line — could not read "${line}".` };
    const key = line.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { error: `"${key}" is not a usable variable name.` };
    env[key] = line
      .slice(at + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
  }
  return env;
}

/**
 * One server's environment after applying `KEY=value` pairs to it.
 *
 * Merged rather than replaced, because changing one key on a terminal should
 * not mean retyping the rest, and an empty value is how you drop one. `env`
 * is removed entirely when nothing is left, so a server that never needed one
 * does not carry an empty object around in config.
 */
export function mergeMcpServerEnv(
  server: McpServerConfig,
  pairs: string,
): McpServerConfig | { error: string } {
  const parsed = parseMcpServerEnv(pairs);
  if ('error' in parsed) return parsed;
  const next = { ...(server.env ?? {}) };
  for (const [key, value] of Object.entries(parsed)) {
    if (value === '') delete next[key];
    else next[key] = value;
  }
  const { env: _replaced, ...rest } = server;
  return Object.keys(next).length > 0 ? { ...rest, env: next } : rest;
}

/**
 * A parsed server, carrying whatever environment it should end up with.
 *
 * `env` absent means "leave what is stored alone". The settings panel is never
 * shown the values — they are credentials — so it cannot send them back, and
 * an edit that only changes the command must not take the token with it.
 * An empty string is the explicit "remove them".
 */
export async function withEnv(
  config: { load(): Promise<{ mcpServers?: Record<string, McpServerConfig> }> },
  name: string,
  parsed: McpServerConfig,
  env: string | undefined,
): Promise<McpServerConfig> {
  if (env === undefined) {
    const stored = (await config.load()).mcpServers?.[name]?.env;
    return stored && Object.keys(stored).length > 0 ? { ...parsed, env: stored } : parsed;
  }
  const next = parseMcpServerEnv(env);
  if ('error' in next) throw new Error(next.error);
  return Object.keys(next).length > 0 ? { ...parsed, env: next } : parsed;
}

/** How a stored server reads back — the same string `parseMcpServerSpec` accepts. */
export function describeMcpServer(server: McpServerConfig): string {
  if (server.url) return server.url;
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
}
