import { getPreset, type PresetId, type ProviderCapabilities } from '../providers/presets.js';
import { DEFAULT_CONTEXT_WINDOW } from '../context/tokens.js';

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
  /** Inline edits, commit messages. Inherits chat when unset. */
  editModel?: string;
  /** Fast-apply merge model (e.g. FastApply-1.5B) for applying code blocks to files. */
  applyModel?: string;
  /** Ghost-text autocomplete. Inherits chat when unset. */
  completionModel?: string;
  /** Agent mode. Inherits chat when unset. */
  agentModel?: string;
  embeddingsModel?: string;
  /** Reranks semantic-search hits. Inherits edit → chat model when unset. */
  rerankModel?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Model context window in tokens (prompt + output). Drives the context
   * usage meter and automatic conversation compaction. Default 32768.
   */
  contextWindow?: number;
  /** Per-request timeout for non-streaming calls (ms). Default 120000. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Per-profile overrides of the preset's capability defaults. */
  capabilities?: Partial<ProviderCapabilities>;
}

export function resolveCapabilities(profile: ProviderProfileConfig): ProviderCapabilities {
  return { ...getPreset(profile.preset).capabilities, ...profile.capabilities };
}

/**
 * Effective context window for the meter and compaction:
 * explicit profile setting → preset's known maxContext → conservative default.
 * Without this chain, large-context providers (128k presets) would compact
 * prematurely at the 32k fallback.
 */
export function resolveContextWindow(profile: ProviderProfileConfig): number {
  return profile.contextWindow ?? resolveCapabilities(profile).maxContext ?? DEFAULT_CONTEXT_WINDOW;
}
