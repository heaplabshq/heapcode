import * as vscode from 'vscode';
import {
  createProvider,
  DEFAULT_CONTEXT_WINDOW,
  getPreset,
  getSearchPreset,
  isSearchPresetId,
  describeRole,
  migrateProfiles,
  MODEL_ROLES,
  resolveRole,
  toProfile,
  WEB_SEARCH_SECRET_NAME,
  type WebSearchConfig,
  providerPresets,
  resolveCapabilities,
  type ContextWindowSource,
  type LegacyProviderProfile,
  type ModelAssignment,
  type ModelConfig,
  type ModelInfo,
  type ModelRole,
  type ModelRoleTable,
  type PresetId,
  type Provider,
  type ProviderConnection,
  type ProviderProfileConfig,
} from '@heapcode/core';

const LEGACY_KEY_SECRET = 'heapcode.apiKey';

/**
 * The secret-storage key for a connection's API key.
 *
 * Keyed by the connection's *name*, which is why migrating from profiles keeps
 * every name: a rename here means the user re-enters the key.
 */
function profileSecretKey(profileName: string): string {
  return `heapcode.apiKey.${profileName}`;
}

/**
 * Web-search config from settings + its key from SecretStorage, in the shape
 * the executor wants. Read per call so enabling search takes effect without
 * a reload; the key rides the same custody path as provider keys (never
 * settings.json, which syncs).
 */
export async function readWebSearchSettings(
  secrets: vscode.SecretStorage,
): Promise<{ config: WebSearchConfig; apiKey?: string }> {
  const cfg = vscode.workspace.getConfiguration('heapcode.webSearch');
  const provider = cfg.get<string>('provider', 'off');
  return {
    config: {
      provider: isSearchPresetId(provider) ? provider : undefined,
      baseUrl: cfg.get<string>('baseUrl') || undefined,
      maxResults: cfg.get<number>('maxResults') || undefined,
      timeoutMs: cfg.get<number>('timeoutMs') || undefined,
    },
    apiKey: await secrets.get(profileSecretKey(WEB_SEARCH_SECRET_NAME)),
  };
}

/** Prompts for and stores the web-search API key. */
export async function setWebSearchKeyFlow(secrets: vscode.SecretStorage): Promise<void> {
  const provider = vscode.workspace.getConfiguration('heapcode.webSearch').get<string>('provider', 'off');
  if (!isSearchPresetId(provider)) {
    const pick = 'Open Settings';
    const choice = await vscode.window.showWarningMessage(
      'No web-search provider is selected. Set heapcode.webSearch.provider first.',
      pick,
    );
    if (choice === pick) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'heapcode.webSearch.provider');
    }
    return;
  }
  const preset = getSearchPreset(provider);
  const key = await vscode.window.showInputBox({
    title: `${preset.label} API key`,
    password: true,
    ignoreFocusOut: true,
    prompt: preset.requiresApiKey
      ? `Stored in the OS keychain, never in settings.json. ${preset.hint}`
      : `${preset.label} needs no key — leave blank unless your instance requires one.`,
  });
  if (key === undefined) return;
  if (key.trim()) {
    await secrets.store(profileSecretKey(WEB_SEARCH_SECRET_NAME), key.trim());
    void vscode.window.showInformationMessage(`Heap Code: ${preset.label} key saved. Web search is on.`);
  } else {
    await secrets.delete(profileSecretKey(WEB_SEARCH_SECRET_NAME));
    void vscode.window.showInformationMessage('Heap Code: web-search key cleared.');
  }
}

