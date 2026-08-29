import type {
  AgentEvent,
  AgentOutcome,
  ContextWindowSource,
  PermissionChoice,
  PermissionClass,
  TodoItem,
} from '@heapcode/core';

/**
 * The wire protocol between the **browser** and the **web host**.
 *
 * **This module must stay browser-safe.** It is published as
 * `@heapcode/web-host/protocol` precisely so the SPA can import `UI_METHODS`
 * (a runtime value) without following the package barrel into `server.ts` and
 * dragging `node:http`, `ws` and the whole host runtime into a browser bundle.
 * Everything it imports from `@heapcode/core` is therefore `import type`,
 * which erases at compile time — keep it that way.
 *
 * Deliberately NOT the daemon's method surface (packages/core/src/server/
 * protocol.ts). That one is shaped for a host with hands — it hands over raw
 * `ToolCall`s and expects a `ToolResult` back. A browser can't answer any of
 * that, and exposing it would mean the browser was deciding things the host
 * is responsible for.
 *
 * This surface is UI-shaped instead: the browser says "the user typed this"
 * and "the user clicked Allow", and receives things it can render. The host
 * translates in both directions. That asymmetry IS the trust boundary
 * (docs/WEB_APP_PLAN.md §3.2/§6).
 *
 * Envelope and framing are JSON-RPC 2.0 over one-JSON-object-per-WS-message,
 * carried by `RpcPeer` (see wsDuplex.ts for why that reuse works).
 */

export const UI_PROTOCOL_VERSION = 1;

export const UI_METHODS = {
  // browser → host
  hello: 'ui/hello',
  sendMessage: 'ui/sendMessage',
  cancel: 'ui/cancel',
  state: 'ui/state',
  conversations: 'ui/conversations',
  openConversation: 'ui/openConversation',
  newConversation: 'ui/newConversation',
  listModels: 'ui/listModels',
  probeProvider: 'ui/probeProvider',
  setModel: 'ui/setModel',
  setMode: 'ui/setMode',

  // settings (W5)
  settings: 'ui/settings',
  setPersona: 'ui/setPersona',
  setSubAgents: 'ui/setSubAgents',
  setNativeTools: 'ui/setNativeTools',
  setWebSearch: 'ui/setWebSearch',
  resetPermissions: 'ui/resetPermissions',
  saveProfile: 'ui/saveProfile',
  deleteProfile: 'ui/deleteProfile',
  saveMcpServer: 'ui/saveMcpServer',
  deleteMcpServer: 'ui/deleteMcpServer',
  useProfile: 'ui/useProfile',
  runCommand: 'ui/runCommand',

  // workspace panel (W6)
  changes: 'ui/changes',
  diff: 'ui/diff',
  fileTree: 'ui/fileTree',
  readFile: 'ui/readFile',
  revertFile: 'ui/revertFile',
  revertAll: 'ui/revertAll',
  keepAll: 'ui/keepAll',
  checkpoints: 'ui/checkpoints',
  rewind: 'ui/rewind',
  search: 'ui/search',
  reindex: 'ui/reindex',
  memory: 'ui/memory',
  skills: 'ui/skills',

  /** `/pr-review` — the same review the CLI and the extension run (W8). */
  review: 'ui/review',

  // artifacts (W7)
  artifacts: 'ui/artifacts',
  artifact: 'ui/artifact',
  saveArtifact: 'ui/saveArtifact',

  // workspace switching
  workspaces: 'ui/workspaces',
  browseFolders: 'ui/browseFolders',
  setWorkspace: 'ui/setWorkspace',

  /** Where the context window is actually going — the meter's detail view. */
  context: 'ui/context',

  // the index: what the agent knows about this workspace
  indexStatus: 'ui/indexStatus',
  repoMap: 'ui/repoMap',

  // host → browser (requests — the host waits for an answer)
  permissionRequest: 'ui/permissionRequest',
  askUser: 'ui/askUser',
  /** The one gate before a review is posted publicly to GitHub. */
  reviewConfirm: 'ui/reviewConfirm',

  // host → browser (notifications)
  event: 'ui/event',
  stateChanged: 'ui/stateChanged',
  /** The changed-file set moved; the panel refetches rather than guessing. */
  workspaceChanged: 'ui/workspaceChanged',
  /** An artifact was created or got a new version. */
  artifactChanged: 'ui/artifactChanged',
  /** Indexing progress and state, forwarded from the daemon's `rag/event`. */
  indexChanged: 'ui/indexChanged',
  /** A review's progress and warnings, forwarded from the daemon's `review/event`. */
  reviewEvent: 'ui/reviewEvent',
} as const;

