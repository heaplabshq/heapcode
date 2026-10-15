import {
  SEARCH_PRESETS,
  WEB_SEARCH_SECRET_NAME,
  describeRole,
  providerPresets,
  resolveCapabilities,
} from '@heapcode/core';
import { profileContextWindow, type ConfigStore, type SecretsStore } from '@heapcode/host';
import { UI_MODEL_ROLES, type UiModelRole, type UiSaveProfileParams, type UiSettings } from './protocol.js';
import { mergeProfile } from './session.js';

/**
 * The settings every product shares — connections, the model role table and
 * web search — read and written straight against the global config.
 *
 * Heap Chat and Heap QA open the same Settings dialog as Heap Code, and what
 * it edits there has to be the very connection the other products see: one
 * config file, one role table. These are the reads and writes; what a product
 * does after one (Chat reconnects its daemon) stays with that product.
 */

export type SharedSettings = Pick<UiSettings, 'profiles' | 'roles' | 'presets' | 'webSearch'>;

export async function sharedSettings(config: ConfigStore, secrets: SecretsStore, activeName?: string): Promise<SharedSettings> {
  const cfg = await config.load();
  const modelConfig = await config.modelConfig();
  const active = activeName ?? (await config.getActiveProfile())?.name;
  const profiles = await Promise.all(
    (await config.listProfiles()).map(async (p) => ({
      name: p.name,
      preset: p.preset,
      baseUrl: p.baseUrl,
      model: p.model,
      temperature: p.temperature,
      hasKey: Boolean(await secrets.getApiKey(p.name).catch(() => undefined)),
      active: p.name === active,
      nativeToolCalls: resolveCapabilities(p).nativeToolCalls,
      contextWindow: p.contextWindow,
      effectiveContextWindow: profileContextWindow(p),
      maxTokens: p.maxTokens,
      timeoutMs: p.timeoutMs,
      promptTier: p.promptTier,
    })),
  );
  return {
    profiles,
    roles: UI_MODEL_ROLES.map((role) => ({
      role: role.key,
      connection: modelConfig.roles[role.key]?.connection,
      model: modelConfig.roles[role.key]?.model,
      summary: describeRole(modelConfig, role.key),
    })),
    presets: providerPresets.map((p) => ({
      id: p.id,
      label: p.label,
      defaultBaseUrl: p.defaultBaseUrl,
      requiresApiKey: p.requiresApiKey,
      local: p.local,
      apiKeyUrl: p.apiKeyUrl,
    })),
    webSearch: {
      providers: [...SEARCH_PRESETS],
      provider: cfg.webSearch?.provider,
      enabled: cfg.webSearch?.enabled ?? Boolean(cfg.webSearch?.provider),
      hasKey: Boolean(await secrets.getApiKey(WEB_SEARCH_SECRET_NAME).catch(() => undefined)),
    },
  };
}

/** Add or edit a connection; a key, when given, goes to secrets. */
export async function saveConnection(config: ConfigStore, secrets: SecretsStore, params: UiSaveProfileParams & { apiKey?: string }): Promise<void> {
  const next = mergeProfile(await config.getProfile(params.profile.name), params.profile);
  await config.saveProfile(next);
  if (params.apiKey) await secrets.setApiKey(params.profile.name, params.apiKey);
}

export async function deleteConnection(config: ConfigStore, secrets: SecretsStore, name: string): Promise<void> {
  await config.deleteProfile(name);
  await secrets.deleteApiKey(name).catch(() => undefined);
}

/** Assign a role, or clear it so it inherits. Chat is what the rest inherit from, so it cannot be cleared. */
export async function setModelRole(config: ConfigStore, role: UiModelRole, assignment?: { connection: string; model: string }): Promise<void> {
  if (role === 'chat') {
    if (!assignment) throw new Error('Chat is what the other roles inherit from, so it cannot be cleared.');
    await config.setChatModel(assignment.connection, assignment.model);
  } else {
    await config.setRole(role, assignment);
  }
}

export async function setWebSearch(config: ConfigStore, secrets: SecretsStore, patch: { provider?: string; enabled?: boolean; apiKey?: string }): Promise<void> {
  if (patch.apiKey !== undefined) await secrets.setApiKey(WEB_SEARCH_SECRET_NAME, patch.apiKey);
  const next: Record<string, unknown> = {};
  if (patch.provider !== undefined) next.provider = patch.provider;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (Object.keys(next).length) await config.saveWebSearch(next);
}
