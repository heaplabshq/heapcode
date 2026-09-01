import type { PresetId, ProviderCapabilities } from '../providers/presets.js';
import type { ProviderProfileConfig } from './profiles.js';

/**
 * Connections and role assignments — the two halves a "profile" used to be.
 *
 * A profile was simultaneously a credentialed endpoint (preset, base URL, the
 * key in secret storage) and a model choice with its tuning. Because one object
 * was both, "which profile is active" had to answer both questions, so every
 * profile carried its own copy of all seven role assignments and seven
 * `<role>Profile` redirects pointing at other profiles' copies.
 *
 * Three things came out of that. Answering "what actually runs rerank?" took
 * two lookups and a fallback chain. Switching the active profile silently
 * rewrote every role. And because embeddings was one of those roles, a profile
 * switch could put vectors from two different embedding models into one index —
 * they are not comparable, so search quietly degraded with nothing to see.
 *
 * Split in two: a `ProviderConnection` is an endpoint and nothing else, and a
 * `ModelAssignment` names a model on one of them. One global `ModelRoleTable`
 * says which assignment serves which role, so the answer is a single lookup and
 * it does not change underfoot.
 */

/**
 * A credentialed endpoint. No models, no roles, no tuning.
 *
 * `name` is load-bearing: it is the key API keys are stored under in every host
 * (`heapcode.apiKey.<name>` in VS Code's SecretStorage, the same shape in the
 * CLI's secrets.json, `heapbrowse.apiKey.<name>` in chrome.storage.local), and
 * it is what travels on the wire as `profileName`. Renaming a connection has to
 * move its key with it; migrating from profiles keeps the old name for exactly
 * this reason.
 */
export interface ProviderConnection {
  name: string;
  preset: PresetId;
  baseUrl: string;
  headers?: Record<string, string>;
  /** Per-endpoint overrides of the preset's capability defaults. */
  capabilities?: Partial<ProviderCapabilities>;
  /**
   * Per-request timeout (ms). On the connection rather than the assignment
   * because it describes how long this endpoint takes to answer — a property
   * of the box, not of the weights running on it.
   */
  timeoutMs?: number;
}

/**
 * A model on a connection, plus that model's tuning.
 *
 * The tuning lives here and not on the connection, which is the part that is
 * easy to get wrong. `contextWindow`, `temperature`, `maxTokens` and
 * `promptTier` all describe a *model*; once any role may pick any model on any
 * connection, a small rerank model sharing an endpoint with a large agent model
 * must not inherit its 128k window.
 */
export interface ModelAssignment {
  /** `ProviderConnection.name`. */
  connection: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Model context window in tokens (prompt + output). Drives the context usage
   * meter and automatic conversation compaction. Unset asks the endpoint, then
   * falls back to the preset's number — see `createContextWindowResolver`.
   */
  contextWindow?: number;
  /**
   * How much of the agent prompt this model is given. 'full' (the default when
   * unset) is every section; 'lean' is the incident rules only, for a model
   * that follows short instructions better; 'auto' decides from the context
   * window and protocol.
   */
  promptTier?: 'full' | 'lean' | 'auto';
}

/** The roles a model can be assigned to. `chat` is the one the rest inherit from. */
export const MODEL_ROLES = [
  'chat',
  'agent',
  'edit',
  'apply',
  'completion',
  'embeddings',
  'rerank',
  'context',
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export function isModelRole(value: string): value is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(value);
}

/** One table, global — not one per connection. Every field may be unset, meaning "inherit". */
export type ModelRoleTable = Partial<Record<ModelRole, ModelAssignment>>;

/**
 * What each role falls back to, in order, when it has no assignment of its own.
 *
 * Two roles deliberately inherit nothing:
 *
 * `embeddings`, because a chat model asked to embed either errors or returns
 * something that is not an embedding, and the second one surfaces as bad search
 * results rather than as a failure. "Off" is the honest default — no assignment
 * means no semantic index, which the UI says out loud.
 *
 * `apply`, because it is a fast-apply merge model (FastApply-1.5B and its like)
 * whose whole job is a format a general chat model does not produce. Unset
 * means edit_file falls back to its selection/insert path, which is a worse
 * edit but a correct one.
 */
const ROLE_FALLBACK: Record<ModelRole, readonly ModelRole[]> = {
  chat: [],
  agent: ['chat'],
  edit: ['chat'],
  apply: [],
  completion: ['chat'],
  embeddings: [],
  rerank: ['edit', 'chat'],
  context: ['rerank', 'edit', 'chat'],
};