// ---------------------------------------------------------------------------
// browser → host
// ---------------------------------------------------------------------------

export interface UiHelloParams {
  protocolVersion: number;
  client?: { name: string; version?: string };
  /**
   * Replay buffered events for a run already in flight. A browser refresh
   * must reattach to a running agent, not restart it (§5.4) — the host owns
   * run state, the tab does not.
   */
  resumeRunId?: string;
}

export interface UiHelloResult {
  protocolVersion: number;
  state: UiState;
  /** The open conversation's transcript, so a fresh tab renders history. */
  messages: UiMessage[];
  /** Set when a run was already in flight; its buffered events follow. */
  activeRunId?: string;
  replay?: UiEventParams[];
  /**
   * The turn currently in flight, rebuilt from what the host has recorded so
   * far: the user's prompt plus every reasoning block, tool chip, plan and
   * completed message the run has produced.
   *
   * `replay` alone was not enough to reattach honestly. The buffer is bounded,
   * so a long run's earliest events are gone by the time a tab reloads — and
   * the user's own prompt was never in it at all, because the turn is only
   * written to history once it finishes. A tab that reloaded mid-run came back
   * to a transcript that started in the middle of the agent's work. This is
   * the same durable record `persistTurn` will write, handed over early, so a
   * reload mid-run and a reload after it look the same.
   */
  pending?: UiMessage[];
}

export interface UiSendMessageParams {
  text: string;
  /** Client-supplied so the browser can correlate before the reply lands. */
  runId?: string;
  /**
   * Pasted or dropped images, as `data:` URLs — the shape providers want
   * (`providers/types.ts:15`), so nothing has to re-encode on the way through.
   *
   * A browser can do this and a terminal cannot, which is the whole reason it
   * is here. Bounded host-side (`MAX_IMAGES`, `MAX_IMAGE_BYTES`) rather than
   * trusted from the page: the browser is untrusted, and an unbounded array of
   * base64 is a cheap way to make the host allocate.
   */
  images?: string[];
}

export interface UiSendMessageResult {
  runId: string;
  outcome: AgentOutcome;
  /**
   * The step ceiling this run was given. Sent with every result, not just a
   * cut-off one, so the browser can name the limit that ended a run without
   * having to read the config itself — the number is a host-side decision
   * (config, then core's default) that the page has no other view of.
   */
  maxIterations: number;
}

export interface UiCancelParams {
  runId: string;
}

/**
 * A message as the UI renders it. Narrower than core's `StoredMessage`: the
 * browser needs what to draw, not what the model saw. `content` here is the
 * *display* text — the template-expanded version with context blocks stays
 * host-side, because showing a user their own prompt wrapped in 3,000 lines of
 * injected repo map is not what they asked to see.
 */
export interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Transcript entries that are neither prose nor sent back as context. */
  ui?: {
    tool?: {
      id?: string;
      name: string;
      description: string;
      /** Clipped call arguments — the web chip renders its one-liner from these. */
      args?: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      /** False only in `pending`: the call is still running as this is sent. */
      done?: boolean;
    };
    plan?: boolean;
    /**
     * The agent's task list — one entry per run, holding the latest
     * todo_write state (the web-host updates it in place, never appends).
     */
    todos?: TodoItem[];
    /** A collapsed "thinking" block — the model's reasoning, kept for reloads. */
    reasoning?: boolean;
    /** True only in `pending`: this entry is still being streamed into. */
    streaming?: boolean;
  };
}

