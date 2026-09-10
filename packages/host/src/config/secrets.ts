import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpAuthRecord, McpAuthStore } from '@heapcode/core';
import { secretsFile } from '../paths.js';

/**
 * API keys as a plain, chmod-600 JSON file (~/.heapcode/secrets.json), keyed
 * `apiKey.<profileName>` — the CLI equivalent of the extension's
 * vscode.SecretStorage, minus the OS keychain. Deliberate: guardrail #5 ("no
 * native-module dependencies without a JS fallback") rules out a
 * keychain-only design, since it breaks headless/CI machines and any Linux
 * box without one unlocked. Same posture as gh/aws CLIs.
 */
export class SecretsStore {
  private cache?: Record<string, string>;

  constructor(private readonly path: string = secretsFile()) {}

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.cache, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  async getApiKey(profileName: string): Promise<string | undefined> {
    return (await this.load())[`apiKey.${profileName}`];
  }

  async setApiKey(profileName: string, key: string): Promise<void> {
    const secrets = await this.load();
    secrets[`apiKey.${profileName}`] = key;
    await this.persist();
  }

  async deleteApiKey(profileName: string): Promise<void> {
    const secrets = await this.load();
    delete secrets[`apiKey.${profileName}`];
    await this.persist();
  }

  /**
   * OAuth records for MCP servers, keyed `mcpAuth.<server>`.
   *
   * Here rather than in `config.json` because these are bearer tokens and
   * that file is read straight into a settings panel. They land in the same
   * chmod-600 file as API keys, which is what they are.
   */
  async getMcpAuth(server: string): Promise<McpAuthRecord | undefined> {
    const raw = (await this.load())[`mcpAuth.${server}`];
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as McpAuthRecord;
    } catch {
      // A record we cannot read is a record we cannot use; reporting absence
      // asks for a fresh sign-in instead of failing the connection.
      return undefined;
    }
  }

  async setMcpAuth(server: string, record: McpAuthRecord): Promise<void> {
    const secrets = await this.load();
    secrets[`mcpAuth.${server}`] = JSON.stringify(record);
    await this.persist();
  }

  async deleteMcpAuth(server: string): Promise<void> {
    const secrets = await this.load();
    delete secrets[`mcpAuth.${server}`];
    await this.persist();
  }
}

/** `SecretsStore` as the shape core's OAuth provider reads and writes. */
export class SecretsMcpAuthStore implements McpAuthStore {
  constructor(private readonly secrets: SecretsStore) {}
  read(server: string): Promise<McpAuthRecord | undefined> {
    return this.secrets.getMcpAuth(server);
  }
  write(server: string, record: McpAuthRecord): Promise<void> {
    return this.secrets.setMcpAuth(server, record);
  }
  clear(server: string): Promise<void> {
    return this.secrets.deleteMcpAuth(server);
  }
}
