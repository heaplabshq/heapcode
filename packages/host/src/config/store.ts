import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpServerConfig, ProviderProfileConfig, WebSearchConfig } from '@heapcode/core';
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
  /**
   * How long an `ask_user` question waits with no activity before the agent is
   * told the user may be away and carries on — e.g. "60s", "5m", "10m".
   * Unset (the default) means it waits indefinitely. A question the model
   * marked `blocksAction` never times out regardless. See core's askUser.ts.
   */
  askUserQuestionTimeout?: string;
  /**
   * Model turns one agent run may take before it is cut off with a
   * progress summary. Unset means core's DEFAULT_MAX_ITERATIONS. Raise it
   * for habitually large tasks; lower it to keep a local model on a short
   * leash. `--max-iterations` overrides it for a single headless run.
   */
  maxIterations?: number;
  /**
   * Web search for the agent. Absent (the default) means the `web_search`
   * tool is refused — see core's webSearch.ts. The API key is NOT here: it
   * lives in secrets.json under WEB_SEARCH_SECRET_NAME, the same custody path
   * as provider keys.
   */
  webSearch?: WebSearchConfig;
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

  /** Merge into the web-search config (never the API key — that's SecretsStore's). */
  async saveWebSearch(patch: WebSearchConfig): Promise<void> {
    const cfg = await this.load();
    cfg.webSearch = { ...cfg.webSearch, ...patch };
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

  /**
   * Add or replace a personal MCP server, by name.
   *
   * There was no write path here at all, which is why every host could list
   * servers and none could add one: the CLI's `/mcp` and the browser's
   * Connectors page both ended in "edit this JSON file yourself". Only the
   * extension had an add flow, and it writes to VS Code's own settings, so
   * what it adds is invisible to the other two.
   *
   * Global, not project-scoped. `<root>/.heapcode/mcp.json` is meant to be
   * committed and shared with a team, and quietly writing to a file that is
   * under version control is not something a settings panel should do on
   * someone's behalf. That file keeps winning on a name collision
   * (`loadMcpServers`), so a project's choice still overrides this.
   */
  async saveMcpServer(name: string, server: McpServerConfig): Promise<void> {
    const cfg = await this.load();
    cfg.mcpServers = { ...cfg.mcpServers, [name]: server };
    await this.persist();
  }

  /** Removes a personal MCP server. A project-scoped one of the same name is untouched. */
  async deleteMcpServer(name: string): Promise<void> {
    const cfg = await this.load();
    if (!cfg.mcpServers?.[name]) return;
    const { [name]: _removed, ...rest } = cfg.mcpServers;
    cfg.mcpServers = rest;
    await this.persist();
  }
}