export interface UiConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  active: boolean;
}

export interface UiOpenConversationParams {
  id: string;
}

export interface UiOpenConversationResult {
  id: string;
  messages: UiMessage[];
}

export interface UiListModelsParams {
  /**
   * Whose endpoint to list. Defaults to the session's active profile — the
   * composer's picker wants that one; the role editor wants whichever profile
   * the role is pointed at.
   */
  profileName?: string;
}

export interface UiListModelsResult {
  models: Array<{ id: string; contextLength?: number }>;
}

/**
 * "Does this endpoint answer, and what does it serve?" — for a profile the user
 * is still typing, which `listModels` cannot reach because it resolves a
 * *saved* profile by name.
 */
export interface UiProbeProviderParams {
  preset: string;
  baseUrl: string;
  /** Omit to fall back to the stored key named by `useStoredKeyFor`. */
  apiKey?: string;
  /** Existing profile whose saved key to use when the user did not retype it. */
  useStoredKeyFor?: string;
}

export interface UiProbeProviderResult {
  ok: boolean;
  models: string[];
  /** Why it failed, phrased for the user. Absent when `ok`. */
  error?: string;
}

export interface UiSetModelParams {
  model: string;
}

export interface UiSetModeParams {
  mode: string;
}

// ---------------------------------------------------------------------------
// workspace switching
// ---------------------------------------------------------------------------

/** A folder opened before, for the picker's "Recent" list. */
export interface UiRecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

export interface UiWorkspacesResult {
  /** The folder this session is pointed at right now. */
  current: string;
  recent: UiRecentWorkspace[];
  /** Where "Browse" starts when nothing else is known. */
  home: string;
}

export interface UiBrowseFoldersParams {
  /** Absolute, `~`-prefixed, or omitted for the home directory. */
  path?: string;
}

/** A sub-directory of the folder being browsed. Never a file — see `listFolders`. */
export interface UiFolderEntry {
  name: string;
  path: string;
}

export interface UiBrowseFoldersResult {
  /** The directory actually listed, resolved to an absolute path. */
  path: string;
  /** Its parent, absent at the filesystem root so "up" can be hidden. */
  parent?: string;
  entries: UiFolderEntry[];
}

export interface UiSetWorkspaceParams {
  path: string;
}

// ---------------------------------------------------------------------------
// the index
// ---------------------------------------------------------------------------

/**
 * What the agent has actually indexed about this workspace.
 *
 * Two indexes, deliberately reported side by side because they answer
 * different questions and fail independently: the *semantic* index (embedded
 * chunks, what `semantic_search` queries) needs a reachable embeddings model
 * and can be empty while everything else works, whereas the *repo map* (files
 * parsed to symbols and import edges) is local tree-sitter work that needs no
 * provider at all. "Search found nothing" has a very different cause depending
 * on which of the two is empty.
 */
export interface UiIndexStatus {
  semantic: {
    state: string;
    files: number;
    chunks: number;
    /** False when the daemon cannot read this workspace itself; RAG is then off. */
    available: boolean;
  };
  repoMap: {
    /** Built at least once — `format()` returns nothing before that. */
    ready: boolean;
    files: number;
    symbols: number;
    /** Resolved intra-repo import edges: the "links" between files. */
    links: number;
  };
  /** Set while a rebuild is running, so the UI can show a bar rather than a spinner. */
  progress?: { embedded: number; total: number };
}

export interface UiReindexParams {
  /** Empty both indexes instead of building them. */
  clear?: boolean;
}

export interface UiRepoMapParams {
  /** Case-insensitive; matches a path or a symbol name. */
  query?: string;
  /** How many files to return. The map is thousands of entries on a real repo. */
  limit?: number;
}