export class ProfileManager {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.OutputChannel,
  ) {}

  /**
   * Lists a profile's models through the core server, which holds the key and
   * builds the Provider. Injected by extension.ts rather than constructed here
   * because ProfileManager is built before the server link exists, and because
   * nothing about listing models should require this class to know the
   * protocol.
   *
   * Deliberately no host-side fallback: falling back to a local
   * `createProvider` would quietly reintroduce the very thing this moved. The
   * one caller that must never fail (contextWindowFor) already degrades to a
   * preset default when this throws.
   */
  private listModelsVia?: (profileName: string, model?: string) => Promise<ModelInfo[]>;

  setModelLister(lister: (profileName: string, model?: string) => Promise<ModelInfo[]>): void {
    this.listModelsVia = lister;
  }

  /** `model` additionally asks the endpoint what context length it really has. */
  private async listModels(profileName: string, model?: string): Promise<ModelInfo[]> {
    if (!this.listModelsVia) throw new Error('The core server connection is not available yet.');
    return this.listModelsVia(profileName, model);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  /** Fires the change event; also called by the extension on config changes. */
  notifyChanged(): void {
    this.changeEmitter.fire();
  }

  /**
   * Connections and the global role table, migrating the pre-split settings on
   * the way through.
   *
   * Computed on read rather than written back, so opening the extension does
   * not rewrite settings.json on someone's behalf. The old `heapcode.profiles`
   * stays where it is, ignored, until the user saves something — which also
   * means downgrading is not destructive.
   */
  getModelConfig(): ModelConfig {
    const cfg = vscode.workspace.getConfiguration('heapcode');
    const connections = cfg.get<ProviderConnection[]>('connections', []);
    if (connections.length > 0) {
      return { connections, roles: cfg.get<ModelRoleTable>('modelRoles', {}) };
    }
    const profiles = cfg.get<LegacyProviderProfile[]>('profiles', []);
    if (profiles.length > 0) {
      return migrateProfiles(profiles, cfg.get<string>('activeProfile', ''));
    }
    // Legacy fallback: synthesize one from the flat v0.1 settings.
    const model = cfg.get<string>('model', '');
    return {
      connections: [
        { name: 'default', preset: 'custom', baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434/v1') },
      ],
      roles: {
        chat: {
          connection: 'default',
          model,
          temperature: cfg.get<number>('temperature'),
          maxTokens: cfg.get<number>('maxTokens'),
        },
      },
    };
  }

  getConnections(): ProviderConnection[] {
    return this.getModelConfig().connections;
  }

  /**
   * Every connection as a flattened profile carrying the chat model.
   *
   * The wire and `createProvider` both speak profiles, so this is the shape
   * callers keep asking for; the role table beside it is what decides which
   * model actually serves what.
   */
  getProfiles(): ProviderProfileConfig[] {
    const { connections, roles } = this.getModelConfig();
    return connections.map((c) =>
      toProfile(c, roles.chat?.connection === c.name ? roles.chat : { connection: c.name, model: '' }),
    );
  }

  getRoles(): ModelRoleTable {
    return this.getModelConfig().roles;
  }

  /**
   * The connection and model chat runs on.
   *
   * "Active" is the chat assignment now, not a profile — switching what you
   * chat with no longer takes the other six roles with it.
   */
  getActiveProfile(): ProviderProfileConfig {
    const config = this.getModelConfig();
    return resolveRole(config, 'chat')?.profile ?? this.getProfiles()[0]!;
  }

  async getApiKey(profile: ProviderProfileConfig): Promise<string | undefined> {
    // An empty string is treated the same as "not set" (upsertProfile deletes rather
    // than stores '') — falling through here guards against any stray blank value.
    return (
      (await this.secrets.get(profileSecretKey(profile.name))) ||
      (await this.secrets.get(LEGACY_KEY_SECRET)) ||
      undefined
    );
  }

  /**
   * The endpoint and model serving a role — one lookup in the global table,
   * with the inheritance chain in core (config/roles.ts).
   *
   * `undefined` means nothing serves it. That is the ordinary state for
   * embeddings and apply, which inherit nothing on purpose: a chat model asked
   * to embed returns something that is not an embedding, and a general model
   * cannot produce a fast-apply merge. Callers treat it as "off", which is
   * what they already did for an unset role.
   *
   * Synchronous (no secret-storage lookup) so it is cheap to call just to
   * check a model name.
   */
  resolveRoleProfile(role: ModelRole): ProviderProfileConfig | undefined {
    return resolveRole(this.getModelConfig(), role)?.profile;
  }

  /** Provider + profile for a role, or undefined when nothing is assigned to it. */
  async resolveRole(
    role: ModelRole,
  ): Promise<{ provider: Provider; profile: ProviderProfileConfig } | undefined> {
    const profile = this.resolveRoleProfile(role);
    if (!profile) return undefined;
    const apiKey = await this.getApiKey(profile);
    return { provider: createProvider(profile, apiKey), profile };
  }

  /** Assigns a role, or clears it (back to inheriting) when given no assignment. */
  async setRole(role: ModelRole, assignment?: ModelAssignment): Promise<void> {
    const roles = { ...this.getRoles() };
    if (assignment) roles[role] = assignment;
    else delete roles[role];
    await this.saveRoles(roles);
  }

  /** Model-reported context length, looked up once per endpoint+model. */
  private readonly modelContextCache = new Map<string, number | undefined>();

  /**
   * Effective context window for a model on this profile, with its source:
   * explicit profile setting → model-reported length (/models, cached) →
   * preset default → 32768. Never throws; offline endpoints just fall back.
   */
  async contextWindowFor(
    profile: ProviderProfileConfig,
    model: string,
  ): Promise<{ window: number; source: ContextWindowSource }> {
    if (profile.contextWindow) return { window: profile.contextWindow, source: 'profile' };
    const key = `${profile.baseUrl}|${model}`;
    if (!this.modelContextCache.has(key)) {
      let reported: number | undefined;
      try {
        // `model` asks the daemon to fall back to the endpoint's own API for
        // the ones whose /v1/models omits a context length (Ollama, LM
        // Studio). That probe used to live here and could not reach a hosted
        // Ollama, because it had no key; the daemon has one.
        reported = (await this.listModels(profile.name, model)).find((m) => m.id === model)?.contextLength;
      } catch {
        // unreachable endpoint, unlistable endpoint, or no server yet —
        // preset default below. Never throws; this is on the chat hot path.
      }
      if (reported) {
        this.log.appendLine(`[profiles] ${model}: provider reports ${reported}-token context window`);
      }
      this.modelContextCache.set(key, reported);
    }
    const reported = this.modelContextCache.get(key);
    if (reported) return { window: reported, source: 'model' };
    const preset = resolveCapabilities(profile).maxContext;
    return preset
      ? { window: preset, source: 'preset' }
      : { window: DEFAULT_CONTEXT_WINDOW, source: 'default' };
  }

  /**
   * Writes connections, and the migrated role table alongside them the first
   * time.
   *
   * Migration only reaches disk here, on a real save — the read path computes
   * it. Without writing the table too, the first save would persist
   * connections while the roles were still being derived from `profiles`, and
   * the two would drift the moment anything edited one of them.
   */
  private async saveConnections(connections: ProviderConnection[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('heapcode');
    if (cfg.get<ProviderConnection[]>('connections', []).length === 0) {
      await cfg.update('modelRoles', this.getModelConfig().roles, vscode.ConfigurationTarget.Global);
    }
    await cfg.update('connections', connections, vscode.ConfigurationTarget.Global);
  }

  private async saveRoles(roles: ModelRoleTable): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('heapcode');
    if (cfg.get<ProviderConnection[]>('connections', []).length === 0) {
      await cfg.update('connections', this.getModelConfig().connections, vscode.ConfigurationTarget.Global);
    }
    await cfg.update('modelRoles', roles, vscode.ConfigurationTarget.Global);
    this.notifyChanged();
  }

  /** Kept for callers that still think in profiles; splits and stores both halves. */
  private async saveProfiles(profiles: ProviderProfileConfig[]): Promise<void> {
    await this.saveConnections(
      profiles.map((p) => ({
        name: p.name,
        preset: p.preset,
        baseUrl: p.baseUrl,
        headers: p.headers,
        capabilities: p.capabilities,
        timeoutMs: p.timeoutMs,
      })),
    );
  }

  private async setActive(name: string): Promise<void> {
    await vscode.workspace
      .getConfiguration('heapcode')
      .update('activeProfile', name, vscode.ConfigurationTarget.Global);
    this.notifyChanged();
  }

  /**
   * Move chat to a connection (used by the in-chat model menu).
   *
   * The model is dropped rather than carried over, because a model id means
   * nothing on an endpoint that does not serve it. The caller picks one next.
   */
  async setActiveByName(name: string): Promise<void> {
    if (!this.getConnections().some((c) => c.name === name)) return;
    await this.saveRoles({ ...this.getRoles(), chat: { connection: name, model: '' } });
    await this.setActive(name);
  }

  /** Point chat at a model, on a named connection or on the one already in use. */
  async setChatModel(modelId: string, connection?: string): Promise<void> {
    const chat = this.getRoles().chat;
    const target = connection ?? chat?.connection ?? this.getConnections()[0]?.name;
    if (!target) return;
    await this.saveRoles({ ...this.getRoles(), chat: { ...chat, connection: target, model: modelId } });
    if (target !== chat?.connection) await this.setActive(target);
  }

  // ---- settings panel (programmatic) ----

  async hasApiKey(profileName: string): Promise<boolean> {
    return !!(await this.secrets.get(profileSecretKey(profileName)));
  }

  /**
   * Create or update a profile from the settings panel. `original` is the
   * pre-edit name (undefined for a new profile); a rename moves the stored
   * API key. `apiKey`: undefined = unchanged, '' = clear, else store.
   */
  async upsertProfile(
    original: string | undefined,
    profile: ProviderProfileConfig,
    apiKey?: string,
  ): Promise<void> {
    const name = profile.name.trim();
    if (!name) throw new Error('Profile name is required.');
    const existing = this.getProfiles();
    if (existing.some((p) => p.name === name && p.name !== original)) {
      throw new Error(`A profile named "${name}" already exists.`);
    }
    const clean = { ...profile, name };

    let profiles: ProviderProfileConfig[];
    if (original && existing.some((p) => p.name === original)) {
      profiles = existing.map((p) => (p.name === original ? clean : p));
      if (original !== name) {
        const key = await this.secrets.get(profileSecretKey(original));
        if (key) {
          await this.secrets.store(profileSecretKey(name), key);
          await this.secrets.delete(profileSecretKey(original));
        }
      }
    } else {
      profiles = [...existing, clean];
    }
    await this.saveProfiles(profiles);
    // The editor binds a chat model and its tuning alongside the endpoint, and
    // `saveProfiles` only stores the endpoint half. Without this, editing the
    // model in the connection form would silently do nothing.
    const chat = this.getRoles().chat;
    if (clean.model && (!chat || chat.connection === original || chat.connection === name)) {
      await this.saveRoles({
        ...this.getRoles(),
        chat: {
          connection: name,
          model: clean.model,
          temperature: clean.temperature,
          maxTokens: clean.maxTokens,
          contextWindow: clean.contextWindow,
          promptTier: clean.promptTier,
        },
      });
    }

    if (apiKey === '') await this.secrets.delete(profileSecretKey(name));
    else if (apiKey !== undefined) await this.secrets.store(profileSecretKey(name), apiKey);

    // Keep the active pointer following a rename of the active profile.
    const activeName = vscode.workspace.getConfiguration('heapcode').get<string>('activeProfile', '');
    if (original && original !== name && activeName === original) {
      await this.setActive(name);
    } else {
      this.notifyChanged();
    }
  }

  async deleteProfile(name: string): Promise<void> {
    const remaining = this.getProfiles().filter((p) => p.name !== name);
    await this.saveProfiles(remaining);
    await this.secrets.delete(profileSecretKey(name));
    const activeName = vscode.workspace.getConfiguration('heapcode').get<string>('activeProfile', '');
    if (activeName === name && remaining.length > 0) {
      await this.setActive(remaining[0]!.name);
    } else {
      this.notifyChanged();
    }
  }

  // ---- interactive flows ----

  async selectProfileFlow(): Promise<void> {
    const profiles = this.getProfiles();
    const active = this.getActiveProfile();
    const addLabel = '$(add) Add profile…';
    const items: vscode.QuickPickItem[] = [
      ...profiles.map((p) => ({
        label: p.name === active.name ? `$(check) ${p.name}` : p.name,
        description: `${getPreset(p.preset).label} · ${p.model || 'no model'}`,
      })),
      { label: addLabel, description: '' },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Heap Code: Switch profile' });
    if (!picked) return;
    if (picked.label === addLabel) {
      await this.addProfileFlow();
      return;
    }
    await this.setActive(picked.label.replace(/^\$\(check\) /, ''));
  }

  async addProfileFlow(): Promise<void> {
    const presetPick = await vscode.window.showQuickPick(
      providerPresets.map((p) => ({
        label: p.label,
        description: p.local ? 'local' : p.defaultBaseUrl,
        presetId: p.id,
      })),
      { title: 'Heap Code: Add profile — pick a provider' },
    );
    if (!presetPick) return;
    const preset = getPreset(presetPick.presetId as PresetId);

    const existing = this.getProfiles().map((p) => p.name);
    const name = await vscode.window.showInputBox({
      title: 'Profile name',
      value: preset.id,
      validateInput: (v) =>
        !v.trim()
          ? 'Name is required'
          : existing.includes(v.trim())
            ? 'A profile with this name already exists'
            : undefined,
    });
    if (!name) return;

    const baseUrl = await vscode.window.showInputBox({
      title: 'Base URL',
      value: preset.defaultBaseUrl,
      prompt:
        preset.id === 'azure-openai'
          ? 'Your Azure resource endpoint, e.g. https://myresource.openai.azure.com'
          : 'Must include the version path (e.g. /v1) where applicable',
    });
    if (!baseUrl) return;

    let apiKey: string | undefined;
    if (preset.requiresApiKey) {
      apiKey = await vscode.window.showInputBox({
        title: `API key for ${preset.label}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) return;
    }

    const profile: ProviderProfileConfig = {
      name: name.trim(),
      preset: preset.id,
      baseUrl: baseUrl.trim(),
      model: '',
    };
    if (apiKey) await this.secrets.store(profileSecretKey(profile.name), apiKey);

    // Only include the (possibly legacy-synthesized) current profiles if the
    // user has real ones; otherwise keep the legacy profile alongside.
    const profiles = [...this.getProfiles().filter((p) => p.name !== profile.name), profile];
    await this.saveProfiles(profiles);
    await this.setActive(profile.name);

    // Pick a model right away — a profile without a model can't chat.
    await this.selectModelFlow();
  }

  /**
   * Pick a role, then pick a model for it from ANY connection.
   *
   * This used to be a role picker over the active profile's own fields, with a
   * "this role is redirected elsewhere, go edit that profile" dead end for
   * anything pointing at another provider. The whole reason the split happened
   * is that a role is not a property of an endpoint: it names a model, and the
   * model can live anywhere.
   */
  async selectModelFlow(): Promise<void> {
    const config = this.getModelConfig();
    const meta: Record<ModelRole, { icon: string; label: string; detail: string }> = {
      chat: { icon: 'comment-discussion', label: 'Chat', detail: 'Conversations in the sidebar' },
      edit: { icon: 'edit', label: 'Edit', detail: 'Inline edit (Ctrl+I), commit messages' },
      apply: {
        icon: 'git-merge',
        label: 'Apply',
        detail: 'Fast-apply merge model for "Apply" on code blocks (e.g. FastApply-1.5B)',
      },
      completion: {
        icon: 'zap',
        label: 'Autocomplete',
        detail: 'Ghost text — pick a FIM-capable coder model (qwen2.5-coder, starcoder2…)',
      },
      agent: { icon: 'hubot', label: 'Agent', detail: 'Agent mode — pick a strong tool-calling model' },
      embeddings: { icon: 'search', label: 'Embeddings', detail: 'Semantic search / RAG index' },
      rerank: {
        icon: 'list-ordered',
        label: 'Rerank',
        detail: 'Reranks semantic-search hits — a small fast model works well',
      },
      context: {
        icon: 'comment',
        label: 'Context',
        detail: 'A short blurb per chunk for contextual retrieval (indexing) — a small fast model works well',
      },
    };

    const rolePick = await vscode.window.showQuickPick(
      MODEL_ROLES.map((role) => ({
        label: `$(${meta[role].icon}) ${meta[role].label}`,
        // The resolved answer, not the field. Tracing a redirect and a
        // fallback chain by hand is what this replaces.
        description: describeRole(config, role),
        detail: meta[role].detail,
        role,
      })),
      { title: 'Heap Code: which role?' },
    );
    if (!rolePick) return;
    const role = rolePick.role;
    const roleLabel = rolePick.label.replace(/\$\([\w-]+\) /, '');

    // Every connection's models, fetched concurrently. One unreachable
    // endpoint must not cost the whole list: a local Ollama that is not
    // running is the ordinary case for someone whose other connection is a
    // cloud provider, and before roles went global they could not see the
    // other side's models without switching profile first.
    const listed = await Promise.all(
      config.connections.map(async (c) => {
        try {
          return (await this.listModels(c.name)).map((m) => ({ connection: c.name, id: m.id }));
        } catch (err) {
          this.log.appendLine(`[profiles] listModels(${c.name}) failed: ${String(err)}`);
          return [];
        }
      }),
    );
    const models = listed.flat();

    const current = config.roles[role];
    const items: Array<vscode.QuickPickItem & { connection?: string; clear?: boolean }> = models.map((m) => ({
      label: `${m.connection} / ${m.id}`,
      description: current?.connection === m.connection && current.model === m.id ? 'current' : '',
      connection: m.connection,
    }));
    // Clearing has to be reachable from the same place the choice was made.
    // Chat is what the chain bottoms out at, so it has nothing to clear to.
    if (role !== 'chat') {
      items.unshift({ label: '$(discard) Inherit', description: 'clear this role', clear: true });
    }

    let connection = current?.connection ?? config.connections[0]?.name;
    let modelId: string | undefined;
    if (models.length > 0) {
      const picked = await vscode.window.showQuickPick(items, {
        title: `Heap Code: ${roleLabel} model`,
        matchOnDescription: true,
      });
      if (!picked) return;
      if (picked.clear) {
        await this.setRole(role);
        return;
      }
      connection = picked.connection;
      modelId = picked.label.slice(`${picked.connection} / `.length);
    }

    if (!connection) return;
    // Azure returns [], and unreachable or unlistable endpoints land here too.
    modelId ??= await vscode.window.showInputBox({
      title: `Model id for ${roleLabel} on "${connection}"`,
      value: current?.model ?? '',
      prompt:
        config.connections.find((c) => c.name === connection)?.preset === 'azure-openai'
          ? 'Your Azure deployment name'
          : 'Could not list models from the endpoint — enter the model id manually',
    });
    if (modelId === undefined) return;

    if (role === 'chat') await this.setChatModel(modelId, connection);
    else await this.setRole(role, { ...current, connection, model: modelId });
  }

  async setApiKeyFlow(): Promise<void> {
    const profile = this.getActiveProfile();
    const key = await vscode.window.showInputBox({
      prompt: `API key for connection "${profile.name}" (leave empty to clear)`,
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    if (key === '') {
      await this.secrets.delete(profileSecretKey(profile.name));
      void vscode.window.showInformationMessage(`Heap Code: API key cleared for "${profile.name}".`);
    } else {
      await this.secrets.store(profileSecretKey(profile.name), key);
      void vscode.window.showInformationMessage(
        `Heap Code: API key saved for "${profile.name}" in secure storage.`,
      );
    }
  }

  async menuFlow(): Promise<void> {
    const profile = this.getActiveProfile();
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(arrow-swap) Switch connection', action: 'switch' },
        { label: '$(symbol-parameter) Model roles', action: 'model' },
        { label: '$(add) Add connection', action: 'add' },
        { label: '$(key) Set API key', action: 'key' },
      ],
      { title: `Heap Code — ${profile.name} · ${profile.model || 'no model'}` },
    );
    switch (picked?.action) {
      case 'switch':
        return this.selectProfileFlow();
      case 'model':
        return this.selectModelFlow();
      case 'add':
        return this.addProfileFlow();
      case 'key':
        return this.setApiKeyFlow();
    }
  }
}
