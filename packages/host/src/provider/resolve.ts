import {
  DEFAULT_CONTEXT_WINDOW,
  resolveCapabilities,
  resolveContextWindow,
  type ContextWindowSource,
  type ModelInfo,
  type ProviderProfileConfig,
} from '@heapcode/core';

/**
 * The effective context window for a profile.
 *
 * This used to build a Provider too. Nothing in the CLI calls one any more —
 * the agent loop, chat, RAG and PR review all run in the server, and /model
 * lists through `provider/listModels` — so constructing one here would be
 * reading a key out of secrets storage for an object that never makes a
 * request. The context window is still needed host-side: it sizes the usage
 * meter and PR review's per-batch diff budget, both of which the host passes
 * on the wire.
 *
 * The preset's number, with no model consulted. Correct only when the profile
 * says so explicitly; otherwise see `createContextWindowResolver`, which is
 * what every host should be using.
 */
export function profileContextWindow(profile: ProviderProfileConfig): number {
  return resolveContextWindow(profile);
}

/** Lists a profile's models, optionally asking about one model's context length. */
export type ModelLister = (profileName: string, model?: string) => Promise<ModelInfo[]>;

export interface ResolvedContextWindow {
  window: number;
  source: ContextWindowSource;
}

/**
 * The window a model actually has: profile setting → what the endpoint reports
 * → the preset's default → 32768.
 *
 * The middle tier is the one that was missing. Two of the three hosts sized
 * their window from the preset alone, and a preset is a guess about a whole
 * family of endpoints. Guess too small and the conversation compacts earlier
 * than it needs to, which is merely wasteful. Guess too large — 128k for a
 * hosted endpoint serving far less — and the meter never looks full,
 * compaction never fires, and the endpoint silently drops the oldest part of
 * the prompt instead. The agent then forgets what it read and reads it again:
 * a loop that, from outside, looks like it will never stop.
 *
 * Cached per endpoint+model, because this is on the path of every turn and the
 * answer does not change while a process lives. Never throws: an unreachable
 * endpoint falls through to exactly the behaviour there was before.
 */
export interface ContextWindowResolver {
  /**
   * What is known right now, without waiting. Starts a lookup in the
   * background the first time it is asked about a model.
   *
   * The run path uses this. Sizing a window must never delay a turn or, worse,
   * hang one behind an endpoint that has stopped answering — the fallback is
   * the preset default, which is what every host used unconditionally before.
   */
  known(profile: ProviderProfileConfig, model: string): ResolvedContextWindow;
  /** The same answer, waiting for the lookup if one is in flight. */
  resolve(profile: ProviderProfileConfig, model: string): Promise<ResolvedContextWindow>;
}

export function createContextWindowResolver(listModels: ModelLister): ContextWindowResolver {
  /** endpoint+model → what the endpoint said, or undefined for "asked, no answer". */
  const answers = new Map<string, number | undefined>();
  const inFlight = new Map<string, Promise<void>>();

  const fallback = (profile: ProviderProfileConfig): ResolvedContextWindow => {
    const preset = resolveCapabilities(profile).maxContext;
    return preset
      ? { window: preset, source: 'preset' }
      : { window: DEFAULT_CONTEXT_WINDOW, source: 'default' };
  };

  const lookup = (profile: ProviderProfileConfig, model: string, key: string): Promise<void> => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const started = listModels(profile.name, model)
      .then((models) => {
        answers.set(key, models.find((m) => m.id === model)?.contextLength);
      })
      .catch(() => {
        // Unreachable, unlistable, or no daemon yet. Recorded as "asked, no
        // answer" so a dead endpoint is not re-probed on every turn.
        answers.set(key, undefined);
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, started);
    return started;
  };

  const answer = (profile: ProviderProfileConfig, key: string): ResolvedContextWindow => {
    const reported = answers.get(key);
    return reported ? { window: reported, source: 'model' } : fallback(profile);
  };

  return {
    known(profile, model) {
      if (profile.contextWindow) return { window: profile.contextWindow, source: 'profile' };
      const key = `${profile.baseUrl}|${model}`;
      if (!answers.has(key)) {
        void lookup(profile, model, key);
        return fallback(profile);
      }
      return answer(profile, key);
    },
    async resolve(profile, model) {
      if (profile.contextWindow) return { window: profile.contextWindow, source: 'profile' };
      const key = `${profile.baseUrl}|${model}`;
      if (!answers.has(key)) await lookup(profile, model, key);
      return answer(profile, key);
    },
  };
}