export interface UiRepoMapSymbol {
  name: string;
  /** Tree-sitter node type, or "line" for the regex fallback. */
  kind: string;
  line: number;
}

export interface UiRepoMapFile {
  path: string;
  symbols: UiRepoMapSymbol[];
  /** Workspace-relative paths this file imports — only edges inside the repo. */
  imports: string[];
  /** Files that import this one. Computed host-side; the map stores only one direction. */
  importedBy: string[];
}

export interface UiRepoMapResult {
  /** In the same import-graph centrality order the agent's own map uses. */
  files: UiRepoMapFile[];
  /** Matching files before `limit` was applied. */
  total: number;
}

// ---------------------------------------------------------------------------
// context breakdown
// ---------------------------------------------------------------------------

/** One claim on the context window. `free` is what is left, not a consumer. */
export interface UiContextSlice {
  key: 'system' | 'tools' | 'instructions' | 'conversation' | 'free';
  label: string;
  tokens: number;
  /** Why this slice is the size it is, in one sentence. */
  note?: string;
}

/**
 * What the next turn would actually send, priced out.
 *
 * Computed rather than measured: the host rebuilds the same system prompt,
 * tool list and preamble the next `agent/run` would carry and estimates each,
 * so the numbers move when you change persona, toggle sub-agents or switch
 * profile — which is the whole reason to look at this screen.
 *
 * Estimates, and labelled as such in the UI. Heap Code is model-agnostic and
 * carries no tokenizer (core's `estimateTokens` is ~4 chars/token), so these
 * are directionally right and never exact. Presenting them as precise would be
 * the lie; presenting nothing is what the meter did before.
 */
export interface UiContextResult {
  window: number;
  slices: UiContextSlice[];
  /** Fraction of the window at which the loop starts compacting. */
  compactionThreshold: number;
  /**
   * What the window size was read from, for the "is this number right"
   * question. `model` means the endpoint told us; `preset` means it did not
   * and this is a default for a family of endpoints, which is exactly when
   * the number is worth doubting.
   */
  windowSource: ContextWindowSource;
}

/**
 * Switching workspace replaces the whole session, so the browser is handed a
 * fresh view rather than being left to reconcile: the new state, and the new
 * (empty) conversation. A conversation belongs to the folder it happened in.
 */
export interface UiSetWorkspaceResult {
  state: UiState;
  messages: UiMessage[];
}

// ---------------------------------------------------------------------------
// host → browser
// ---------------------------------------------------------------------------

/**
 * A snapshot of everything the header and settings render. Names and flags
 * only — **never key material** (§6.1). `hasKey` is the most the browser is
 * told about a secret.
 */
export interface UiState {
  root: string;
  workspaceName: string;
  profile: string;
  model: string;
  persona: string;
  permissionMode: string;
  /** Effective context window of the active profile, for the header meter. */
  contextWindow?: number;
  profiles: Array<{ name: string; model: string; hasKey: boolean }>;
  daemon: 'up' | 'down';
  runId?: string;
  /**
   * The host is bound to a non-loopback address, so this page is reachable from
   * the network and anyone holding the token can run commands on that machine.
   * The terminal prints the same warning, but only whoever launched it sees
   * that — and LAN mode exists precisely so other devices open this page (§6.1).
   */
  lan?: boolean;
}

export interface UiEventParams {
  runId: string;
  /** Forwarded verbatim from `agent/event` — see WEB_APP_PLAN §5.3. */
  event: AgentEvent;
}

/**
 * `ui/permissionRequest` — host→browser **request**. The browser renders a
 * card and the user's click is the reply. No timeout: a user may take minutes,
 * exactly as the daemon's own `tool/execute` has none (protocol.ts:449-456).
 *
 * Carries `description` rather than a tool name plus args, because that is
 * genuinely all core's `PermissionRequest` provides
 * (packages/core/src/agent/permissions.ts:5-9) — and `description` is
 * `executor.describe(call)`, the same string the CLI puts in its prompt
 * ("Write 2 lines to greeting.txt"). Faking the richer shape would mean
 * correlating the engine's requester callback back to the originating call
 * through a side channel, which races as soon as sub-agents put two tool
 * calls in flight at once. If the UI later needs structured args, the honest
 * fix is to widen `PermissionRequest` in core so every host benefits — see
 * WEB_APP_PLAN §12 Q9.
 */
