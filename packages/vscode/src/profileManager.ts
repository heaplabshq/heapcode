import * as vscode from 'vscode';
import {
  createProvider,
  DEFAULT_CONTEXT_WINDOW,
  getPreset,
  providerPresets,
  resolveCapabilities,
  type ContextWindowSource,
  type ModelRole,
  type PresetId,
  type Provider,
  type ProviderProfileConfig,
} from '@heapcode/core';

const LEGACY_KEY_SECRET = 'heapcode.apiKey';

/** Which `*Profile` field on ProviderProfileConfig redirects a given role to another profile. */
const ROLE_PROFILE_FIELD: Record<ModelRole, keyof ProviderProfileConfig> = {
  editModel: 'editProfile',
  applyModel: 'applyProfile',
  completionModel: 'completionProfile',
  agentModel: 'agentProfile',
  embeddingsModel: 'embeddingsProfile',
  rerankModel: 'rerankProfile',
  contextModel: 'contextProfile',
};

/**
 * Model context length from provider-native APIs, for endpoints whose
 * OpenAI-compatible /models omits it: Ollama (/api/show) and LM Studio
 * (/api/v0/models). Best-effort with a short timeout; undefined otherwise.
 */
async function probeNativeContextLength(
  profile: ProviderProfileConfig,
  model: string,
): Promise<number | undefined> {
  if (profile.preset !== 'ollama' && profile.preset !== 'lmstudio') return undefined;
  const origin = profile.baseUrl.replace(/\/v1\/?$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    if (profile.preset === 'ollama') {
      const res = await fetch(`${origin}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { model_info?: Record<string, unknown> };
      for (const [k, v] of Object.entries(json.model_info ?? {})) {
        // e.g. "llama.context_length", "qwen2.context_length"
        if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) return v;
      }
    } else {
      const res = await fetch(`${origin}/api/v0/models/${encodeURIComponent(model)}`, {
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { max_context_length?: number };
      if (typeof json.max_context_length === 'number' && json.max_context_length > 0) {
        return json.max_context_length;
      }
    }
  } catch {
    // endpoint down or API shape changed — caller falls back
  } finally {
    clearTimeout(timeout);
  }
  return undefined;
}

function profileSecretKey(profileName: string): string {
  return `heapcode.apiKey.${profileName}`;
}

export class ProfileManager {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.OutputChannel,
  ) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  /** Fires the change event; also called by the extension on config changes. */
  notifyChanged(): void {
    this.changeEmitter.fire();
  }

  getProfiles(): ProviderProfileConfig[] {
    const cfg = vscode.workspace.getConfiguration('heapcode');
    const profiles = cfg.get<ProviderProfileConfig[]>('profiles', []);
    if (profiles.length > 0) return profiles;
    // Legacy fallback: synthesize a profile from the flat v0.1 settings.
    return [
      {
        name: 'default',
        preset: 'custom',
        baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434/v1'),
        model: cfg.get<string>('model', ''),
        temperature: cfg.get<number>('temperature'),
        maxTokens: cfg.get<number>('maxTokens'),
      },
    ];
  }

  getActiveProfile(): ProviderProfileConfig {
    const profiles = this.getProfiles();
    const activeName = vscode.workspace.getConfiguration('heapcode').get<string>('activeProfile', '');
    return profiles.find((p) => p.name === activeName) ?? profiles[0]!;
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

  async createActiveProvider(): Promise<{ provider: Provider; profile: ProviderProfileConfig }> {
    const profile = this.getActiveProfile();
    const apiKey = await this.getApiKey(profile);
    return { provider: createProvider(profile, apiKey), profile };
  }

  /**
   * Which profile actually serves a given role: the active profile, unless it names a
   * different one via its `<role>Profile` field (e.g. `embeddingsProfile`), in which case
   * that named profile is used instead — its own baseUrl/key/model, not the active one's.
   * Synchronous (no secret-storage lookup) so it's cheap to call just to check a model name.
   */
  resolveRoleProfile(role: ModelRole): ProviderProfileConfig {
    const active = this.getActiveProfile();
    const targetName = active[ROLE_PROFILE_FIELD[role]] as string | undefined;
    if (!targetName || targetName === active.name) return active;
    return this.getProfiles().find((p) => p.name === targetName) ?? active;
  }

  /** Provider + profile for a role, following its `<role>Profile` redirect (see resolveRoleProfile). */
  async resolveRole(role: ModelRole): Promise<{ provider: Provider; profile: ProviderProfileConfig }> {
    const profile = this.resolveRoleProfile(role);
    const apiKey = await this.getApiKey(profile);
    return { provider: createProvider(profile, apiKey), profile };
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
        const provider = createProvider(profile, await this.getApiKey(profile));
        reported = (await provider.listModels()).find((m) => m.id === model)?.contextLength;
      } catch {
        // unreachable or unlistable endpoint — preset default below
      }
      // Ollama and LM Studio don't report context in /v1/models — ask their
      // native APIs instead.
      reported ??= await probeNativeContextLength(profile, model);
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

  private async saveProfiles(profiles: ProviderProfileConfig[]): Promise<void> {
    await vscode.workspace
      .getConfiguration('heapcode')
      .update('profiles', profiles, vscode.ConfigurationTarget.Global);
  }

  private async setActive(name: string): Promise<void> {
    await vscode.workspace
      .getConfiguration('heapcode')
      .update('activeProfile', name, vscode.ConfigurationTarget.Global);
    this.notifyChanged();
  }

  /** Switch profile by name (used by the in-chat model menu). */
  async setActiveByName(name: string): Promise<void> {
    if (this.getProfiles().some((p) => p.name === name)) await this.setActive(name);
  }

  /** Set the chat model of the active profile (used by the in-chat model menu). */
  async setChatModel(modelId: string): Promise<void> {
    const active = this.getActiveProfile();
    const profiles = this.getProfiles().map((p) =>
      p.name === active.name ? { ...p, model: modelId } : p,
    );
    await this.saveProfiles(profiles);
    this.notifyChanged();
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

  async selectModelFlow(): Promise<void> {
    const profile = this.getActiveProfile();

    type Role =
      | 'model'
      | 'editModel'
      | 'applyModel'
      | 'completionModel'
      | 'agentModel'
      | 'embeddingsModel'
      | 'rerankModel'
      | 'contextModel';

    /** A role redirected to another profile shows that instead — this profile's own model field is unused while it's active. */
    const describeRole = (role: Role, ownDescription: string): string => {
      if (role === 'model') return ownDescription;
      const targetName = profile[ROLE_PROFILE_FIELD[role]] as string | undefined;
      if (!targetName) return ownDescription;
      const target = this.getProfiles().find((p) => p.name === targetName);
      if (!target) return `via "${targetName}" (profile not found — falls back here)`;
      return `via "${targetName}" → ${target[role] || 'not set'}`;
    };

    const inherits = `inherits chat (${profile.model || 'not set'})`;
    const rolePick = await vscode.window.showQuickPick(
      [
        {
          label: '$(comment-discussion) Chat',
          description: profile.model || 'not set',
          detail: 'Conversations in the sidebar',
          role: 'model' as Role,
        },
        {
          label: '$(edit) Edit',
          description: describeRole('editModel', profile.editModel || inherits),
          detail: 'Inline edit (Ctrl+I), commit messages',
          role: 'editModel' as Role,
        },
        {
          label: '$(git-merge) Apply',
          description: describeRole('applyModel', profile.applyModel || 'not set — uses selection/insert fallback'),
          detail: 'Fast-apply merge model for "Apply" on code blocks (e.g. FastApply-1.5B)',
          role: 'applyModel' as Role,
        },
        {
          label: '$(zap) Autocomplete',
          description: describeRole('completionModel', profile.completionModel || inherits),
          detail: 'Ghost text — pick a FIM-capable coder model (qwen2.5-coder, starcoder2…)',
          role: 'completionModel' as Role,
        },
        {
          label: '$(hubot) Agent',
          description: describeRole('agentModel', profile.agentModel || inherits),
          detail: 'Agent mode — pick a strong tool-calling model',
          role: 'agentModel' as Role,
        },
        {
          label: '$(search) Embeddings',
          description: describeRole('embeddingsModel', profile.embeddingsModel || 'not set'),
          detail: 'Semantic search / RAG index',
          role: 'embeddingsModel' as Role,
        },
        {
          label: '$(list-ordered) Rerank',
          description: describeRole(
            'rerankModel',
            profile.rerankModel || `inherits edit/chat (${profile.editModel || profile.model || 'not set'})`,
          ),
          detail: 'Reranks semantic-search hits — a small fast model works well',
          role: 'rerankModel' as Role,
        },
        {
          label: '$(comment) Context',
          description: describeRole(
            'contextModel',
            profile.contextModel ||
              `inherits rerank/edit/chat (${profile.rerankModel || profile.editModel || profile.model || 'not set'})`,
          ),
          detail:
            'Generates a short blurb per chunk for contextual retrieval (indexing) — a small fast model works well',
          role: 'contextModel' as Role,
        },
      ],
      { title: `Heap Code: Select model — which role? (${profile.name})` },
    );
    if (!rolePick) return;
    const role = rolePick.role;

    if (role !== 'model') {
      const redirectTarget = profile[ROLE_PROFILE_FIELD[role]] as string | undefined;
      if (redirectTarget) {
        const roleLabel = rolePick.label.replace(/\$\([\w-]+\) /, '');
        const exists = this.getProfiles().some((p) => p.name === redirectTarget);
        void vscode.window.showInformationMessage(
          exists
            ? `"${roleLabel}" on "${profile.name}" runs on profile "${redirectTarget}" instead (set in Settings → Model roles & tuning). ` +
              `Edit "${redirectTarget}"'s own model there, or clear the redirect to set a model here.`
            : `"${roleLabel}" on "${profile.name}" is redirected to profile "${redirectTarget}", which no longer exists — ` +
              'falling back to this profile. Clear the redirect in Settings → Model roles & tuning.',
        );
        return;
      }
    }

    let modelId: string | undefined;
    try {
      const { provider } = await this.createActiveProvider();
      const models = await provider.listModels();
      if (models.length > 0) {
        const current = profile[role];
        const items: vscode.QuickPickItem[] = models.map((m) => ({
          label: m.id,
          description: m.id === current ? 'current' : '',
        }));
        if (role !== 'model') {
          items.unshift({
            label: '$(discard) Inherit from chat model',
            description: 'clear this role',
          });
        }
        const picked = await vscode.window.showQuickPick(items, {
          title: `Heap Code: ${rolePick.label.replace(/\$\([\w-]+\) /, '')} model (${profile.name})`,
          matchOnDescription: true,
        });
        if (!picked) return;
        modelId = picked.label.startsWith('$(discard)') ? '' : picked.label;
      }
    } catch (err) {
      this.log.appendLine(`[profiles] listModels failed: ${String(err)}`);
    }

    // Azure returns [], and unreachable/unlistable endpoints land here too.
    modelId ??= await vscode.window.showInputBox({
      title: `Model id for "${profile.name}" (${role})`,
      value: profile[role] ?? '',
      prompt:
        profile.preset === 'azure-openai'
          ? 'Your Azure deployment name'
          : 'Could not list models from the endpoint — enter the model id manually',
    });
    if (modelId === undefined) return;

    const profiles = this.getProfiles().map((p) => {
      if (p.name !== profile.name) return p;
      const next = { ...p };
      if (role === 'model') next.model = modelId;
      else if (modelId === '') delete next[role];
      else next[role] = modelId;
      return next;
    });
    await this.saveProfiles(profiles);
    this.notifyChanged();
  }

  async setApiKeyFlow(): Promise<void> {
    const profile = this.getActiveProfile();
    const key = await vscode.window.showInputBox({
      prompt: `API key for profile "${profile.name}" (leave empty to clear)`,
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
        { label: '$(arrow-swap) Switch profile', action: 'switch' },
        { label: '$(symbol-parameter) Select model', action: 'model' },
        { label: '$(add) Add profile', action: 'add' },
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
