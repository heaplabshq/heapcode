import { getPreset, type PresetId, type ProviderCapabilities } from '../providers/presets.js';
import { DEFAULT_CONTEXT_WINDOW } from '../context/tokens.js';

/**
 * One endpoint and one model, flattened — what the runtime speaks.
 *
 * This used to be the *stored* shape, and it carried a model choice, seven
 * per-role model overrides and seven `<role>Profile` redirects all at once.
 * Those moved to `config/roles.ts`: connections are endpoints, a role table
 * says which model on which connection serves which role, and resolving a role
 * produces one of these (see `toProfile`).
 *
 * It stays because everything downstream — `createProvider`,
 * `resolveCapabilities`, `resolveContextWindow`, the agent loop, RAG, PR review
 * — already took a profile plus a model string. Resolution producing this shape
 * is what kept the split from rippling into all of them.
 *
 * API keys are NOT part of it. They live in each host's secret storage, keyed
 * by `name`, which is the connection's name.
 */
export interface ProviderProfileConfig {
  /** The connection's name — also the key its API key is filed under. */
  name: string;
  preset: PresetId;
  baseUrl: string;
  /** Model id (for Azure: the deployment name). */
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * How much of the agent prompt this model is given.
   *
   * 'full' (the default when unset) is every section. 'lean' is the incident
   * rules only — the identity, the untrusted-data and anti-fabrication rules,
   * verify, and the reply style — for a model that follows short instructions
   * better. 'auto' decides from the model's context window and protocol.
   *
   * Full by default rather than derived, because quietly shortening the prompt
   * makes the agent behave differently with nothing saying so, and the
   * difference surfaces as a model ignoring an instruction it never received.
   */
  promptTier?: 'full' | 'lean' | 'auto';
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
  /** Per-connection overrides of the preset's capability defaults. */
  capabilities?: Partial<ProviderCapabilities>;
}

export function resolveCapabilities(profile: ProviderProfileConfig): ProviderCapabilities {
  return { ...getPreset(profile.preset).capabilities, ...profile.capabilities };
}

/**
 * Effective context window for the meter and compaction:
 * explicit setting → preset's known maxContext → conservative default.
 * Without this chain, large-context providers (128k presets) would compact
 * prematurely at the 32k fallback.
 */
export function resolveContextWindow(profile: ProviderProfileConfig): number {
  return profile.contextWindow ?? resolveCapabilities(profile).maxContext ?? DEFAULT_CONTEXT_WINDOW;
}