export interface UiPermissionRequestParams {
  runId: string;
  /** The host's rendering of what this call does — `executor.describe(call)`. */
  description: string;
  permission: PermissionClass;
  /** Whether an "always allow" choice is meaningful here. */
  allowPersist: boolean;
}

export interface UiPermissionRequestResult {
  /** Core's `PermissionChoice` verbatim, so no translation table can drift. */
  choice: PermissionChoice;
}

/** `ui/askUser` — host→browser request, backing the `ask_user` tool. */
export interface UiAskUserParams {
  runId: string;
  callId: string;
  question: string;
  options?: string[];
  /** The model marked this as gating an action, so it must not be auto-answered. */
  blocksAction?: boolean;
}

export interface UiAskUserResult {
  answer: string;
}

export type UiStateChangedParams = Partial<UiState>;

// ---------------------------------------------------------------------------
// settings (W5)
// ---------------------------------------------------------------------------

/**
 * A provider profile as the browser may see it.
 *
 * The API key is represented by `hasKey` and nothing else. Keys travel *up*
 * (the browser can set one) and never back down — the same write-only custody
 * rule the settings form depends on (§6.1).
 */
/**
 * The non-chat model roles, in the order the editor lists them.
 *
 * A profile can point each role at its own model, and (via `<role>Profile`) at
 * another profile's provider entirely — embeddings on a local Ollama while the
 * agent stays on a cloud endpoint, say. `label`/`hint` are here rather than in
 * the browser so the three hosts describe the same field the same way.
 */
export const UI_MODEL_ROLES = [
  { key: 'agent', group: 'Core', label: 'Agent', hint: 'inherits the chat model' },
  { key: 'apply', group: 'Core', label: 'Apply', hint: 'fast-apply merge, when an edit’s search text does not match' },
  { key: 'edit', group: 'Core', label: 'Edit', hint: 'inherits the chat model' },
  { key: 'completion', group: 'Core', label: 'Autocomplete', hint: 'editor ghost text — used by the extension, not here' },
  { key: 'embeddings', group: 'Retrieval', label: 'Embeddings', hint: 'semantic search and the repo index' },
  { key: 'rerank', group: 'Retrieval', label: 'Rerank', hint: 'inherits edit → chat' },
  { key: 'context', group: 'Retrieval', label: 'Context', hint: 'per-chunk blurbs at index time; inherits rerank → edit → chat' },
] as const;

export type UiModelRole = (typeof UI_MODEL_ROLES)[number]['key'];

/** `{ agentModel, agentProfile, … }` — the shape both directions carry roles in. */
export type UiRoleFields = Partial<Record<`${UiModelRole}Model` | `${UiModelRole}Profile`, string>>;

/**
 * How much of the agent prompt a profile's model gets.
 *
 * Unset means 'full', which is also what most people should leave it on.
 * 'lean' is for a model that follows short instructions better; 'auto' asks
 * for the choice to be made from the model's context window and protocol.
 */
export type UiPromptDetail = 'full' | 'lean' | 'auto';

export interface UiProfile extends UiRoleFields {
  name: string;
  preset: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  hasKey: boolean;
  active: boolean;
  /** Effective value, after `resolveCapabilities` — not the raw stored flag. */
  nativeToolCalls: boolean;
  /** Raw stored override, absent when the profile inherits the preset's. */
  contextWindow?: number;
  /** What the run actually uses, after preset/default fallback — the meter's denominator. */
  effectiveContextWindow: number;
  /** Output cap per reply. Absent means the provider's own default. */
  maxTokens?: number;
  /** Unset = 'full'. */
  promptTier?: UiPromptDetail;
}