/** The chain a role resolves through, itself first — for UI that explains where a value came from. */
export function roleChain(role: ModelRole): readonly ModelRole[] {
  return [role, ...ROLE_FALLBACK[role]];
}

/** Connections plus the one role table, as any host stores them. */
export interface ModelConfig {
  connections: ProviderConnection[];
  roles: ModelRoleTable;
}

export interface ResolvedRole {
  /** The role that was asked for. */
  role: ModelRole;
  /** Where the answer actually came from — equal to `role` unless it inherited. */
  from: ModelRole;
  connection: ProviderConnection;
  assignment: ModelAssignment;
  /**
   * The flattened runtime shape.
   *
   * Every consumer downstream of here — `createProvider`,
   * `resolveCapabilities`, `resolveContextWindow`, the agent loop, RAG, PR
   * review — already takes a profile plus a model string, so resolution
   * *produces* that shape and none of them had to change. This is why the
   * split was affordable: storage changed, the runtime did not.
   */
  profile: ProviderProfileConfig;
}

/** Connection + assignment, flattened into the shape the runtime already speaks. */
export function toProfile(
  connection: ProviderConnection,
  assignment: ModelAssignment,
): ProviderProfileConfig {
  return {
    name: connection.name,
    preset: connection.preset,
    baseUrl: connection.baseUrl,
    model: assignment.model,
    headers: connection.headers,
    capabilities: connection.capabilities,
    timeoutMs: connection.timeoutMs,
    temperature: assignment.temperature,
    maxTokens: assignment.maxTokens,
    contextWindow: assignment.contextWindow,
    promptTier: assignment.promptTier,
  };
}

/**
 * The assignment serving a role, following the inheritance chain.
 *
 * `undefined` means the role has nothing to run on — an unassigned role with no
 * fallback (embeddings, apply), or a chain that bottoms out because chat itself
 * is unset. Callers treat that as "this feature is off", which is what every
 * one of them did for an unset role before.
 *
 * An assignment naming a connection that no longer exists is skipped rather
 * than honoured, and resolution continues down the chain. A deleted connection
 * should degrade a role to its fallback, not break it: the alternative is
 * `createProvider` being handed an endpoint with no base URL and failing at
 * request time, several layers from anything that could explain it.
 */
export function resolveRole(config: ModelConfig, role: ModelRole): ResolvedRole | undefined {
  for (const candidate of roleChain(role)) {
    const assignment = config.roles[candidate];
    if (!assignment?.model) continue;
    const connection = config.connections.find((c) => c.name === assignment.connection);
    if (!connection) continue;
    return { role, from: candidate, connection, assignment, profile: toProfile(connection, assignment) };
  }
  return undefined;
}

/**
 * The same walk over the table alone, without checking that the connection
 * exists.
 *
 * The server needs this. A session holds only the connections its host pushed
 * at hello, so a connection missing *there* means "not sent yet" and is
 * fetched on demand via `key/request` — the opposite of what it means in a
 * host's own config, where missing means deleted. Using `resolveRole` in the
 * server would quietly degrade every role whose connection had not been
 * pushed yet down to chat.
 */
export function resolveAssignment(
  roles: ModelRoleTable,
  role: ModelRole,
): { from: ModelRole; assignment: ModelAssignment } | undefined {
  for (const candidate of roleChain(role)) {
    const assignment = roles[candidate];
    if (assignment?.model) return { from: candidate, assignment };
  }
  return undefined;
}

/**
 * Why a role resolves to what it does, in one line, for settings screens.
 *
 * The old UI showed a model field and a "this profile" dropdown per role and
 * left the reader to trace the chain. This states the outcome instead.
 */
export function describeRole(config: ModelConfig, role: ModelRole): string {
  const resolved = resolveRole(config, role);
  if (!resolved) {
    return role === 'embeddings'
      ? 'not set — semantic search is off'
      : role === 'apply'
        ? 'not set — edits fall back to selection/insert'
        : 'not set';
  }
  const where = `${resolved.assignment.model} on ${resolved.connection.name}`;
  return resolved.from === role ? where : `inherits ${resolved.from} — ${where}`;
}

// ---------------------------------------------------------------------------
// Migration from profiles
// ---------------------------------------------------------------------------

/**
 * The stored shape before this change, for reading old config only.
 *
 * Kept as its own type rather than left on `ProviderProfileConfig` so it is
 * obvious at every use site that these fields are being *read* out of history
 * and never written. Nothing but `migrateProfiles` should reference it.
 */
