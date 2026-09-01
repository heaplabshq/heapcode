import { createProvider } from '../providers/factory.js';
import type { ProviderProfileConfig } from '../config/profiles.js';
import { roleChain, type ModelRole, type ModelRoleTable } from '../config/roles.js';
import type { Provider } from '../providers/types.js';
import type { HelloParams, KeyRequestResult } from './protocol.js';

/** Asks the host for a connection's key and config (`key/request`, §2 option b). */
export type KeyRequester = (connectionName: string) => Promise<void>;

/**
 * One host connection's world.
 *
 * Every piece of state below hangs off this object, which is how
 * docs/phase3-protocol-design.md §2's isolation invariant is enforced
 * structurally rather than by convention: there is no process-global key
 * map and no global "current provider" anywhere in the server, so one
 * session physically cannot reach another's key or Provider. Two VS Code
 * windows, or VS Code plus a JetBrains client, may legitimately be running
 * different profiles with different keys at the same moment.
 *
 * Keys live here in memory for the connection's lifetime and are never
 * written to disk (custody note, Option A2).
 */
export class Session {
  readonly id: string;
  readonly root: string;
  /**
   * The connection a call runs against when it names none.
   *
   * This is the chat role's connection, not a "current profile" any more:
   * which model serves which role is one global table (`roles` below), so
   * switching what you chat with no longer silently rewrites the other six.
   */
  readonly activeProfile: string;
  /** Which model on which connection serves each role. One table, not one per connection. */
  private roles: ModelRoleTable;
  /** False when `root` is not a real local directory — see HelloParams.localRoot. */
  readonly localRoot: boolean;

  private readonly keys = new Map<string, string>();
  private readonly profiles = new Map<string, ProviderProfileConfig>();
  /** Lazily built, cached per profile — createProvider is not free and a run may resolve the same profile repeatedly. */
  private readonly providers = new Map<string, Provider>();
  /**
   * Profile names already put to the host via `key/request`. Protocol §2 asks
   * for the answer to be "cached in the session for its lifetime", and a
   * *negative* answer needs caching just as much as a positive one: a local
   * Ollama profile legitimately has no API key, so `hasKey` stays false
   * forever and an unguarded check would re-ask on every single call.
   */
  private readonly asked = new Set<string>();
  private readonly runs = new Map<string, AbortController>();
  private disposed = false;

  /** The daemon log, when the server gave the session one. */
  private log?: (line: string) => void;

  constructor(id: string, hello: HelloParams, log?: (line: string) => void) {
    this.id = id;
    this.log = log;
    this.root = hello.root;
    this.activeProfile = hello.activeProfile;
    this.localRoot = hello.localRoot ?? true;
    this.roles = hello.roles ?? {};
    for (const profile of hello.profiles) this.profiles.set(profile.name, profile);
    for (const [name, key] of Object.entries(hello.keys ?? {})) this.keys.set(name, key);
  }

  getProfile(name: string): ProviderProfileConfig | undefined {
    return this.profiles.get(name);
  }

  /**
   * The Provider for a profile, built from **this session's** key map only.
   * Returns undefined when the profile isn't known here — callers fall back
   * to the parent/active provider, matching what both hosts already did for
   * an unknown profile name (packages/cli/src/agent/delegate.ts:107-108).
   */
  providerFor(profileName: string): { provider: Provider; profile: ProviderProfileConfig } | undefined {
    const profile = this.profiles.get(profileName);
    if (!profile) return undefined;
    const cached = this.providers.get(profileName);
    if (cached) return { provider: cached, profile };
    const provider = createProvider(profile, this.keys.get(profileName));
    this.providers.set(profileName, provider);
    return { provider, profile };
  }

  /**
   * The Provider for a profile this session may not hold yet, asking the host
   * for it at most once per name (§2, option b).
   *
   * Returns undefined when the host doesn't know the profile either —
   * callers fall back to the parent/active provider, which is what both hosts
   * already did for an unknown profile name.
   */
  async resolveProfile(
    profileName: string,
    requestKey?: KeyRequester,
  ): Promise<{ provider: Provider; profile: ProviderProfileConfig } | undefined> {
    if (requestKey && !this.asked.has(profileName) && (!this.getProfile(profileName) || !this.hasKey(profileName))) {
      this.asked.add(profileName);
      await requestKey(profileName);
    }
    return this.providerFor(profileName);
  }