export interface UiMcpServer {
  name: string;
  connected: boolean;
  /** Tools this server contributed, once connected. */
  tools: string[];
  /**
   * How it is configured, in the one-line form the editor accepts back — a
   * URL, or a command with its arguments.
   */
  spec?: string;
  /**
   * Defined in this project's `.heapcode/mcp.json` rather than in personal
   * config. Editable by hand only: that file is meant to be committed, and a
   * settings panel should not write to something under version control on
   * someone's behalf.
   */
  project?: boolean;
}

/** `ui/saveMcpServer` — add or replace a personal MCP server. */
export interface UiSaveMcpServerParams {
  name: string;
  /** A URL, or a command line. Parsed the same way the CLI parses it. */
  spec: string;
}

/** A provider preset as the settings UI needs it — core's, minus capabilities. */
export interface UiPreset {
  id: string;
  label: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  local: boolean;
  apiKeyUrl?: string;
}

export interface UiSettings {
  personas: Array<{ id: string; label: string; description: string }>;
  persona: string;
  permissionMode: string;
  subAgents: boolean;
  nativeToolCalls: boolean;
  profiles: UiProfile[];
  /**
   * Sent from the host rather than restated in the UI: the browser bundle's own
   * copy of this list silently went stale (it is also what makes "pick a
   * provider" fill in the endpoint instead of leaving the user to know it).
   */
  presets: UiPreset[];
  webSearch: {
    providers: string[];
    provider?: string;
    enabled: boolean;
    hasKey: boolean;
  };
  mcpServers: UiMcpServer[];
  /** Saved "always allow" grant keys for this project. */
  permissionGrants: string[];
}

export interface UiSetPersonaParams {
  persona: string;
}
export interface UiToggleParams {
  enabled: boolean;
}

export interface UiSetWebSearchParams {
  provider?: string;
  enabled?: boolean;
  /** Write-only: stored in secrets, never returned. */
  apiKey?: string;
}

export interface UiSaveProfileParams {
  /**
   * Patched onto the stored profile by name, not swapped for it: the browser
   * only ever sees a handful of a profile's fields, so a wholesale replace
   * would silently drop `temperature`, `headers`, `capabilities` and the rest.
   * `null` clears a field back to its inherited default.
   */
  profile: UiRoleFields & {
    name: string;
    preset?: string;
    baseUrl?: string;
    model?: string;
    contextWindow?: number | null;
    maxTokens?: number | null;
    temperature?: number | null;
    /** `null` clears the setting, which means 'full'. */
    promptTier?: UiPromptDetail | null;
  };
  /** Write-only. Omitted leaves any existing key untouched. */
  apiKey?: string;
}

export interface UiNameParams {
  name: string;
}

export interface UiResetPermissionsResult {
  cleared: number;
}

/**
 * `ui/runCommand` — slash commands that are really agent tasks (`/init`).
 *
 * Kept separate from `ui/sendMessage` so the transcript can label them as
 * commands rather than as something the user typed at the model, and so the
 * host owns the canned prompt rather than the browser inventing one.
 */
export interface UiRunCommandParams {
  command: string;
  /** Client-supplied so Stop can name the run it started. */
  runId?: string;
}

// ---------------------------------------------------------------------------
// workspace panel (W6)
// ---------------------------------------------------------------------------

export interface UiChangedFile {
  path: string;
  added: number;
  removed: number;
  /** Currently showing pre-agent content — the user reverted it. */
  reverted: boolean;
  /** The file did not exist before this session. */
  created: boolean;
  /** The agent deleted it. */
  deleted: boolean;
}

export interface UiChangesResult {
  files: UiChangedFile[];
}

export interface UiDiffParams {
  path: string;
}

export interface UiDiffResult {
  path: string;
  /** Unified diff text. Empty when the file is unchanged. */
  diff: string;
  added: number;
  removed: number;
  /** Set when the content is not text we can diff (binary, or too large). */
  note?: string;
}

