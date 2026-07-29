import type { AgentOutcome } from '../agent/loop.js';
import type { IndexState } from '../rag/indexer.js';
import type { HitMeta } from '../rag/keywordIndex.js';
import type { ChatMessage, ModelInfo } from '../providers/types.js';
import type { PermissionClass, ToolCall, ToolDefinition, ToolResult } from '../agent/tools.js';
import type { AgentPersona } from '../agent/personas.js';
import type { ProviderProfileConfig } from '../config/profiles.js';
import type { PrReviewConfirmation, PrReviewResult } from '../review/prReview.js';
import type { ReviewClient } from '../review/prReviewFormat.js';

/**
 * The wire protocol between a host (cli, vscode) and the core server.
 *
 * Framing is newline-delimited JSON; message semantics are JSON-RPC 2.0.
 * See docs/phase3-protocol-design.md §1 for why NDJSON over length-prefixed
 * framing, and §1's correction for why this is bidirectional: the server
 * issues `id`-bearing requests back to the host (tool execution, permission
 * prompts, key lookups), not only notifications.
 */

/** Bumped on any breaking change; it appears in the socket address, so mismatched peers never meet. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// JSON-RPC envelopes
// ---------------------------------------------------------------------------

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: '2.0';
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: RpcId;
  result?: unknown;
  error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export function isRequest(m: RpcMessage): m is RpcRequest {
  return 'method' in m && 'id' in m;
}

export function isNotification(m: RpcMessage): m is RpcNotification {
  return 'method' in m && !('id' in m);
}

export function isResponse(m: RpcMessage): m is RpcResponse {
  return !('method' in m) && 'id' in m;
}

/** Standard JSON-RPC codes plus the ones this protocol adds. */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Failed `session/hello` — see docs/phase3-protocol-design.md §3. */
  unauthorized: -32001,
  /** The request was cancelled via `$/cancelRequest`. */
  cancelled: -32800,
} as const;

/** LSP's convention, reused: cancel an in-flight request by id, in either direction. */
export const CANCEL_METHOD = '$/cancelRequest';

export interface CancelParams {
  id: RpcId;
}

// ---------------------------------------------------------------------------
// host → server
// ---------------------------------------------------------------------------

/**
 * First message on every connection. Carries the per-launch token from the
 * server's 0600 token file (§3) plus everything the session needs that the
 * server must not read for itself: profiles and key material (§2, custody
 * note's Option A2).
 */
export interface HelloParams {
  token: string;
  protocolVersion: number;
  /** Identifies the host for logs only — never used for authorization. */
  client: { name: string; version?: string };
  /** Workspace root this session operates on. */
  root: string;
  /** Profile configuration, pushed rather than read — the server has no business reading either host's config (§2). */
  profiles: ProviderProfileConfig[];
  /** Which profile this session's runs use unless a call names another. */
  activeProfile: string;
  /**
   * Key material for profiles this session expects to use, `profileName` →
   * API key. Held in memory for the session's lifetime and never persisted.
   * Profiles absent here are resolved lazily via `key/request` (§2).
   */
  keys?: Record<string, string>;
  /**
   * Whether `root` is a real local directory the server may read for itself.
   * The server reads the workspace directly for indexing (design note §3.2
   * option (a), decision 3) rather than pulling 3,000 files back over
   * `tool/execute`, and that is only sound when the root is a real path. A VS
   * Code virtual or remote-scheme workspace sets this false and gets no RAG,
   * the same way ShadowGit already declines a non-file workspace
   * (packages/vscode/src/extension.ts:85). Defaults to true.
   */
  localRoot?: boolean;
}

export interface HelloResult {
  protocolVersion: number;
  serverVersion: string;
  sessionId: string;
}

