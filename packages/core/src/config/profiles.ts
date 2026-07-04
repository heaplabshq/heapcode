import { getPreset, type PresetId, type ProviderCapabilities } from '../providers/presets.js';

/**
 * A named provider configuration. API keys are NOT part of the profile —
 * they live in the IDE's secret storage, keyed by profile name.
 */
export interface ProviderProfileConfig {
  name: string;
  preset: PresetId;
  baseUrl: string;
  /** Chat model id (for Azure: the deployment name). */
  model: string;
  /** Inline edits, apply, commit messages. Inherits chat when unset. */
  editModel?: string;
  /** Ghost-text autocomplete. Inherits chat when unset. */
  completionModel?: string;
  /** Agent mode. Inherits chat when unset. */
  agentModel?: string;
  embeddingsModel?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  /** Per-profile overrides of the preset's capability defaults. */
  capabilities?: Partial<ProviderCapabilities>;
}

export function resolveCapabilities(profile: ProviderProfileConfig): ProviderCapabilities {
  return { ...getPreset(profile.preset).capabilities, ...profile.capabilities };
}