export interface UiFileTreeParams {
  /** Directory relative to the workspace root; omitted or '' means the root. */
  path?: string;
}

export interface UiTreeEntry {
  name: string;
  path: string;
  directory: boolean;
}

export interface UiFileTreeResult {
  path: string;
  entries: UiTreeEntry[];
}

export interface UiReadFileParams {
  path: string;
}

export interface UiReadFileResult {
  path: string;
  content: string;
  /** Set instead of content when the file is binary or over the size cap. */
  note?: string;
}

export interface UiCheckpoint {
  hash: string;
  label: string;
  date: number;
}

export interface UiCheckpointsResult {
  checkpoints: UiCheckpoint[];
}

export interface UiRewindParams {
  hash: string;
}

export interface UiRestoreResult {
  /** Paths the restore touched. */
  files: string[];
}

export interface UiSearchParams {
  query: string;
}

export interface UiSearchResult {
  /** 'semantic' when the index answered, 'text' when it fell back. */
  kind: 'semantic' | 'text';
  results: string;
}

export interface UiMemoryResult {
  /** The instructions + memory the agent actually sees; empty when none. */
  instructions: string;
}

export interface UiSkillsResult {
  skills: string;
}

// ---------------------------------------------------------------------------
// PR review (W8)
// ---------------------------------------------------------------------------

/**
 * `ui/review` — run a PR review on the current branch.
 *
 * Deliberately not folded into `ui/runCommand`. A review is not an agent task:
 * it has its own loop, its own termination policy and — the part that matters
 * here — a confirmation gate before it posts publicly to GitHub. Giving it its
 * own method keeps that gate a first-class thing the browser must answer,
 * rather than something buried in a transcript.
 */
export interface UiReviewParams {
  /** The verification pass — roughly double the wall time and model cost. */
  deep?: boolean;
  /** Client-supplied so Stop can name the run it started. */
  runId?: string;
}

export interface UiReviewResult {
  /** Core's `PrReviewResult.status`, verbatim. */
  status: 'posted' | 'cancelled' | 'skipped';
  /** Set only when posted, for an "open the PR" link. */
  pr?: { number: number; url: string };
}

/** `ui/reviewEvent` — progress and warnings while a review runs. */
export interface UiReviewEventParams {
  runId: string;
  /** `log` is dropped host-side; only what a user should read gets here. */
  kind: 'warn' | 'error' | 'progress';
  message: string;
}

/**
 * `ui/reviewConfirm` — host→browser **request**, and the only thing standing
 * between the model's output and a public comment on someone's PR.
 *
 * No timeout: the user is reading a full review preview and may take minutes,
 * exactly as `ui/permissionRequest` has none. Every failure path — a closed
 * tab, a cancelled run, a dropped socket — resolves to "not posted", because
 * the rejection direction is the safe one.
 */
export interface UiReviewConfirmParams {
  runId: string;
  pr: { number: number; url: string; title?: string };
  /** The full markdown the user must be shown before deciding. */
  preview: string;
  findingCount: number;
  inlineCount: number;
  /** The model produced no structured output; this posts as one plain comment. */
  plainText: boolean;
}

export interface UiReviewConfirmResult {
  ok: boolean;
}

// ---------------------------------------------------------------------------
// artifacts (W7)
// ---------------------------------------------------------------------------

export interface UiArtifactMeta {
  id: string;
  title: string;
  kind: string;
  language?: string;
  versions: number;
  updatedAt: number;
}

export interface UiArtifactsResult {
  artifacts: UiArtifactMeta[];
}

export interface UiArtifactParams {
  id: string;
  /** 1-based; omitted means the latest. */
  version?: number;
}

export interface UiArtifactResult extends UiArtifactMeta {
  version: number;
  content: string;
}

export interface UiSaveArtifactParams {
  id: string;
  /** Workspace-relative destination. Root-jailed like every other write. */
  path: string;
  version?: number;
}

export interface UiSaveArtifactResult {
  path: string;
}