/** `agent/run` — AgentOptions minus what can't cross a process boundary (§4). */
export interface AgentRunParams {
  /** Replaces `provider`: the server resolves the profile to a Provider itself. */
  profileName?: string;
  model: string;
  task: string;
  history?: ChatMessage[];
  images?: string[];
  workspaceName: string;
  tools: ToolDefinition[];
  nativeToolCalls: boolean;
  contextWindow?: number;
  plan?: boolean;
  planOnly?: boolean;
  resumePlan?: string;
  proposeMemoryNote?: boolean;
  requireVerificationBeforeFinish?: boolean;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /**
   * Sub-agent delegation. Absent/false → `delegate_task` returns the
   * "disabled" error instead of running, matching the host-side behavior it
   * replaces (packages/cli/src/headless.ts:189-198 before this moved).
   */
  subAgents?: boolean;
  /**
   * The **effective** persona, resolved host-side — not an id. Hosts derive
   * it in ways the server can't reproduce (headless's `plan` mode intersects
   * the chosen persona with Architect before the run starts), so sending the
   * resolved object keeps that policy where it belongs and still lets the
   * server apply the run_command guard and sub-agent intersection.
   */
  persona?: AgentPersona;
  /** Correlates `agent/event` notifications and `agent/cancel` to this run. */
  runId: string;
}

export interface AgentRunResult {
  outcome: AgentOutcome;
}

export interface AgentCancelParams {
  runId: string;
}

/**
 * `chat/send` — one chat-view turn, run server-side.
 *
 * A separate method from `agent/run` rather than `agent/run` with a
 * restricted toolset, because the two differ in **termination policy**, not
 * just in tools. `runAgent` requires structural termination through
 * `finish(summary)` and nudges a tool-free reply up to `MAX_NUDGES` times
 * before accepting it (`agent/loop.ts:253`, `:595-609`); a chat turn ends
 * with prose by design. Reusing `agent/run` would cost up to six model calls
 * per message and would relocate the answer into `finish`'s summary
 * argument, which streams as `kind: 'tool'` deltas rather than text.
 *
 * Everything else *is* reused: tools execute over the same `tool/execute`
 * channel, deltas and chips ride `agent/event`, cancellation is
 * `agent/cancel`, and lazily-resolved keys come from `key/request`. The new
 * surface is this one method.
 */
export interface ChatSendParams {
  profileName?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens: number;
  /**
   * Read-only tools for the ask loop; empty → a plain streamed reply. The
   * host decides the set because the answer depends on things the server
   * can't see (native-tool-call capability, whether a workspace is open).
   */
  tools?: ToolDefinition[];
  maxToolIterations?: number;
  /** Correlates `agent/event` notifications and `agent/cancel` to this turn. */
  runId: string;
}

export interface ChatSendResult {
  /** 'length' means the model hit its output cap — the host warns the user. */
  finishReason?: string;
}

/**
 * `provider/listModels` — the model list for a profile, and with it the
 * context length the endpoint reports.
 *
 * Request/response, no streaming and no host callbacks — the same shape as
 * `session/hello`. It exists because the server already holds keys and builds
 * Providers, so a host asking "what models does this profile have" should not
 * need a Provider of its own.
 *
 * Deliberately does NOT accept an inline key. A profile whose key the user has
 * just typed and not yet saved has no session behind it; that bootstrap probe
 * stays host-side (design note §4's setup caveat), which is what keeps this
 * method from becoming a way to push arbitrary key material.
 */
export interface ListModelsParams {
  /** Defaults to the session's active profile. */
  profileName?: string;
}

export interface ListModelsResult {
  models: ModelInfo[];
}

/**
 * `review/run` — one PR review, run server-side.
 *
 * Its own method rather than `agent/run`, for the same reason `chat/send` is:
 * it has its own **termination policy** and its own loop. `reviewCurrentPr`
 * runs up to MAX_BATCHES batch passes plus an optional verification pass
 * (`review/prReview.ts:463`, `:551`), each a self-contained read-only
 * tool loop that terminates structurally by calling a report tool and
 * validates the result with an `accept()` that can reject and continue
 * (`:181-257`). Routing that through `runAgent` would replace all of it.
 *
 * The loop itself was already host-agnostic in core before this — both hosts
 * were thin adapters over it — so nothing needed extracting. What moved is
 * only the Provider and the five host callbacks.
 *
 * Everything else is reused: read-only tools execute over `tool/execute`,
 * cancellation is `agent/cancel`, and a redirect profile's key comes from
 * `key/request`.
 */
export interface ReviewRunParams {
  profileName?: string;
  /** The agent model, resolved host-side (`agentModel || model`), as `agent/run` does. */
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Sizes the per-batch diff budget. Host-resolved, like `agent/run`'s. */
  contextWindow: number;
  /** The host's full tool list; the review offers only the read-only ones. */
  tools: ToolDefinition[];
  /** Attribution and the deep-mode hint, which name the host by definition. */
  client: ReviewClient;
  /** The verification pass — roughly double the wall time and model cost. */
  deep?: boolean;
  /** Correlates `review/event` and `review/confirm`, and lets `agent/cancel` stop the run. */
  runId: string;
}

