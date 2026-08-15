import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
}
