import * as vscode from 'vscode';
import {
  createProvider,
  getPreset,
  providerPresets,
  type PresetId,
  type Provider,
  type ProviderProfileConfig,
} from '@cortex/core';

const LEGACY_KEY_SECRET = 'cortex.apiKey';

function profileSecretKey(profileName: string): string {
  return `cortex.apiKey.${profileName}`;
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
    const cfg = vscode.workspace.getConfiguration('cortex');
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
    const activeName = vscode.workspace.getConfiguration('cortex').get<string>('activeProfile', '');
    return profiles.find((p) => p.name === activeName) ?? profiles[0]!;
  }

  async getApiKey(profile: ProviderProfileConfig): Promise<string | undefined> {
    return (
      (await this.secrets.get(profileSecretKey(profile.name))) ??
      (await this.secrets.get(LEGACY_KEY_SECRET))
    );
  }

  async createActiveProvider(): Promise<{ provider: Provider; profile: ProviderProfileConfig }> {
    const profile = this.getActiveProfile();
    const apiKey = await this.getApiKey(profile);
    return { provider: createProvider(profile, apiKey), profile };
  }

  private async saveProfiles(profiles: ProviderProfileConfig[]): Promise<void> {
    await vscode.workspace
      .getConfiguration('cortex')
      .update('profiles', profiles, vscode.ConfigurationTarget.Global);
  }

  private async setActive(name: string): Promise<void> {
    await vscode.workspace
      .getConfiguration('cortex')
      .update('activeProfile', name, vscode.ConfigurationTarget.Global);
    this.notifyChanged();
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
    const picked = await vscode.window.showQuickPick(items, { title: 'Cortex: Switch profile' });
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
      { title: 'Cortex: Add profile — pick a provider' },
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
    let modelId: string | undefined;

    try {
      const { provider } = await this.createActiveProvider();
      const models = await provider.listModels();
      if (models.length > 0) {
        const picked = await vscode.window.showQuickPick(
          models.map((m) => ({ label: m.id, description: m.id === profile.model ? 'current' : '' })),
          { title: `Cortex: Select model (${profile.name})`, matchOnDescription: true },
        );
        modelId = picked?.label;
      }
    } catch (err) {
      this.log.appendLine(`[profiles] listModels failed: ${String(err)}`);
    }

    // Azure returns [], and unreachable/unlistable endpoints land here too.
    modelId ??= await vscode.window.showInputBox({
      title: `Model id for profile "${profile.name}"`,
      value: profile.model,
      prompt:
        profile.preset === 'azure-openai'
          ? 'Your Azure deployment name'
          : 'Could not list models from the endpoint — enter the model id manually',
    });
    if (!modelId) return;

    const profiles = this.getProfiles().map((p) =>
      p.name === profile.name ? { ...p, model: modelId } : p,
    );
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
      void vscode.window.showInformationMessage(`Cortex: API key cleared for "${profile.name}".`);
    } else {
      await this.secrets.store(profileSecretKey(profile.name), key);
      void vscode.window.showInformationMessage(
        `Cortex: API key saved for "${profile.name}" in secure storage.`,
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
      { title: `Cortex — ${profile.name} · ${profile.model || 'no model'}` },
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