  /**
   * Provider + model for a role: one lookup in the global role table.
   *
   * This used to be two hops. A role read a `<role>Model` field off the active
   * profile, and a `<role>Profile` field could redirect it to *another*
   * profile, whose same-named role field was then read, itself falling back to
   * that profile's chat model. Answering "what runs rerank?" meant tracing
   * that by hand, and switching the active profile silently rewrote all seven
   * answers at once.
   *
   * Now the table is global and says outright which model on which connection
   * serves the role, with one inheritance chain (config/roles.ts) instead of
   * seven per-profile ones.
   *
   * The connection an assignment names is usually *not* in this session — the
   * hosts push only what the chat role needs at hello — so `key/request` is the
   * ordinary path here, not the exception. That is exactly the case protocol §2
   * named RAG as needing first.
   *
   * `fromProfile` is a caller pinning the role to one connection (delegate_task
   * naming a profile, mostly); it still wins over the table.
   */
  async providerForRole(
    role: ModelRole,
    requestKey?: KeyRequester,
    fromProfile?: string,
  ): Promise<{ provider: Provider; profile: ProviderProfileConfig } | undefined> {
    if (fromProfile) return this.resolveProfile(fromProfile, requestKey);

    // Whether this role has anywhere to fall back to. `embeddings` and `apply`
    // inherit nothing, and that is load-bearing rather than a detail: handing
    // either of them a chat model is not a degraded answer, it is a wrong one.
    const chain = roleChain(role);
    const inherits = chain.length > 1;

    // Walked here rather than through `resolveRole`, because in a session a
    // connection that is missing means "not pushed yet" and is fetched over
    // `key/request` — the opposite of what it means in a host's config, where
    // missing means deleted.
    for (const candidate of chain) {
      const assignment = this.roles[candidate];
      if (!assignment?.model) continue;

      // A connection the host already pushed is used as-is. Going through
      // `resolveProfile` would ask for its key over `key/request` even though
      // it arrived at hello — and a keyless local endpoint has `hasKey` false
      // forever, so that ask is both pointless and, for a host that does not
      // implement the callback, a hang.
      const base = this.getProfile(assignment.connection)
        ? this.providerFor(assignment.connection)
        : await this.resolveProfile(assignment.connection, requestKey);

      if (!base) {
        // Neither this session nor the host knows the connection. Carry on
        // down the chain rather than substituting: this used to return the
        // active connection, which comes back carrying its CHAT model because
        // that is what a connection is pushed with. Embeddings then ran the
        // chat model — OpenRouter answers "Model <chat model> does not exist"
        // — and the index was discarded as written by a different embedder,
        // with nothing anywhere saying a substitution had happened.
        this.log?.(
          `role "${role}" names connection "${assignment.connection}", which is not configured` +
            (inherits ? ' — continuing down its inheritance chain' : ' — leaving the role off'),
        );
        continue;
      }

      // The assignment's model and tuning win over whatever the connection was
      // pushed carrying: a connection is an endpoint, and its `model` field is
      // only ever the chat model that happened to travel with it.
      return {
        provider: base.provider,
        profile: {
          ...base.profile,
          model: assignment.model,
          temperature: assignment.temperature ?? base.profile.temperature,
          maxTokens: assignment.maxTokens ?? base.profile.maxTokens,
          contextWindow: assignment.contextWindow ?? base.profile.contextWindow,
          promptTier: assignment.promptTier ?? base.profile.promptTier,
        },
      };
    }

    // Nothing in the chain resolved. An EMPTY table is a host that has not
    // been converted — `roles` is optional at hello — and for a role that
    // inherits, the active connection's own model is the honest answer, which
    // is what a profile with no role overrides amounted to before the split.
    // Anything else is a deliberate "off".
    const noTable = Object.keys(this.roles).length === 0;
    return noTable && inherits ? this.providerFor(this.activeProfile) : undefined;
  }

  /** Replace the role table mid-session — the host pushes this when settings change. */
  setRoles(roles: ModelRoleTable): void {
    if (this.disposed) return;
    this.roles = roles;
  }

  /** Record a key/profile the host resolved lazily via `key/request` (§2, option b). */
  adoptResolvedKey(profileName: string, resolved: KeyRequestResult): void {
    if (this.disposed) return;
    if (resolved.profile) this.profiles.set(profileName, resolved.profile);
    if (resolved.apiKey) this.keys.set(profileName, resolved.apiKey);
    // Any cached Provider for this name predates the new key; drop it.
    this.providers.delete(profileName);
  }

  hasKey(profileName: string): boolean {
    return this.keys.has(profileName);
  }

  /** Runs this session currently has in flight. */
  get runCount(): number {
    return this.runs.size;
  }

  beginRun(runId: string): AbortController {
    const controller = new AbortController();
    this.runs.set(runId, controller);
    return controller;
  }

  endRun(runId: string): void {
    this.runs.delete(runId);
  }

  cancelRun(runId: string): boolean {
    const controller = this.runs.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Disconnect destroys the session: keys dropped, in-flight runs aborted.
   * No session outlives its connection (§2) — a reconnecting host pushes its
   * keys again.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, controller] of this.runs) controller.abort();
    this.runs.clear();
    this.keys.clear();
    this.providers.clear();
    this.profiles.clear();
    this.asked.clear();
  }
}
