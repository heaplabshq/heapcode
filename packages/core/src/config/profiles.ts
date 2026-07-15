import { getPreset, type PresetId, type ProviderCapabilities } from '../providers/presets.js';
import { DEFAULT_CONTEXT_WINDOW } from '../context/tokens.js';

/**
 * A named provider configuration. API keys are NOT part of the profile —
 * they live in the IDE's secret storage, keyed by profile name.
 */
/** Roles that can each run against a different configured profile entirely (see `*Profile` fields below). */
export type ModelRole =
  | 'editModel'
  | 'applyModel'
  | 'completionModel'
  | 'agentModel'
  | 'embeddingsModel'
  | 'rerankModel';

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
  /**
   * Run this role against a different configured profile's provider entirely
   * (its baseUrl/key/model), instead of this one — e.g. embeddings on a local
   * Ollama profile while chat/agent stay on a cloud profile. Falls back to
   * this profile when unset, self-referencing, or the named profile doesn't
   * exist.
   */
  editProfile?: string;
  applyProfile?: string;
  completionProfile?: string;
  agentProfile?: string;
  embeddingsProfile?: string;
  rerankProfile?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Model context window in tokens (prompt + output). Drives the context
   * usage meter and automatic conversation compaction. Default 32768.
   */
  contextWindow?: number;
  /**
   * Per-request timeout (ms): the full response for non-streaming calls, or
   * time-to-first-token for streaming/agent calls (not the whole reply).
   * Default 300000. Raise this for local/slow models on large prompts.
   */
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
