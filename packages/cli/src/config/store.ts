import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpServerConfig, ProviderProfileConfig } from '@heapcode/core';
import { configFile } from '../paths.js';

// The shape of an `mcpServers` entry belongs to the MCP manager (core), not
// to this file's config schema; re-exported so existing importers of it from
// here keep working.
export type { McpServerConfig };

export interface CliConfig {
  profiles: ProviderProfileConfig[];
  activeProfile?: string;
  mcpServers?: Record<string, McpServerConfig>;
  telemetryEnabled?: boolean;
  /** Opt out of the startup check against npm's registry for a newer published version (see updateCheck.ts). Defaults to on. */
  updateCheckEnabled?: boolean;
}

/** A fresh empty config each call — never share one mutable object across
 * instances, since `profiles` is an array callers push/splice in place. */
function empty(): CliConfig {
  return { profiles: [] };
}

/**
 * Personal config (~/.heapcode/config.json): provider profiles + which one
 * is active, plus MCP servers and settings. Mirrors the extension's
 * profileManager.ts storage shape (ProviderProfileConfig[] + activeProfile)
 * minus API keys, which live in secrets.ts instead — same split as the
 * extension's workspace-settings vs. SecretStorage split.
 */
export class ConfigStore {
  private cache?: CliConfig;

  constructor(private readonly path: string = configFile()) {}

  async load(): Promise<CliConfig> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      this.cache = { ...empty(), ...(JSON.parse(raw) as Partial<CliConfig>) };
    } catch {
      this.cache = empty();
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  async listProfiles(): Promise<ProviderProfileConfig[]> {
    return (await this.load()).profiles;
  }

  async getProfile(name: string): Promise<ProviderProfileConfig | undefined> {
    return (await this.load()).profiles.find((p) => p.name === name);
  }

  async getActiveProfile(): Promise<ProviderProfileConfig | undefined> {
    const cfg = await this.load();
    if (!cfg.activeProfile) return cfg.profiles[0];
    return cfg.profiles.find((p) => p.name === cfg.activeProfile) ?? cfg.profiles[0];
  }

  async saveProfile(profile: ProviderProfileConfig): Promise<void> {
    const cfg = await this.load();
    const index = cfg.profiles.findIndex((p) => p.name === profile.name);
    if (index >= 0) cfg.profiles[index] = profile;
    else cfg.profiles.push(profile);
    cfg.activeProfile ??= profile.name;
    await this.persist();
  }

  async setActiveProfile(name: string): Promise<void> {
    const cfg = await this.load();
    if (!cfg.profiles.some((p) => p.name === name)) {
      throw new Error(`No profile named "${name}". Run "heapcode profile list" to see configured profiles.`);
    }
    cfg.activeProfile = name;
    await this.persist();
  }

  async deleteProfile(name: string): Promise<void> {
    const cfg = await this.load();
    cfg.profiles = cfg.profiles.filter((p) => p.name !== name);
    if (cfg.activeProfile === name) cfg.activeProfile = cfg.profiles[0]?.name;
    await this.persist();
  }
}
