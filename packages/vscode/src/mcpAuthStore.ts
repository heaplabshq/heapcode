import * as vscode from 'vscode';
import type { McpAuthRecord, McpAuthStore } from '@heapcode/core';

/**
 * MCP OAuth records in VS Code's SecretStorage.
 *
 * The extension's other secrets (provider API keys, the web-search key) live
 * here already, and these are the same kind of thing: bearer tokens that must
 * not land in `settings.json`, which syncs across machines, is committed in
 * some workspaces, and is rendered verbatim in the settings editor.
 *
 * Deliberately not shared with the CLI's `~/.heapcode/secrets.json`. Those two
 * stores are separate everywhere else in the extension, and reaching into the
 * CLI's file would make the extension's secrets readable by anything that can
 * read that path — the opposite of why SecretStorage is used.
 */
export class SecretStorageMcpAuthStore implements McpAuthStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(server: string): string {
    return `mcpAuth.${server}`;
  }

  async read(server: string): Promise<McpAuthRecord | undefined> {
    const raw = await this.secrets.get(this.key(server));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as McpAuthRecord;
    } catch {
      // Unreadable is the same as absent: it asks for a fresh sign-in rather
      // than failing the connection with a parse error.
      return undefined;
    }
  }

  async write(server: string, record: McpAuthRecord): Promise<void> {
    await this.secrets.store(this.key(server), JSON.stringify(record));
  }

  async clear(server: string): Promise<void> {
    await this.secrets.delete(this.key(server));
  }
}
