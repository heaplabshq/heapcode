import { createProvider, type ModelRole, type Provider, type ProviderProfileConfig } from '@heapcode/core';
import type { ConfigStore } from '../config/store.js';
import type { SecretsStore } from '../config/secrets.js';

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
 * Node-native port of packages/vscode/src/profileManager.ts's
 * resolveRoleProfile/resolveRole: which profile actually serves a given role
 * (RAG's embeddings/rerank/context models, in CLI-M3) — the active profile,
 * unless it names a different one via its `<role>Profile` field, in which
 * case that named profile's own baseUrl/key/model is used instead.
 */
export class RoleResolver {
  constructor(
    private readonly config: ConfigStore,
    private readonly secrets: SecretsStore,
    private readonly active: ProviderProfileConfig,
  ) {}

  /** Synchronous (no secret-storage lookup) so it's cheap to call just to check a model name. */
  async resolveRoleProfile(role: ModelRole): Promise<ProviderProfileConfig> {
    const targetName = this.active[ROLE_PROFILE_FIELD[role]] as string | undefined;
    if (!targetName || targetName === this.active.name) return this.active;
    return (await this.config.getProfile(targetName)) ?? this.active;
  }

  /** Provider + profile for a role, following its `<role>Profile` redirect. */
  async resolveRole(role: ModelRole): Promise<{ provider: Provider; profile: ProviderProfileConfig }> {
    const profile = await this.resolveRoleProfile(role);
    const apiKey = await this.secrets.getApiKey(profile.name);
    return { provider: createProvider(profile, apiKey), profile };
  }
}
