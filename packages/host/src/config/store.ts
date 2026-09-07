import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  migrateProfiles,
  needsMigration,
  resolveRole,
  toProfile,
  type LegacyProviderProfile,
  type McpServerConfig,
  type ModelAssignment,
  type ModelConfig,
  type ModelRole,
  type ModelRoleTable,
  type ProviderConnection,
  type ProviderProfileConfig,
  type WebSearchConfig,
} from '@heapcode/core';
import { configFile } from '../paths.js';

// The shape of an `mcpServers` entry belongs to the MCP manager (core), not
// to this file's config schema; re-exported so existing importers of it from
// here keep working.
export type { McpServerConfig };

export interface CliConfig {
  /** Credentialed endpoints. No models, no roles — see core's config/roles.ts. */
  connections: ProviderConnection[];
  /** Which model on which connection serves each role. One table, global. */
  roles: ModelRoleTable;
  /**
   * The pre-split shape, read once and migrated away.
   *
   * Left in the file rather than deleted for one release, so downgrading to an
   * older CLI is not destructive. Nothing reads it after `load` has run.
   */
  profiles?: LegacyProviderProfile[];
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
 * instances, since `connections` is an array callers push/splice in place. */
function empty(): CliConfig {
  return { connections: [], roles: {} };
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

  /**
   * Reads the config, migrating the pre-split shape on the way through.
   *
   * Migration is silent, one-way and in memory — nothing is written until the
   * next save. Writing here would mean a bare `heapcode --help` rewrites the
   * user's config file, and a read that has side effects on disk is a bad
   * thing to have on every command's startup path.
   */
  async load(): Promise<CliConfig> {
    if (this.cache) return this.cache;
    let stored: Partial<CliConfig> = {};
    try {
      stored = JSON.parse(await readFile(this.path, 'utf8')) as Partial<CliConfig>;
    } catch {
      // No config yet, or an unreadable one — an empty config is the recovery,
      // and setup writes over it.
    }
    if (needsMigration(stored)) {
      const migrated = migrateProfiles(stored.profiles ?? [], stored.activeProfile);
      this.cache = { ...empty(), ...stored, ...migrated };
    } else {
      this.cache = { ...empty(), ...stored };
    }
    return this.cache;
  }

  /** Connections and the role table, in the shape core's resolver takes. */
  async modelConfig(): Promise<ModelConfig> {
    const cfg = await this.load();
    return { connections: cfg.connections, roles: cfg.roles };
  }

  async listConnections(): Promise<ProviderConnection[]> {
    return (await this.load()).connections;
  }

  async getConnection(name: string): Promise<ProviderConnection | undefined> {
    return (await this.load()).connections.find((c) => c.name === name);
  }

  async saveConnection(connection: ProviderConnection): Promise<void> {
    const cfg = await this.load();
    const index = cfg.connections.findIndex((c) => c.name === connection.name);
    if (index >= 0) cfg.connections[index] = connection;
    else cfg.connections.push(connection);
    await this.persist();
  }

  /**
   * Removes a connection, and every role assignment that pointed at it.
   *
   * Leaving the assignments behind would work — resolution skips an assignment
   * whose connection is gone and falls down the chain — but it leaves the
   * settings screen listing a model on a connection that no longer exists,
   * which reads as a bug rather than as a fallback.
   */
  async deleteConnection(name: string): Promise<void> {
    const cfg = await this.load();
    cfg.connections = cfg.connections.filter((c) => c.name !== name);
    for (const [role, assignment] of Object.entries(cfg.roles) as Array<[ModelRole, ModelAssignment]>) {
      if (assignment.connection === name) delete cfg.roles[role];
    }
    await this.persist();
  }

  async getRoles(): Promise<ModelRoleTable> {
    return (await this.load()).roles;
  }

  /** Assigns a role, or clears it (so it inherits again) when given no assignment. */
  async setRole(role: ModelRole, assignment?: ModelAssignment): Promise<void> {
    const cfg = await this.load();
    if (assignment) cfg.roles[role] = assignment;
    else delete cfg.roles[role];
    await this.persist();
  }

  /**
   * The flattened endpoint+model for a role, or undefined when nothing serves
   * it. This is what every caller that used to ask for "the active profile"
   * wants, with the role it actually needs named.
   */
  async resolve(role: ModelRole): Promise<ProviderProfileConfig | undefined> {
    return resolveRole(await this.modelConfig(), role)?.profile;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  /**
   * Every connection as a flattened profile, carrying the chat model.
   *
   * The wire still speaks profiles (`hello.profiles`), because that is the
   * shape `createProvider` consumes; the role table travels beside it and is
   * what actually decides which model serves what.
   */
  async listProfiles(): Promise<ProviderProfileConfig[]> {
    const cfg = await this.load();
    const chat = cfg.roles.chat;
    return cfg.connections.map((c) =>
      toProfile(c, chat?.connection === c.name ? chat : { connection: c.name, model: '' }),
    );
  }

  async getProfile(name: string): Promise<ProviderProfileConfig | undefined> {
    return (await this.listProfiles()).find((p) => p.name === name);
  }

  /**
   * The connection and model chat runs on.
   *
   * "Active" is the chat assignment now, not a profile — which is the whole
   * point: switching what you chat with no longer silently rewrites the other
   * six roles.
   */
  async getActiveProfile(): Promise<ProviderProfileConfig | undefined> {
    return this.resolve('chat');
  }

  /**
   * Saves a connection and points chat at its model — what onboarding produces.
   *
   * Onboarding asks for an endpoint and one model, which is exactly a
   * connection plus a chat assignment, so it still has one call to make.
   */
  async saveProfile(profile: ProviderProfileConfig): Promise<void> {
    const cfg = await this.load();
    const connection: ProviderConnection = {
      name: profile.name,
      preset: profile.preset,
      baseUrl: profile.baseUrl,
      headers: profile.headers,
      capabilities: profile.capabilities,
      timeoutMs: profile.timeoutMs,
    };
    const index = cfg.connections.findIndex((c) => c.name === connection.name);
    if (index >= 0) cfg.connections[index] = connection;
    else cfg.connections.push(connection);
    if (profile.model && (!cfg.roles.chat || cfg.roles.chat.connection === connection.name)) {
      cfg.roles.chat = {
        connection: connection.name,
        model: profile.model,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        contextWindow: profile.contextWindow,
        promptTier: profile.promptTier,
      };
    }
    cfg.activeProfile ??= connection.name;
    await this.persist();
  }

  /** Merge into the web-search config (never the API key — that's SecretsStore's). */
  async saveWebSearch(patch: WebSearchConfig): Promise<void> {
    const cfg = await this.load();
    cfg.webSearch = { ...cfg.webSearch, ...patch };
    await this.persist();
  }

  /**
   * Points chat at a model on a connection.
   *
   * The two halves are set together on purpose. A chat assignment naming a
   * connection but no model is a state nothing can run on, and the old
   * `profile use` could produce exactly that whenever a model id from one
   * endpoint did not exist on the next.
   */
  async setChatModel(connection: string, model: string): Promise<void> {
    const cfg = await this.load();
    if (!cfg.connections.some((c) => c.name === connection)) {
      throw new Error(`No connection named "${connection}". Run "heapcode connection list" to see them.`);
    }
    cfg.roles.chat = { ...cfg.roles.chat, connection, model };
    cfg.activeProfile = connection;
    await this.persist();
  }

  /**
   * Points chat at a connection without naming a model.
   *
   * Switching connections used to mean switching profiles, which took all
   * seven roles with it. Now it moves chat and nothing else — and it drops the
   * model, because a model id is meaningful only on the endpoint that serves
   * it. Callers pick one straight after; the CLI's `/model` does it in the
   * same step.
   */
  async setActiveProfile(name: string): Promise<void> {
    const cfg = await this.load();
    if (!cfg.connections.some((c) => c.name === name)) {
      throw new Error(`No connection named "${name}". Run "heapcode connection list" to see them.`);
    }
    cfg.activeProfile = name;
    if (cfg.roles.chat?.connection !== name) cfg.roles.chat = { connection: name, model: '' };
    await this.persist();
  }

  async deleteProfile(name: string): Promise<void> {
    await this.deleteConnection(name);
    const cfg = await this.load();
    if (cfg.activeProfile === name) cfg.activeProfile = cfg.connections[0]?.name;
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
