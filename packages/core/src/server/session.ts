import { createProvider } from '../providers/factory.js';
import type { ModelRole, ProviderProfileConfig } from '../config/profiles.js';
import type { Provider } from '../providers/types.js';
import type { HelloParams, KeyRequestResult } from './protocol.js';

/**
 * Which `<role>Profile` field redirects each role, mirroring
 * packages/cli/src/provider/roles.ts:5-13 and the extension's copy at
 * packages/vscode/src/profileManager.ts. Both of those resolve roles
 * host-side today; this is the one server-side implementation they collapse
 * into (custody note's recommendation, point 4).
 */
const ROLE_PROFILE_FIELD: Record<ModelRole, keyof ProviderProfileConfig> = {
  editModel: 'editProfile',
  applyModel: 'applyProfile',
  completionModel: 'completionProfile',
  agentModel: 'agentProfile',
  embeddingsModel: 'embeddingsProfile',
  rerankModel: 'rerankProfile',
  contextModel: 'contextProfile',
};

/** Asks the host for a profile's key and config (`key/request`, §2 option b). */
export type KeyRequester = (profileName: string) => Promise<void>;

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
  readonly activeProfile: string;

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

  constructor(id: string, hello: HelloParams) {
    this.id = id;
    this.root = hello.root;
    this.activeProfile = hello.activeProfile;
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
   * Provider + profile for a role, following the profile's `<role>Profile`
   * redirect — e.g. embeddings on a local Ollama profile while chat and agent
   * stay on a cloud one.
   *
   * This is the server-side twin of `RoleResolver.resolveRole`
   * (packages/cli/src/provider/roles.ts:36-41) and
   * `ProfileManager.resolveRole` (packages/vscode/src/profileManager.ts:172-176),
   * with the same fallbacks: an unset, self-referencing, or unknown target
   * falls back to the profile being redirected from.
   *
   * The redirect target is normally *not* in this session — all three hosts
   * push only the active profile at hello (packages/cli/src/ink/App.tsx:426,
   * packages/cli/src/headless.ts:207, packages/vscode/src/serverLink.ts:91) —
   * so `key/request` is the ordinary path here, not the exception. That is
   * exactly the case protocol §2 named RAG as needing first.
   */
  async providerForRole(
    role: ModelRole,
    requestKey?: KeyRequester,
    fromProfile?: string,
  ): Promise<{ provider: Provider; profile: ProviderProfileConfig } | undefined> {
    const baseName = fromProfile ?? this.activeProfile;
    const base = this.providerFor(baseName);
    if (!base) return undefined;
    const targetName = base.profile[ROLE_PROFILE_FIELD[role]] as string | undefined;
    if (!targetName || targetName === baseName) return base;
    return (await this.resolveProfile(targetName, requestKey)) ?? base;
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
