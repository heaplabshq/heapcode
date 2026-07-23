import { createProvider, providerPresets, type ProviderProfileConfig } from '@heapcode/core';
import { ConfigStore } from './config/store.js';
import { SecretsStore } from './config/secrets.js';
import { Prompter } from './prompt.js';

/** `heapcode profile add` — interactive wizard: pick a preset, confirm the
 * endpoint, pick (or type) a model, enter an API key if the preset needs one. */
export async function profileAdd(): Promise<void> {
  const config = new ConfigStore();
  const secrets = new SecretsStore();
  const prompter = new Prompter();

  try {
    const presetIndex = await prompter.select(
      'Which provider?',
      providerPresets.map((p) => `${p.label}${p.local ? ' (local)' : ''}`),
      providerPresets.findIndex((p) => p.id === 'ollama'),
    );
    const preset = providerPresets[presetIndex]!;

    const defaultName = preset.id;
    const name = (await prompter.ask('Profile name', defaultName)) || defaultName;
    const baseUrl = (await prompter.ask('Base URL', preset.defaultBaseUrl)) || preset.defaultBaseUrl;

    let apiKey: string | undefined;
    if (preset.requiresApiKey) {
      apiKey = await prompter.askSecret('API key');
    }

    let model = '';
    const probe: ProviderProfileConfig = { name, preset: preset.id, baseUrl, model: '' };
    try {
      const provider = createProvider(probe, apiKey);
      const models = await provider.listModels();
      if (models.length > 0) {
        const idx = await prompter.select(
          'Which model?',
          models.map((m) => m.id),
          0,
        );
        model = models[idx]!.id;
      }
    } catch {
      // listModels not supported or endpoint unreachable right now — fall through to manual entry.
    }
    if (!model) {
      model = await prompter.ask('Model id (e.g. llama3.1:8b, gpt-4o-mini)');
    }

    const profile: ProviderProfileConfig = { name, preset: preset.id, baseUrl, model };
    await config.saveProfile(profile);
    if (apiKey) await secrets.setApiKey(name, apiKey);

    console.log(`\nSaved profile "${name}" (${preset.label}, ${model}) and set it active.`);
  } finally {
    prompter.close();
  }
}

export async function profileList(): Promise<void> {
  const config = new ConfigStore();
  const cfg = await config.load();
  if (cfg.profiles.length === 0) {
    console.log('No profiles configured yet. Run "heapcode profile add".');
    return;
  }
  for (const p of cfg.profiles) {
    const active = p.name === cfg.activeProfile ? '*' : ' ';
    console.log(`${active} ${p.name}  (${p.preset}, ${p.model})`);
  }
}

export async function profileUse(name: string): Promise<void> {
  const config = new ConfigStore();
  await config.setActiveProfile(name);
  console.log(`Active profile: ${name}`);
}

export async function profileRemove(name: string): Promise<void> {
  const config = new ConfigStore();
  const secrets = new SecretsStore();
  await config.deleteProfile(name);
  await secrets.deleteApiKey(name);
  console.log(`Removed profile "${name}".`);
}