export type ReviewRunResult = PrReviewResult;

/**
 * `review/event` — the review's non-blocking host callbacks, as notifications.
 * `warn`/`error` are user-facing, `progress` drives a spinner, and `log` is a
 * diagnostic line one host writes to an output channel and the other drops.
 */
export type ReviewEvent =
  | { kind: 'warn'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'log'; message: string }
  | { kind: 'progress'; message: string };

export interface ReviewEventParams {
  runId: string;
  event: ReviewEvent;
}

/**
 * `review/confirm` — a server→host **request**, and the one gate before
 * anything is posted publicly to GitHub.
 *
 * Deliberately has no server-side timeout, for the same reason `tool/execute`
 * has none: the user is reading a full review preview and may take minutes.
 * The failure direction is the safe one — if this rejects for any reason
 * (cancellation, a dropped socket), the review is not posted.
 */
export interface ReviewConfirmParams {
  runId: string;
  confirmation: PrReviewConfirmation;
}

export interface ReviewConfirmResult {
  ok: boolean;
}

/**
 * `git/commitMessage` — one commit message from one diff.
 *
 * Request/response with no callbacks and no streaming, the shape
 * `provider/listModels` has. It is genuinely a single model call: no tools, no
 * loop, no retry, and no follow-up question — the only feature on the
 * not-yet-migrated list that turned out to be as simple as it looked.
 *
 * The diff is collected host-side and sent whole. The server has no business
 * knowing about VS Code's git extension, and "staged, else working tree" is a
 * host decision about what the user meant.
 */
export interface CommitMessageParams {
  /** Already truncated by the host to whatever it considers sendable. */
  diff: string;
  /** Defaults to the session's active profile; the `editModel` role redirect is applied server-side. */
  profileName?: string;
}

export interface CommitMessageResult {
  /** Fence- and quote-stripped, ready to drop into a commit box. Empty when the model said nothing usable. */
  message: string;
}

/**
 * `rag/query` — semantic retrieval, run server-side.
 *
 * Request/response with no callbacks, the shape `provider/listModels` has.
 * Nothing binary crosses here and nothing needed to: the vectors are produced
 * and consumed inside the server, and no consumer of RAG ever read one
 * (docs/phase3-rag-design.md §1.2). That is what made the "Float32Array is
 * JSON-hostile" problem dissolve rather than need a clever encoding — see
 * §2.3. `hits` carries HitMeta, which has no `vector` field at all.
 *
 * The two toggles are host policy, passed per request rather than read from
 * config the server has no business reading (§5.4, decision 6).
 */
export interface RagQueryParams {
  text: string;
  k?: number;
  hybridSearch?: boolean;
  rerank?: boolean;
}

export interface RagQueryResult {
  /** Exactly the block every consumer renders — the tool, @workspace, @mentions, inline edit. */
  formatted: string;
  hits: HitMeta[];
}

/**
 * `rag/index` — a full rebuild (`full: true`) or an incremental update
 * (`paths`), which is every trigger the hosts have.
 *
 * A delete and a rename need no shape of their own: indexOne drops a path it
 * cannot read, so a delete is `paths: ['gone.ts']` and a rename is
 * `paths: ['old.ts', 'new.ts']`.
 */
export interface RagIndexParams {
  full?: boolean;
  /**
   * Empty the index instead of building it — the "Clear Index" command. A flag
   * on this method rather than a fourth one, because it is the same thing:
   * mutate the index and report what is left.
   */
  clear?: boolean;
  /** Workspace-relative paths to (re)index; ones that no longer exist are dropped. */
  paths?: string[];
  contextualRetrieval?: boolean;
  /** Correlates `rag/event` progress and lets `agent/cancel` stop a long build. */
  runId?: string;
}

export interface RagIndexResult {
  files: number;
  chunks: number;
  /** Files that actually re-embedded. 0 on an incremental no-op. */
  embedded: number;
  /**
   * True when this build started from nothing. The extension's index used to
   * live in its own workspace storage and now lives under the shared project
   * state dir, so the first build after upgrading is a full rebuild — worth
   * saying out loud rather than leaving as a mysteriously slow index
   * (§5.4, decision 5).
   */
  fresh?: boolean;
}

