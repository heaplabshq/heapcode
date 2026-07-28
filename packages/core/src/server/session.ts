import { createProvider } from '../providers/factory.js';
import type { ProviderProfileConfig } from '../config/profiles.js';
import type { Provider } from '../providers/types.js';
import type { HelloParams, KeyRequestResult } from './protocol.js';

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
  }
}
