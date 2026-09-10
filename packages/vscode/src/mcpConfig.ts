import * as vscode from 'vscode';
import type { McpServerConfig } from '@heapcode/core';

/** The project-scoped file the CLI and both web hosts already read. */
const PROJECT_FILE = ['.heapcode', 'mcp.json'];

/**
 * MCP servers for this window: VS Code settings, plus the project's own file.
 *
 * `<project>/.heapcode/mcp.json` is project configuration — meant to live in
 * the repo and be committed, the way `.vscode/` is — and every other host
 * reads it. The extension did not, so a team could add a server for their
 * project, have the terminal pick it up, and watch the editor silently ignore
 * it.
 *
 * Deliberately NOT merged: `mcpServers` from `~/.heapcode/config.json`. That
 * is another host's *personal* config, and an MCP server is a program to
 * execute rather than a value — inheriting a list of executables from a file
 * the editor never asked about is a different thing from inheriting a provider
 * endpoint. Someone who wants a personal server here adds it here.
 *
 * Reading a file out of the repo is safe for the narrow reason that this
 * extension declares no `untrustedWorkspaces` support, so VS Code disables it
 * outright in restricted mode: if this code is running, the workspace is
 * already trusted.
 */
export async function loadMcpServers(): Promise<Record<string, McpServerConfig>> {
  const settings = vscode.workspace.getConfiguration('heapcode').get<Record<string, McpServerConfig>>('mcpServers', {});
  const project = await readProjectMcpServers();
  // Project wins on a name clash, matching `loadMcpServers` in
  // @heapcode/host: the closest, most specific definition is the one that
  // applies. Diverging would mean the same two files produce different tool
  // rosters depending on which window you are in.
  return { ...settings, ...project };
}

/** `<workspace>/.heapcode/mcp.json`, or nothing if there isn't one. */
export async function readProjectMcpServers(): Promise<Record<string, McpServerConfig>> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return {};
  try {
    const uri = vscode.Uri.joinPath(root, ...PROJECT_FILE);
    const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Only entries that could actually start something. A malformed one is
    // dropped rather than handed to the manager to fail on later.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, McpServerConfig>).filter(([, v]) => v && (v.command || v.url)),
    );
  } catch {
    // No file, unreadable, or not JSON — all the same answer. A repo without
    // one is the common case, not an error.
    return {};
  }
}