export interface RagStatusResult {
  state: IndexState;
  files: number;
  chunks: number;
  /**
   * False when the server cannot read this workspace for itself — a VS Code
   * virtual or remote-scheme root, where only the host can resolve paths.
   * RAG is then unavailable rather than silently indexing whatever `fsPath`
   * produced (decision 3).
   */
  available: boolean;
}

// ---------------------------------------------------------------------------
// server → host
// ---------------------------------------------------------------------------

/**
 * Agent progress. Notifications, not requests — a response per token would
 * double the message count on the hottest path for nothing (§5).
 *
 * This union began life as `HeadlessEvent` in packages/cli/src/headless.ts
 * and moved here because it is a protocol type, not a CLI type (§4). The
 * six members the CLI's version had are unchanged on the wire, so anything
 * consuming `heapcode -p --json` sees the same stream it always did.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'text_end' }
  | { type: 'plan'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; parent?: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean; parent?: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_end' }
  | { type: 'tool_stream'; chars: number }
  | { type: 'context_usage'; usedTokens: number; windowTokens: number }
  | { type: 'compaction'; beforeTokens: number; afterTokens: number }
  | { type: 'memory_candidate'; note: string };

export interface AgentEventParams {
  runId: string;
  event: AgentEvent;
}

/**
 * `tool/execute` — a server→host **request**. The host runs the tool with
 * its own executor (the extension's is irreducibly host-side: terminals,
 * shell integration, language-server diagnostics) and returns the result.
 *
 * Deliberately has no server-side timeout: `ask_user` is a tool call the
 * user may take minutes to answer. See §7 and the known-gap note in the
 * implementation report.
 */
export interface ToolExecuteParams {
  runId: string;
  call: ToolCall;
  /** Set when the call comes from a sub-agent; the id of the delegate_task call that spawned it. */
  parent?: string;
}

export type ToolExecuteResult = ToolResult;

/** `permission/request` — a server→host request; the host decides and (for the CLI) audits. */
export interface PermissionRequestParams {
  runId: string;
  call: ToolCall;
  permission: PermissionClass;
  /** The host's own rendering of what this call does, for a prompt. */
  toolName: string;
}

export interface PermissionRequestResult {
  granted: boolean;
}

/**
 * `rag/event` — indexing progress and state, as notifications.
 *
 * The status surface stays host-side and becomes a renderer: the CLI's
 * progress line and the extension's status bar both read this rather than
 * polling `rag/status` (§4).
 */
export type RagEvent =
  | { kind: 'progress'; embedded: number; total: number }
  | { kind: 'state'; state: IndexState; files: number; chunks: number };

export interface RagEventParams {
  runId?: string;
  event: RagEvent;
}

/** `snapshot/before` — a server→host request fired before non-read tools (AgentOptions.beforeToolCall). */
export interface SnapshotBeforeParams {
  runId: string;
  call: ToolCall;
}

/**
 * `key/request` — a server→host request resolving a profile's API key on
 * demand (§2, option b). Used when a sub-agent or role profile names a
 * profile whose key wasn't pushed at hello.
 */
export interface KeyRequestParams {
  profileName: string;
}

export interface KeyRequestResult {
  /** Absent → no such profile, or no key stored; the server falls back to the parent's provider. */
  apiKey?: string;
  profile?: ProviderProfileConfig;
}

export const METHODS = {
  hello: 'session/hello',
  agentRun: 'agent/run',
  agentCancel: 'agent/cancel',
  agentEvent: 'agent/event',
  chatSend: 'chat/send',
  listModels: 'provider/listModels',
  commitMessage: 'git/commitMessage',
  reviewRun: 'review/run',
  reviewEvent: 'review/event',
  reviewConfirm: 'review/confirm',
  ragQuery: 'rag/query',
  ragIndex: 'rag/index',
  ragStatus: 'rag/status',
  ragEvent: 'rag/event',
  toolExecute: 'tool/execute',
  permissionRequest: 'permission/request',
  snapshotBefore: 'snapshot/before',
  keyRequest: 'key/request',
} as const;