export interface LegacyProviderProfile extends ProviderProfileConfig {
  editModel?: string;
  applyModel?: string;
  completionModel?: string;
  agentModel?: string;
  embeddingsModel?: string;
  rerankModel?: string;
  contextModel?: string;
  editProfile?: string;
  applyProfile?: string;
  completionProfile?: string;
  agentProfile?: string;
  embeddingsProfile?: string;
  rerankProfile?: string;
  contextProfile?: string;
}

/** Role → the pair of legacy fields that used to configure it. */
const LEGACY_FIELDS: Record<
  Exclude<ModelRole, 'chat'>,
  { model: keyof LegacyProviderProfile; profile: keyof LegacyProviderProfile }
> = {
  agent: { model: 'agentModel', profile: 'agentProfile' },
  edit: { model: 'editModel', profile: 'editProfile' },
  apply: { model: 'applyModel', profile: 'applyProfile' },
  completion: { model: 'completionModel', profile: 'completionProfile' },
  embeddings: { model: 'embeddingsModel', profile: 'embeddingsProfile' },
  rerank: { model: 'rerankModel', profile: 'rerankProfile' },
  context: { model: 'contextModel', profile: 'contextProfile' },
};

/** The endpoint half of a profile, dropping the model and role halves. */
export function toConnection(profile: ProviderProfileConfig): ProviderConnection {
  const connection: ProviderConnection = {
    name: profile.name,
    preset: profile.preset,
    baseUrl: profile.baseUrl,
  };
  if (profile.headers) connection.headers = profile.headers;
  if (profile.capabilities) connection.capabilities = profile.capabilities;
  if (profile.timeoutMs !== undefined) connection.timeoutMs = profile.timeoutMs;
  return connection;
}

/**
 * Old config → new, one way, run on first read by every host.
 *
 * Every profile becomes a connection under its own name, because the API key is
 * filed under that name and a rename means the user re-enters it.
 *
 * The role table is seeded from the *active* profile alone, since that is the
 * one whose roles were in force. Each role's `<role>Profile` redirect is
 * followed once and flattened to a concrete `{connection, model}` pair — the
 * redirect pointed at another profile and then read *that* profile's same role
 * field, so following it here is what preserves the behaviour the user
 * configured. A role left unset stays unset, so it keeps inheriting.
 *
 * Tuning travels with the chat assignment rather than being duplicated onto
 * every role: it was one profile-wide setting before, and copying it onto seven
 * assignments would turn a single number the user set once into seven they now
 * have to keep in sync.
 */
export function migrateProfiles(
  profiles: readonly LegacyProviderProfile[],
  activeProfile?: string,
): ModelConfig {
  const connections = profiles.map(toConnection);
  const roles: ModelRoleTable = {};
  const active = profiles.find((p) => p.name === activeProfile) ?? profiles[0];
  if (!active) return { connections, roles };

  if (active.model) {
    roles.chat = {
      connection: active.name,
      model: active.model,
      temperature: active.temperature,
      maxTokens: active.maxTokens,
      contextWindow: active.contextWindow,
      promptTier: active.promptTier,
    };
  }

  for (const [role, fields] of Object.entries(LEGACY_FIELDS) as Array<
    [Exclude<ModelRole, 'chat'>, (typeof LEGACY_FIELDS)[Exclude<ModelRole, 'chat'>]]
  >) {
    const redirect = active[fields.profile] as string | undefined;
    // The redirect names a *profile*, and the model then came from that
    // profile's own field for the same role — falling back to its chat model,
    // exactly as the old two-hop resolution did.
    const target = redirect ? profiles.find((p) => p.name === redirect) : undefined;
    const source = target ?? active;
    const model = (source[fields.model] as string | undefined) || (target ? target.model : undefined);
    // `active[fields.model]` alone when there is no redirect: an unset role
    // stayed unset and inherited, and it should keep inheriting rather than be
    // pinned to whatever chat happened to be at migration time.
    const resolved = target ? model : (active[fields.model] as string | undefined);
    if (!resolved) continue;
    roles[role] = { connection: source.name, model: resolved };
  }

  return { connections, roles };
}

/**
 * Whether a stored config still needs migrating.
 *
 * True for the old shape and for an empty one that has never been written; the
 * hosts call this before touching disk so a config already on the new shape is
 * not rewritten on every read.
 */
export function needsMigration(stored: {
  connections?: unknown;
  profiles?: unknown;
}): boolean {
  return !Array.isArray(stored.connections) && Array.isArray(stored.profiles);
}
