import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ASK_USER_NO_ANSWER,
  BUILTIN_PERSONAS,
  COMPACTION_THRESHOLD,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PERMISSION_MODE,
  INIT_TASK,
  METHODS,
  SEARCH_PRESETS,
  WEB_SEARCH_SECRET_NAME,
  applyModeToPersona,
  askUserAnswerMessage,
  askUserBlocksAction,
  buildAgentTask,
  buildFallbackAgentSystemPrompt,
  buildNativeAgentSystemPrompt,
  estimateMessagesTokens,
  estimateTokens,
  filterToolsForPersona,
  getPersona,
  isPermissionMode,
  lineDiffStats,
  createProvider,
  providerPresets,
  resolveCapabilities,
  describeRole,
  type ModelRoleTable,
  unifiedDiff,
  type AgentEvent,
  type AgentEventParams,
  type AgentRunParams,
  type AgentRunResult,
  type Conversation,
  type KeyRequestParams,
  type KeyRequestResult,
  type PermissionMode,
  type PermissionRequestParams,
  type PermissionRequestResult,
  type ProviderProfileConfig,
  type ReviewClient,
  type ReviewConfirmParams,
  type ReviewConfirmResult,
  type ReviewEventParams,
  type ReviewRunParams,
  type ReviewRunResult,
  type RpcPeer,
  type ServerConnection,
  type SnapshotBeforeParams,
  type ModelInfo,
  type StoredMessage,
  type ToolCall,
  type ToolExecuteParams,
  type ToolResult,
} from '@heapcode/core';
import {
  DELEGATE_TASK_TOOL,
  JsonConversationStore,
  PermissionEngine,
  buildAgentSession,
  canonicalize,
  conversationsFile,
  describeMcpServer,
  listPermissionGrants,
  loadMcpServerSources,
  mcpNameProblem,
  parseMcpServerSpec,
  listSkillsFormatted,
  permissionsFile,
  projectStateDir,
  createContextWindowResolver,
  profileContextWindow,
  trimHistoryForAgent,
  type ConfigStore,
  type SecretsStore,
} from '@heapcode/host';
import {
  UI_METHODS,
  UI_MODEL_ROLES,
  UI_PROTOCOL_VERSION,
  type UiAskUserParams,
  type UiAskUserResult,
  type UiCancelParams,
  type UiConversationMeta,
  type UiEventParams,
  type UiHelloParams,
  type UiHelloResult,
  type UiListModelsParams,
  type UiProbeProviderParams,
  type UiProbeProviderResult,
  type UiListModelsResult,
  type UiMessage,
  type UiOpenConversationParams,
  type UiOpenConversationResult,
  type UiPermissionRequestParams,
  type UiPermissionRequestResult,
  type UiMcpServer,
  type UiNameParams,
  type UiSaveMcpServerParams,
  type UiResetPermissionsResult,
  type UiRunCommandParams,
  type UiSaveProfileParams,
  type UiSendMessageParams,
  type UiSendMessageResult,
  type UiSetModelParams,
  type UiSetModeParams,
  type UiSetPersonaParams,
  type UiSetWebSearchParams,
  type UiSettings,
  type UiState,
  type UiToggleParams,
  type UiChangedFile,
  type UiChangesResult,
  type UiCheckpointsResult,
  type UiDiffParams,
  type UiDiffResult,
  type UiFileTreeParams,
  type UiFileTreeResult,
  type UiMemoryResult,
  type UiReadFileParams,
  type UiReadFileResult,
  type UiRestoreResult,
  type UiReviewConfirmParams,
  type UiReviewConfirmResult,
  type UiReviewEventParams,
  type UiReviewParams,
  type UiReviewResult,
  type UiRewindParams,
  type UiSearchParams,
  type UiSearchResult,
  type UiSkillsResult,
  type UiArtifactMeta,
  type UiArtifactParams,
  type UiArtifactResult,
  type UiArtifactsResult,
  type UiSaveArtifactParams,
  type UiSaveArtifactResult,
  type UiBrowseFoldersParams,
  type UiBrowseFoldersResult,
  type UiContextResult,
  type UiContextSlice,
  type UiIndexStatus,
  type UiReindexParams,
  type UiRepoMapParams,
  type UiRepoMapResult,
  type UiConnectionModelsParams,
  type UiConnectionModelsResult,
  type UiSetRoleParams,
  type UiSetWorkspaceParams,
  type UiSetWorkspaceResult,
  type UiWorkspacesResult,
} from './protocol.js';
import { currentText, listDirectory, readWorkspaceFile } from './workspace.js';
import { listFolders, type WorkspaceStore } from './workspaces.js';
import {
  ARTIFACT_KINDS,
  ArtifactStore,
  CREATE_ARTIFACT_TOOL,
  isArtifactKind,
  type Artifact,
} from './artifacts.js';

/** Metadata only — the content is fetched per-version, so a list stays cheap. */
function toArtifactMeta(a: Artifact): UiArtifactMeta {
  return {
    id: a.id,
    title: a.title,
    kind: a.kind,
    language: a.language,
    versions: a.versions.length,
    updatedAt: a.versions.at(-1)?.createdAt ?? 0,
  };
}

/**
 * Slash commands that are really canned agent tasks.
 *
 * `INIT_TASK` comes from core, shared with the CLI and the extension, so a
 * project initialized from any of the three gets the same HEAPCODE.md.
 */
const COMMAND_TASKS: Record<string, string> = {
  '/init': INIT_TASK,
};

/** How many events to retain per run for replay after a browser refresh (§5.4). */
const REPLAY_BUFFER = 2_000;

/** Attachments per message, and the cap on each. The browser is not trusted to bound these. */
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Filter an incoming attachment list down to things that are actually images.
 *
 * Data URLs only, and only image media types. `data:text/html;base64,…` is
 * still a valid data URL, and passing one straight through to a provider —
 * or, worse, back into a page — is the kind of hole that opens because nobody
 * asked what the string was. Anything unrecognised is dropped silently rather
 * than failing the send: the message itself is still worth running.
 */
export function acceptImages(images: unknown): string[] | undefined {
  if (!Array.isArray(images)) return undefined;
  const out: string[] = [];
  for (const value of images) {
    if (typeof value !== 'string') continue;
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) continue;
    if (value.length > MAX_IMAGE_BYTES) continue;
    out.push(value);
    if (out.length >= MAX_IMAGES) break;
  }
  return out.length > 0 ? out : undefined;
}

/** How a review posted from the browser identifies itself on the PR. */
const WEB_REVIEW_CLIENT: ReviewClient = {
  attribution: 'Heap Code Web',
  deepHint: 'run "/pr-review deep"',
};

/** What the session knows and the connector needs; the rest of HelloParams is the connector's. */
export interface DaemonHello {
  root: string;
  profiles: ProviderProfileConfig[];
  activeProfile: string;
  /**
   * Which model on which connection serves each role — one global table.
   *
   * Required: every path that builds a hello must carry it. `reconnect` once
   * did not, which made changing a role the one action that left the daemon
   * with no table.
   */
  roles: ModelRoleTable;
  keys: Record<string, string>;
}

export interface WebSessionDeps {
  root: string;
  config: ConfigStore;
  secrets: SecretsStore;
  /**
   * Opens the daemon connection. Injected rather than called directly so tests
   * can point at an in-process server, and so the CLI can supply the path to
   * its own bundled `dist/daemon.js` (only a host knows where its bundle
   * landed — see ConnectOptions.daemonEntry).
   */
  connect: (hello: DaemonHello) => Promise<ServerConnection>;
  clientVersion?: string;
  permissionMode?: PermissionMode;
  personaId?: string;
  subAgents?: boolean;
  /**
   * Native tool calls vs the text protocol. Real hosts probe the endpoint;
   * until the web UI has a settings surface for it (W5) this is injected,
   * and tests use it to drive the scripted text-protocol mock.
   */
  nativeToolCalls?: boolean;
  /**
   * Project instructions (HEAPCODE.md / memory.md) prepended to each task.
   * Injected because `loadProjectInstructions` lives in the CLI's memory.ts,
   * not in the shared host package — extracting it is a W5 tidy-up, not a
   * reason to block the chat MVP.
   */
  loadInstructions?: (root: string) => Promise<string>;
  /**
   * Recently opened folders, for the workspace picker. Optional so a host
   * that does not offer switching (or a test) simply has no list — the picker
   * then shows the current folder and nothing else, which is the truth.
   */
  workspaces?: WorkspaceStore;
  /**
   * Bound to a non-loopback address. Passed down rather than inferred, because
   * the session never sees the bind address — only `startWebHost` does.
   */
  lan?: boolean;
}

/**
 * One workspace's bridge between browsers and the daemon.
 *
 * Deliberately outlives any single browser connection: the host owns run
 * state, a tab does not (§5.4). Closing the tab mid-run must not kill the
 * agent, and reopening it must reattach — so the daemon connection, the
 * executor, and the event buffer all live here, and `attach()` merely points
 * a browser at them.
 *
 * The server→host handlers below are the same bodies as headless.ts:229-283,
 * with two deliberate differences: permission decisions and `ask_user` are
 * forwarded to a human instead of being auto-resolved. That is the whole
 * behavioral difference between a headless host and an interactive one.
 */
export class WebSession {
  /**
   * The workspace this session is pointed at.
   *
   * A field rather than `deps.root` because the browser can move it
   * (`ui/setWorkspace`). Everything derived from it — conversation history,
   * permission grants, shadow-git, the semantic index, the daemon's own view
   * of the workspace — is rebuilt by `start()`, so switching is "tear down,
   * repoint, start again" rather than a set of individual updates that could
   * fall out of step with each other.
   */
  private root: string;
  private connection?: ServerConnection;
  private session?: Awaited<ReturnType<typeof buildAgentSession>>;
  private permissions?: PermissionEngine;
  private profile?: ProviderProfileConfig;

  /** The browser currently attached, if any. Null between tabs. */
  private ui?: RpcPeer;
  private mode: PermissionMode;

  private activeRunId?: string;
  private abort?: AbortController;
  /**
   * A profile edit the daemon has not been told about yet, because a run was
   * in flight when it was saved. Flushed when that run ends — see
   * `refreshDaemonProfile`.
   */
  private profileRefreshPending = false;

  /**
   * The window a model really has, asked of the endpoint through the daemon
   * and cached. This host used to size everything off the preset's number,
   * which for a hosted endpoint is a guess about a family of them.
   */
  private readonly contextWindowFor = createContextWindowResolver((profileName, model) =>
    this.connection
      ? this.connection.peer
          .request<{ models: ModelInfo[] }>(METHODS.listModels, { profileName, model })
          .then((r) => r.models)
      : Promise.resolve([]),
  );
  /** Per-run event log, for replay when a browser reattaches mid-run. */
  private readonly buffers = new Map<string, UiEventParams[]>();

  private history?: JsonConversationStore;
  private conversation?: Conversation;
  private lastText = '';
  private deltaAcc = '';
  /**
   * The current run's transcript, in the order it happened: narration, plans
   * and tool chips as well as the final reply.
   *
   * Persisting only the last assistant message — which is what this used to do
   * — meant a browser reload came back to a conversation with every tool call,
   * plan and intermediate note missing, because the live event stream was the
   * only place they ever existed.
   */
  private turnEntries: StoredMessage[] = [];
  /** Partial reasoning text, accumulated the same way `deltaAcc` accumulates prose. */
  private reasoningAcc = '';
  /**
   * What the user typed for the run in flight, held until `persistTurn` writes
   * it. A tab that reloads mid-run needs it to redraw the prompt it is watching
   * the answer to — see `UiHelloResult.pending`.
   */
  private pendingDisplay?: string;
  /** Overrides the profile's model for this session only, set by `ui/setModel`. */
  private modelOverride?: string;
  /** Live embed progress while a rebuild runs; cleared when the state settles. */
  private indexProgress?: { embedded: number; total: number };
  /**
   * The review in flight, if any. Its own field rather than a flag on
   * `activeRunId`: the daemon's `review/event` and `review/confirm` both carry
   * a runId, and answering a confirmation for a review this session did not
   * start is exactly the mistake that ends with something posted to GitHub.
   */
  private activeReview?: string;

  /**
   * Persona and sub-agents start from `deps` but are session state, not
   * config: the UI can change them mid-session, and the CLI treats them the
   * same way (they are not persisted to config.json there either).
   */
  private personaId: string;
  private subAgents: boolean;
  /** Rebuilt on a workspace switch — artifacts live under the project's state dir. */
  private artifacts: ArtifactStore;

  constructor(private readonly deps: WebSessionDeps) {
    this.root = deps.root;
    this.mode = deps.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.personaId = deps.personaId ?? 'agent';
    this.subAgents = deps.subAgents ?? false;
    // Under the project's state dir, not the workspace — see ArtifactStore.
    this.artifacts = new ArtifactStore(join(projectStateDir(deps.root), 'artifacts'));
  }

  /**
   * The model this session's runs use.
   *
   * The agent role, which inherits chat unless something was assigned to agent
   * specifically (core's config/roles.ts). Cached because it is read on every
   * turn and `agentModel` is refreshed whenever the role table changes.
   */
  private get model(): string {
    return this.modelOverride || this.agentModel || this.profile?.model || '';
  }

  /** What the agent role currently resolves to; refreshed with the role table. */
  private agentModel = '';

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Connects to the daemon and builds the agent session. Idempotent. */
  async start(): Promise<void> {
    if (this.connection) return;

    const { config, secrets, clientVersion } = this.deps;
    const root = this.root;
    const profile = await config.getActiveProfile();
    if (!profile) {
      throw new Error(
        'No provider connection configured. Run `heapcode connection add` (or start the CLI once) before `heapcode web`.',
      );
    }
    this.profile = profile;
    this.agentModel = (await config.resolve('agent'))?.model ?? profile.model;

    this.history = new JsonConversationStore(conversationsFile(root));
    // Launch default is a fresh conversation, matching `heapcode` itself; the
    // sidebar is how you get back to an earlier one.
    this.conversation ??= { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [] };

    this.session = buildAgentSession(root, config, secrets, clientVersion, (original, snippet) =>
      // Reaches for the connection at call time, not now: the session is built
      // before the daemon link exists, and a switched workspace replaces both.
      this.applyMerge(original, snippet),
    );
    this.permissions = new PermissionEngine(
      permissionsFile(root),
      () => false,
      () => {},
      undefined,
      () => this.mode,
    );
    // The browser is the only place to ask. With none attached the request
    // fails closed, exactly as the CLI's does with no prompt attached.
    this.permissions.attachRequester(async (req) => {
      if (!this.ui) return undefined;
      const result = await this.ui.request<UiPermissionRequestResult>(UI_METHODS.permissionRequest, {
        runId: this.activeRunId ?? '',
        description: req.description,
        permission: req.permission,
        allowPersist: req.allowPersist,
      } satisfies UiPermissionRequestParams);
      return result.choice;
    });

    await Promise.all([this.session.repoMapIndexer.init(), this.session.mcpManager.ensureConnected()]);

    // Key material pushed once at hello and held only in the server's memory
    // (custody note, Option A2); other profiles resolve lazily via key/request.
    const apiKey = await secrets.getApiKey(profile.name);
    this.connection = await this.deps.connect({
      root,
      profiles: [profile],
      activeProfile: profile.name,
      // The whole table, so a role pointing at another connection is resolved
      // in the daemon, which then asks for that connection through key/request.
      roles: await config.getRoles(),
      keys: apiKey ? { [profile.name]: apiKey } : {},
    });
    this.registerDaemonHandlers(this.connection.peer);
    this.forgetConnectionWhenItCloses(this.connection);
    this.warmContextWindow();
    // Recorded once the folder has actually opened, not when it was asked
    // for: a path that fails to start is not somewhere to offer going back to.
    //
    // Awaited, not fire-and-forget. `ui/workspaces` can be requested the
    // instant a switch resolves — the picker refetches on exactly that — and
    // an unawaited write lost that race, so the list came back still ordered
    // by the *previous* switch. The store swallows its own write errors, so
    // awaiting cannot fail an otherwise-good open.
    await this.deps.workspaces?.record(root);
  }

  async close(): Promise<void> {
    this.abort?.abort();
    this.connection?.close();
    this.connection = undefined;
    this.session?.mcpManager.dispose();
  }

  /**
   * Repoint this session at another folder.
   *
   * Everything a session holds is derived from the root — the daemon's own
   * view of the workspace, the tool executor's jail, permission grants,
   * shadow-git, the semantic index, conversation history, artifacts — so this
   * tears the whole lot down and lets `start()` rebuild it, rather than
   * updating each piece in place. Individually-updated state is state that can
   * fall out of step: an executor still jailed to the old root while the
   * conversation store has already moved is a worse failure than a slow
   * switch.
   *
   * Refused mid-run for the same reason `openConversation` is: the agent is
   * holding files in the old workspace, and moving the ground under it would
   * turn its next edit into an edit of the wrong repo.
   */
  async setWorkspace(root: string): Promise<void> {
    if (this.activeRunId) throw new Error('A run is in progress; cancel it before switching workspace.');
    const target = canonicalize(root);
    const info = await stat(target).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`Not a folder: ${root}`);
    if (target === this.root) return;

    this.connection?.close();
    this.connection = undefined;
    this.session?.mcpManager.dispose();
    this.session = undefined;
    this.permissions = undefined;

    this.root = target;
    // A conversation belongs to the workspace it happened in — carrying one
    // across would file this repo's turns under the other one's history.
    this.conversation = undefined;
    this.history = undefined;
    this.turnEntries = [];
    this.lastText = '';
    this.deltaAcc = '';
    this.reasoningAcc = '';
    this.buffers.clear();
    this.artifacts = new ArtifactStore(join(projectStateDir(target), 'artifacts'));

    // `start()` records the folder as recent once it actually opens.
    await this.start();
    void this.pushState();
    void this.pushWorkspace();
  }

  /** The folder this session is pointed at, canonicalized. */
  get workspaceRoot(): string {
    return this.root;
  }

  // -------------------------------------------------------------------------
  // browser side
  // -------------------------------------------------------------------------

  /** Points a browser connection at this session, replacing any previous one. */
  attach(ui: RpcPeer): void {
    this.ui = ui;

    ui.onRequest(UI_METHODS.hello, async (raw): Promise<UiHelloResult> => {
      // Connect on hello rather than at construction, so a configuration
      // error surfaces as a readable message in the UI instead of a server
      // that refused to start.
      await this.start();
      const params = (raw ?? {}) as UiHelloParams;
      const replay =
        params.resumeRunId && this.buffers.has(params.resumeRunId)
          ? this.buffers.get(params.resumeRunId)
          : this.activeRunId
            ? this.buffers.get(this.activeRunId)
            : undefined;
      return {
        protocolVersion: UI_PROTOCOL_VERSION,
        state: await this.state(),
        messages: toUiMessages(this.conversation?.messages ?? []),
        activeRunId: this.activeRunId,
        replay,
        pending: this.activeRunId ? this.pendingTurn() : undefined,
      };
    });

    ui.onRequest(UI_METHODS.state, async () => this.state());

    ui.onRequest(UI_METHODS.sendMessage, async (raw): Promise<UiSendMessageResult> => {
      const { text, runId, images } = raw as UiSendMessageParams;
      return this.run(text, runId ?? randomUUID(), acceptImages(images));
    });

    ui.onRequest(UI_METHODS.cancel, async (raw) => {
      const { runId } = raw as UiCancelParams;
      await this.cancel(runId);
      return null;
    });

    ui.onRequest(UI_METHODS.conversations, async (): Promise<UiConversationMeta[]> => {
      await this.start();
      const list = await this.history!.list();
      return list.map((c) => ({ ...c, active: c.id === this.conversation?.id }));
    });

    ui.onRequest(UI_METHODS.openConversation, async (raw): Promise<UiOpenConversationResult> => {
      await this.start();
      const { id } = raw as UiOpenConversationParams;
      if (this.activeRunId) throw new Error('A run is in progress; cancel it before switching conversations.');
      const found = await this.history!.get(id);
      if (!found) throw new Error(`No conversation ${id}`);
      this.conversation = found;
      void this.pushState();
      return { id: found.id, messages: toUiMessages(found.messages) };
    });

    ui.onRequest(UI_METHODS.newConversation, async (): Promise<UiOpenConversationResult> => {
      await this.start();
      if (this.activeRunId) throw new Error('A run is in progress; cancel it before starting a new chat.');
      this.conversation = { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [] };
      void this.pushState();
      return { id: this.conversation.id, messages: [] };
    });

    ui.onRequest(UI_METHODS.listModels, async (raw): Promise<UiListModelsResult> => {
      await this.start();
      const { profileName } = (raw ?? {}) as UiListModelsParams;
      const res = await this.connection!.peer.request<{ models: Array<{ id: string; contextLength?: number }> }>(
        METHODS.listModels,
        // The daemon resolves an unknown name through `key/request`, which this
        // host answers from its own config and secrets — so any configured
        // profile can be listed, not just the one the session is running on.
        { profileName },
      );
      return { models: res.models };
    });

    ui.onRequest(UI_METHODS.probeProvider, async (raw): Promise<UiProbeProviderResult> => {
      const { preset, baseUrl, apiKey, useStoredKeyFor } = (raw ?? {}) as UiProbeProviderParams;
      if (!baseUrl?.trim()) return { ok: false, models: [], error: 'Enter a base URL first.' };
      // Deliberately not routed through the daemon: it resolves saved profiles
      // by name, and the whole point here is a profile that does not exist yet.
      const known = providerPresets.find((p) => p.id === preset);
      const key = apiKey || (useStoredKeyFor ? await this.deps.secrets.getApiKey(useStoredKeyFor) : undefined);
      try {
        const provider = createProvider(
          { name: 'probe', preset: (known?.id ?? 'custom') as ProviderProfileConfig['preset'], baseUrl, model: '' },
          key,
        );
        const models = await provider.listModels();
        if (models.length === 0) {
          // Reached it, but it lists nothing — a real setup (some proxies serve
          // models they refuse to enumerate), so this is not an error.
          return { ok: true, models: [], error: 'Connected, but the endpoint lists no models — type the id yourself.' };
        }
        return { ok: true, models: models.map((m) => m.id) };
      } catch (err) {
        return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
      }
    });

    ui.onRequest(UI_METHODS.setModel, async (raw) => {
      const { model } = raw as UiSetModelParams;
      this.modelOverride = model;
      void this.pushState();
      return null;
    });

    ui.onRequest(UI_METHODS.setMode, async (raw) => {
      const { mode } = raw as UiSetModeParams;
      if (!isPermissionMode(mode)) throw new Error(`Unknown permission mode: ${mode}`);
      this.mode = mode;
      void this.pushState();
      return null;
    });

    this.attachWorkspaceSwitching(ui);
    this.attachSettings(ui);
    this.attachWorkspace(ui);
  }

  /** The folder picker: which folders exist, and which one this session uses. */
  private attachWorkspaceSwitching(ui: RpcPeer): void {
    ui.onRequest(UI_METHODS.workspaces, async (): Promise<UiWorkspacesResult> => {
      const recent = (await this.deps.workspaces?.list()) ?? [];
      return {
        current: this.root,
        // The current folder is always offered, even on a first run where
        // nothing has been recorded yet — a picker whose list excludes where
        // you already are reads as broken.
        recent: recent.some((r) => r.path === this.root)
          ? recent
          : [{ path: this.root, name: basename(this.root) || this.root, lastOpened: Date.now() }, ...recent],
        home: homedir(),
      };
    });

    ui.onRequest(UI_METHODS.browseFolders, async (raw): Promise<UiBrowseFoldersResult> => {
      const { path } = (raw ?? {}) as UiBrowseFoldersParams;
      return listFolders(path);
    });

    ui.onRequest(UI_METHODS.setWorkspace, async (raw): Promise<UiSetWorkspaceResult> => {
      const { path } = raw as UiSetWorkspaceParams;
      await this.setWorkspace(path);
      return { state: await this.state(), messages: toUiMessages(this.conversation?.messages ?? []) };
    });

    ui.onRequest(UI_METHODS.context, async (): Promise<UiContextResult> => {
      await this.start();
      return this.contextBreakdown();
    });
  }

  /**
   * Price out the next turn's prompt, slice by slice.
   *
   * Rebuilds exactly what `run()` would send rather than reporting the last
   * turn's `context_usage`, because the useful question here is "what is
   * filling my window, and what can I do about it" — and the answer changes
   * with persona, sub-agents, MCP servers and profile, none of which the
   * post-hoc number reflects until you have already spent a turn finding out.
   */
  private async contextBreakdown(): Promise<UiContextResult> {
    const session = this.session!;
    const profile = this.profile!;
    const workspaceName = basename(this.root);
    const persona = applyModeToPersona(getPersona(this.personaId), this.mode);
    const tools = filterToolsForPersona(
      [...session.tools, DELEGATE_TASK_TOOL, CREATE_ARTIFACT_TOOL, ...session.mcpManager.getToolDefinitions()],
      persona,
    );
    const nativeToolCalls = this.deps.nativeToolCalls ?? resolveCapabilities(profile).nativeToolCalls;

    // Where the tool schemas land depends on the protocol: native calling
    // sends them as a separate `tools` array, the text protocol embeds them in
    // the system prompt. Building the fallback prompt twice — once with the
    // real tools and once with none — separates the two exactly, instead of
    // either double-counting them or hiding them inside "system".
    // The same number the run will be given, so the breakdown prices the
    // prompt the model actually gets — the budget section is part of it now.
    const maxIterations = (await this.deps.config.load()).maxIterations ?? DEFAULT_MAX_ITERATIONS;
    let systemTokens: number;
    let toolTokens: number;
    if (nativeToolCalls) {
      systemTokens = estimateTokens(buildNativeAgentSystemPrompt(workspaceName, { maxIterations }));
      toolTokens = estimateTokens(JSON.stringify(tools));
    } else {
      const withTools = estimateTokens(buildFallbackAgentSystemPrompt(workspaceName, tools, { maxIterations }));
      systemTokens = estimateTokens(buildFallbackAgentSystemPrompt(workspaceName, [], { maxIterations }));
      toolTokens = Math.max(0, withTools - systemTokens);
    }

    const instructions = (await this.deps.loadInstructions?.(this.root).catch(() => '')) ?? '';
    const preamble = [persona.taskAddendum, instructions].filter(Boolean).join('\n\n---\n\n');
    const history = trimHistoryForAgent(this.conversation?.messages ?? []);

    // The one place that waits: the breakdown is opened on purpose to ask
    // "is this number right", and answering it with the guess we happen to
    // have cached would be answering a different question.
    const resolved = await this.contextWindowFor.resolve(profile, this.model);
    const window = resolved.window;
    const windowSource = resolved.source;
    const slices: UiContextSlice[] = [
      {
        key: 'system',
        label: 'System prompt',
        tokens: systemTokens,
        note: 'Fixed — the agent loop’s own instructions.',
      },
      {
        key: 'tools',
        label: 'Tool definitions',
        tokens: toolTokens,
        note: `${tools.length} tools offered. Persona and sub-agent settings change this.`,
      },
      {
        key: 'instructions',
        label: 'Project instructions',
        tokens: estimateTokens(preamble),
        note: 'HEAPCODE.md, memory.md and the persona’s addendum.',
      },
      {
        key: 'conversation',
        label: 'Conversation',
        tokens: estimateMessagesTokens(history),
        note: `The last ${history.length} message(s) that fit the window — older turns are already dropped here.`,
      },
    ];

    const used = slices.reduce((sum, s) => sum + s.tokens, 0);
    slices.push({
      key: 'free',
      label: 'Free',
      tokens: Math.max(0, window - used),
      note: 'Room left for this turn’s reply.',
    });

    return {
      window,
      slices,
      compactionThreshold: COMPACTION_THRESHOLD,
      windowSource,
    };
  }

  /** The workspace panel (§7.3): changes, diffs, files, checkpoints. */
  private attachWorkspace(ui: RpcPeer): void {
    ui.onRequest(UI_METHODS.changes, async (): Promise<UiChangesResult> => {
      await this.start();
      return { files: await this.changedFiles() };
    });

    ui.onRequest(UI_METHODS.diff, async (raw): Promise<UiDiffResult> => {
      await this.start();
      const { path } = raw as UiDiffParams;
      const entry = this.session!.checkpoint.entryFor(path);
      const before = entry?.original ? Buffer.from(entry.original).toString('utf8') : '';
      const after = (await currentText(this.root, path)) ?? '';
      if (!entry) return { path, diff: '', added: 0, removed: 0, note: 'Not changed this session.' };
      const stats = lineDiffStats(before, after);
      return { path, diff: unifiedDiff(before, after), added: stats.added, removed: stats.removed };
    });

    ui.onRequest(UI_METHODS.fileTree, async (raw): Promise<UiFileTreeResult> => {
      const { path } = (raw ?? {}) as UiFileTreeParams;
      const rel = path ?? '';
      return { path: rel, entries: await listDirectory(this.root, rel) };
    });

    ui.onRequest(UI_METHODS.readFile, async (raw): Promise<UiReadFileResult> => {
      const { path } = raw as UiReadFileParams;
      const { content, note } = await readWorkspaceFile(this.root, path);
      return { path, content, note };
    });

    ui.onRequest(UI_METHODS.revertFile, async (raw): Promise<UiRestoreResult> => {
      await this.start();
      const { path } = raw as UiDiffParams;
      const ok = await this.session!.checkpoint.revertFile(path);
      void this.pushWorkspace();
      return { files: ok ? [path] : [] };
    });

    ui.onRequest(UI_METHODS.revertAll, async (): Promise<UiRestoreResult> => {
      await this.start();
      const files = await this.session!.checkpoint.revertAll();
      void this.pushWorkspace();
      return { files };
    });

    ui.onRequest(UI_METHODS.keepAll, async (): Promise<UiRestoreResult> => {
      await this.start();
      const files = this.session!.checkpoint.keepAll();
      void this.pushWorkspace();
      return { files };
    });

    ui.onRequest(UI_METHODS.checkpoints, async (): Promise<UiCheckpointsResult> => {
      await this.start();
      return { checkpoints: await this.session!.shadowGit.history() };
    });

    ui.onRequest(UI_METHODS.rewind, async (raw): Promise<UiRestoreResult> => {
      await this.start();
      if (this.activeRunId) throw new Error('A run is in progress; cancel it before rewinding.');
      const { hash } = raw as UiRewindParams;
      const files = await this.session!.shadowGit.restore(hash);
      if (!files) throw new Error('Could not restore that checkpoint.');
      void this.pushWorkspace();
      return { files };
    });

    ui.onRequest(UI_METHODS.search, async (raw): Promise<UiSearchResult> => {
      await this.start();
      const { query } = raw as UiSearchParams;
      // Semantic when the server has an index, plain text otherwise — the
      // same fallback the CLI's /search does, decided server-side.
      const res = await this.connection!.peer.request<{ results?: string }>(METHODS.ragQuery, { query, k: 8 })
        .catch(() => undefined);
      if (res?.results) return { kind: 'semantic', results: res.results };
      const fallback = await this.session!.executor.execute({
        id: 'ui-search',
        name: 'search',
        args: { pattern: query },
      });
      return { kind: 'text', results: fallback.content };
    });

    ui.onRequest(UI_METHODS.reindex, async (raw) => {
      await this.start();
      const { clear } = (raw ?? {}) as UiReindexParams;
      if (clear) {
        await Promise.all([
          this.connection!.peer.request(METHODS.ragIndex, { clear: true }),
          this.session!.repoMapIndexer.clear(),
        ]);
      } else {
        await Promise.all([
          this.connection!.peer.request(METHODS.ragIndex, { full: true, contextualRetrieval: true }),
          this.session!.repoMapIndexer.buildIndex(),
        ]);
      }
      // The progress stream says nothing about the repo map — that half is
      // local parsing with no events — so a push here is what tells the panel
      // the whole operation is done.
      void this.pushIndex();
      return null;
    });

    ui.onRequest(UI_METHODS.indexStatus, async (): Promise<UiIndexStatus> => {
      await this.start();
      return this.indexStatus();
    });

    ui.onRequest(UI_METHODS.repoMap, async (raw): Promise<UiRepoMapResult> => {
      await this.start();
      const { query, limit = 200 } = (raw ?? {}) as UiRepoMapParams;
      const snapshot = this.session!.repoMapIndexer.snapshot();

      // Reverse the edges once, here, rather than storing both directions:
      // "who imports this" is the question a reader actually has, and the map
      // only records the outgoing half.
      const importedBy = new Map<string, string[]>();
      for (const entry of snapshot) {
        for (const target of entry.imports) {
          const list = importedBy.get(target);
          if (list) list.push(entry.path);
          else importedBy.set(target, [entry.path]);
        }
      }

      const needle = query?.trim().toLowerCase();
      const matches = needle
        ? snapshot.filter(
            (e) =>
              e.path.toLowerCase().includes(needle) ||
              e.symbols.some((sym) => sym.name.toLowerCase().includes(needle)),
          )
        : snapshot;

      return {
        total: matches.length,
        files: matches.slice(0, limit).map((e) => ({
          path: e.path,
          symbols: e.symbols,
          imports: e.imports,
          importedBy: importedBy.get(e.path) ?? [],
        })),
      };
    });

    ui.onRequest(UI_METHODS.memory, async (): Promise<UiMemoryResult> => {
      const instructions = (await this.deps.loadInstructions?.(this.root).catch(() => '')) ?? '';
      return { instructions };
    });

    ui.onRequest(UI_METHODS.skills, async (): Promise<UiSkillsResult> => {
      return { skills: await listSkillsFormatted(this.root) };
    });

    ui.onRequest(UI_METHODS.review, async (raw): Promise<UiReviewResult> => {
      const { deep, runId } = (raw ?? {}) as UiReviewParams;
      return this.review(Boolean(deep), runId ?? randomUUID());
    });

    ui.onRequest(UI_METHODS.artifacts, async (): Promise<UiArtifactsResult> => {
      return { artifacts: (await this.artifacts.list()).map(toArtifactMeta) };
    });

    ui.onRequest(UI_METHODS.artifact, async (raw): Promise<UiArtifactResult> => {
      const { id, version } = raw as UiArtifactParams;
      const artifact = await this.artifacts.get(id);
      if (!artifact) throw new Error(`No artifact ${id}`);
      const index = version ? version - 1 : artifact.versions.length - 1;
      const chosen = artifact.versions[index];
      if (!chosen) throw new Error(`No version ${version} of ${id}`);
      return { ...toArtifactMeta(artifact), version: index + 1, content: chosen.content };
    });

    ui.onRequest(UI_METHODS.saveArtifact, async (raw): Promise<UiSaveArtifactResult> => {
      const { id, path, version } = raw as UiSaveArtifactParams;
      const artifact = await this.artifacts.get(id);
      if (!artifact) throw new Error(`No artifact ${id}`);
      const chosen = artifact.versions[version ? version - 1 : artifact.versions.length - 1];
      if (!chosen) throw new Error('No such version');
      // Root-jailed, and routed through the executor rather than writing
      // directly: this is a real workspace edit, so it must get a checkpoint
      // like any other, or "Revert all" would not cover it.
      const result = await this.session!.executor.execute({
        id: `save-artifact-${id}`,
        name: 'write_file',
        args: { path, content: chosen.content },
      });
      if (result.isError) throw new Error(result.content);
      void this.pushWorkspace();
      return { path };
    });
  }

  /**
   * The changed-file set, with per-file line stats.
   *
   * `captureFinals()` first: the checkpoint records originals as the agent
   * touches files, but the *current* content is only sampled on demand, so
   * without this the stats would describe the state at the last capture rather
   * than now.
   */
  private async changedFiles(): Promise<UiChangedFile[]> {
    const checkpoint = this.session!.checkpoint;
    await checkpoint.captureFinals();
    const out: UiChangedFile[] = [];
    for (const file of checkpoint.changedFiles()) {
      const entry = checkpoint.entryFor(file.path);
      const before = entry?.original ? Buffer.from(entry.original).toString('utf8') : '';
      const after = (await currentText(this.root, file.path)) ?? '';
      const stats = lineDiffStats(before, after);
      out.push({
        path: file.path,
        added: stats.added,
        removed: stats.removed,
        reverted: file.reverted,
        created: !entry?.original,
        deleted: after === '' && before !== '',
      });
    }
    return out;
  }

  /** Tells any attached tab the changed set moved; it refetches rather than guessing. */
  private async pushWorkspace(): Promise<void> {
    if (!this.ui) return;
    this.ui.notify(UI_METHODS.workspaceChanged, { files: await this.changedFiles() } satisfies UiChangesResult);
  }

  /** The settings surface (§9's W5 rows). Split out only for readability. */
  private attachSettings(ui: RpcPeer): void {
    ui.onRequest(UI_METHODS.settings, async (): Promise<UiSettings> => {
      await this.start();
      const cfg = await this.deps.config.load();
      const modelConfig = await this.deps.config.modelConfig();
      const profiles = await Promise.all(
        (await this.deps.config.listProfiles()).map(async (p) => ({
          name: p.name,
          preset: p.preset,
          baseUrl: p.baseUrl,
          model: p.model,
          temperature: p.temperature,
          hasKey: Boolean(await this.deps.secrets.getApiKey(p.name)),
          active: p.name === this.profile?.name,
          nativeToolCalls: resolveCapabilities(p).nativeToolCalls,
          contextWindow: p.contextWindow,
          // The preset's number, deliberately: this is a column for every
          // configured profile and it is rebuilt on every state push, so
          // asking each endpoint what it really serves would be one request
          // per profile per push. The active profile's real window is
          // resolved where it matters — the run, the meter, the breakdown.
          effectiveContextWindow: profileContextWindow(p),
          maxTokens: p.maxTokens,
          promptTier: p.promptTier,
        })),
      );
      const connected = new Set(this.session!.mcpManager.connectedServerNames());
      return {
        personas: BUILTIN_PERSONAS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
        persona: this.personaId,
        permissionMode: this.mode,
        subAgents: Boolean(this.subAgents),
        nativeToolCalls: this.profile ? resolveCapabilities(this.profile).nativeToolCalls : true,
        profiles,
        // Resolved here rather than in the browser, so the CLI, the extension
        // and this screen all say the same thing about the same state.
        roles: UI_MODEL_ROLES.map((role) => ({
          role: role.key,
          connection: modelConfig.roles[role.key]?.connection,
          model: modelConfig.roles[role.key]?.model,
          summary: describeRole(modelConfig, role.key),
        })),
        presets: providerPresets.map((p) => ({
          id: p.id,
          label: p.label,
          defaultBaseUrl: p.defaultBaseUrl,
          requiresApiKey: p.requiresApiKey,
          local: p.local,
          apiKeyUrl: p.apiKeyUrl,
        })),
        webSearch: {
          providers: [...SEARCH_PRESETS],
          provider: cfg.webSearch?.provider,
          enabled: cfg.webSearch?.enabled ?? Boolean(cfg.webSearch?.provider),
          hasKey: Boolean(await this.deps.secrets.getApiKey(WEB_SEARCH_SECRET_NAME)),
        },
        // Both sources, not just personal config: a server defined in this
        // project's `.heapcode/mcp.json` was loaded and callable but never
        // appeared here, so the panel showed "None configured" for a session
        // that had servers running in it.
        mcpServers: await this.listMcpServers(connected),
        permissionGrants: await listPermissionGrants(permissionsFile(this.root)),
      };
    });

    ui.onRequest(UI_METHODS.setPersona, async (raw) => {
      const { persona } = raw as UiSetPersonaParams;
      this.personaId = persona;
      void this.pushState();
      return null;
    });

    ui.onRequest(UI_METHODS.setSubAgents, async (raw) => {
      this.subAgents = (raw as UiToggleParams).enabled;
      return null;
    });

    ui.onRequest(UI_METHODS.setNativeTools, async (raw) => {
      await this.start();
      const { enabled } = raw as UiToggleParams;
      // Stored on the profile, since it is a fact about that endpoint rather
      // than a session preference — the CLI's /nativetools does the same.
      const next = { ...this.profile!, capabilities: { ...this.profile!.capabilities, nativeToolCalls: enabled } };
      await this.deps.config.saveProfile(next);
      this.profile = next;
      void this.pushState();
      return null;
    });

    ui.onRequest(UI_METHODS.setWebSearch, async (raw) => {
      const { provider, enabled, apiKey } = raw as UiSetWebSearchParams;
      if (apiKey !== undefined) await this.deps.secrets.setApiKey(WEB_SEARCH_SECRET_NAME, apiKey);
      const patch: Record<string, unknown> = {};
      if (provider !== undefined) patch.provider = provider;
      if (enabled !== undefined) patch.enabled = enabled;
      if (Object.keys(patch).length) await this.deps.config.saveWebSearch(patch);
      return null;
    });

    ui.onRequest(UI_METHODS.resetPermissions, async (): Promise<UiResetPermissionsResult> => {
      await this.start();
      return { cleared: await this.permissions!.reset() };
    });

    ui.onRequest(UI_METHODS.saveProfile, async (raw) => {
      const { profile, apiKey } = raw as UiSaveProfileParams;
      const next = mergeProfile(await this.deps.config.getProfile(profile.name), {
        ...profile,
        contextWindow: tokenCount(profile.contextWindow, 'Context window'),
        maxTokens: tokenCount(profile.maxTokens, 'Max output tokens'),
      });
      await this.deps.config.saveProfile(next);
      if (apiKey) await this.deps.secrets.setApiKey(profile.name, apiKey);
      if (profile.name === this.profile?.name) {
        const before = this.profile;
        this.profile = (await this.deps.config.getProfile(profile.name)) ?? next;
        // contextWindow and maxTokens are read off the profile at run time
        // (see `run`), so those two alone still need no reconnect. Everything
        // else was handed to the daemon once, at hello, and is read from that
        // copy for the rest of the session -- so saving a role redirect and
        // stopping here left the daemon running the profile as it was before
        // the edit, with nothing anywhere saying so.
        if (apiKey || daemonHeldFieldsChanged(before, this.profile)) await this.refreshDaemonProfile();
      }
      void this.pushState();
      return null;
    });

    /**
     * Add or replace a personal MCP server, and connect it now.
     *
     * The panel used to list servers and tell you to go and edit
     * `~/.heapcode/config.json` by hand, which is the one thing a settings
     * screen exists to save you from. The CLI's `/mcp` said the same. Only
     * the extension had an add flow, and it writes to VS Code's own settings,
     * so what it added was invisible here.
     */
    ui.onRequest(UI_METHODS.saveMcpServer, async (raw) => {
      await this.start();
      const { name, spec } = raw as UiSaveMcpServerParams;
      const nameProblem = mcpNameProblem(name);
      if (nameProblem) throw new Error(nameProblem);
      const parsed = parseMcpServerSpec(spec);
      if ('error' in parsed) throw new Error(parsed.error);
      await this.deps.config.saveMcpServer(name.trim(), parsed);
      this.reconnectMcp();
      void this.pushState();
      return null;
    });

    ui.onRequest(UI_METHODS.deleteMcpServer, async (raw) => {
      await this.start();
      const { name } = raw as UiNameParams;
      await this.deps.config.deleteMcpServer(name);
      this.reconnectMcp();
      void this.pushState();
      return null;
    });

    ui.onRequest(UI_METHODS.deleteProfile, async (raw) => {
      const { name } = raw as UiNameParams;
      if (name === this.profile?.name) throw new Error('Cannot delete the connection currently in use.');
      await this.deps.config.deleteProfile(name);
      await this.deps.secrets.deleteApiKey(name);
      return null;
    });

    /**
     * Assign a role, or clear it back to inheriting.
     *
     * Separate from `saveProfile` because a role is not a field on a profile
     * any more. A role naming another connection is resolved in the daemon,
     * which holds the table — so changing one has to reach it, and the daemon
     * takes a new table without a reconnect (`session/setRoles` is not a
     * thing; the table travels at hello, and `refreshDaemonRoles` reconnects
     * only when it must).
     */
    ui.onRequest(UI_METHODS.setRole, async (raw) => {
      const { role, assignment } = raw as UiSetRoleParams;
      if (role === 'chat') {
        if (!assignment) throw new Error('Chat is what the other roles inherit from, so it cannot be cleared.');
        await this.deps.config.setChatModel(assignment.connection, assignment.model);
        const next = await this.deps.config.getActiveProfile();
        if (next) {
          const before = this.profile;
          this.profile = next;
          this.modelOverride = undefined;
          if (daemonHeldFieldsChanged(before, next)) await this.reconnect();
        }
      } else {
        await this.deps.config.setRole(role, assignment);
      }
      this.agentModel = (await this.deps.config.resolve('agent'))?.model ?? this.profile?.model ?? '';
      // The daemon was handed the table once, at hello. Reconnecting is the
      // only way to replace it, and leaving it stale would run the old
      // assignment with nothing anywhere saying so.
      await this.reconnect();
      void this.pushState();
      return null;
    });

    /**
     * Model ids for one connection, for a role row's dropdown.
     *
     * Per connection and on demand rather than all at once: an endpoint that
     * is not running then costs only the row pointing at it, and a local
     * Ollama that is switched off is the ordinary case for someone whose other
     * connection is a cloud provider.
     */
    ui.onRequest(UI_METHODS.listConnectionModels, async (raw): Promise<UiConnectionModelsResult> => {
      await this.start();
      const { connection } = raw as UiConnectionModelsParams;
      try {
        const { models } = await this.connection!.peer.request<{ models: Array<{ id: string }> }>(
          METHODS.listModels,
          { profileName: connection },
        );
        return { models: models.map((m) => m.id) };
      } catch (err) {
        return { models: [], error: err instanceof Error ? err.message : String(err) };
      }
    });

    ui.onRequest(UI_METHODS.useProfile, async (raw) => {
      const { name } = raw as UiNameParams;
      if (this.activeRunId) throw new Error('A run is in progress; cancel it before switching profiles.');
      const target = await this.deps.config.getProfile(name);
      if (!target) throw new Error(`No connection named "${name}"`);
      await this.deps.config.setActiveProfile(name);
      this.profile = target;
      this.agentModel = (await this.deps.config.resolve('agent'))?.model ?? target.model;
      this.modelOverride = undefined;
      // The daemon session carries the old profile and key, so it has to be
      // rebuilt — pushing a new profile mid-session is not part of the
      // protocol, and pretending otherwise would silently keep using the old
      // endpoint.
      await this.reconnect();
      void this.pushState();
      return null;
    });

    ui.onRequest(UI_METHODS.runCommand, async (raw): Promise<UiSendMessageResult> => {
      const { command, runId } = raw as UiRunCommandParams;
      const task = COMMAND_TASKS[command];
      if (!task) throw new Error(`Unknown command: ${command}`);
      return this.run(task, runId ?? randomUUID());
    });
  }

  /** Tears down and re-opens the daemon session — used when the profile changes. */
  /**
   * Hand the daemon the profile as it now stands.
   *
   * The daemon is given the active profile exactly once, at hello, and reads
   * the role redirects, the endpoint, the key and the capabilities off that
   * copy from then on (core/src/server/session.ts:135). Nothing in the
   * protocol pushes a changed profile into a live session, so the only way to
   * apply an edit is to rebuild the session -- the same thing `useProfile`
   * does, and for the same reason.
   *
   * Never mid-run: closing the connection would kill the run in flight, and a
   * settings edit must not do that. It waits for the run to end instead. If
   * the reconnect itself fails the flag stays set, so the next opportunity
   * tries again rather than leaving the daemon on a profile nobody chose.
   */
  private async refreshDaemonProfile(): Promise<void> {
    if (!this.connection) {
      // Nothing has started yet, so hello has not happened -- it will carry
      // the current profile when it does.
      this.profileRefreshPending = false;
      return;
    }
    if (this.activeRunId) {
      this.profileRefreshPending = true;
      return;
    }
    await this.reconnect();
    this.profileRefreshPending = false;
  }

  /**
   * MCP servers as the settings panel needs them: both sources, with the
   * project-scoped ones marked so the editor can show them read-only.
   */
  private async listMcpServers(connected: Set<string>): Promise<UiMcpServer[]> {
    const { global, project } = await loadMcpServerSources(this.root, this.deps.config);
    const tools = this.session?.mcpManager.getToolDefinitions() ?? [];
    return Object.entries({ ...global, ...project }).map(([name, server]) => ({
      name,
      connected: connected.has(name),
      tools: tools.map((t) => t.name).filter((t) => t.startsWith(name.replace(/[^a-zA-Z0-9_-]/g, '_'))),
      spec: describeMcpServer(server),
      project: name in project,
    }));
  }

  /**
   * Pick up a changed server list without restarting the session.
   *
   * `McpManager` reads its config through the thunk it was built with, so
   * this re-reads the file: it drops what was removed, connects what is new,
   * and reconnects anything whose definition changed.
   *
   * Not awaited by the caller. Connecting means launching the server — an
   * `npx` line can spend half a minute fetching a package before it says
   * anything — and a settings panel that freezes until a third-party process
   * finishes starting is worse than one that shows the row immediately as not
   * connected and updates when it is. The second `pushState` is what makes
   * that arrive.
   *
   * A server that will not start is reported by its own row, and must never
   * turn saving a setting into an error.
   */
  private reconnectMcp(): void {
    void this.session?.mcpManager
      .ensureConnected()
      .catch(() => {
        /* The row shows it as not connected, which is the honest report. */
      })
      .finally(() => void this.pushState());
  }

  /** Apply a profile edit that arrived while a run was in flight. */
  private flushProfileRefresh(): void {
    if (!this.profileRefreshPending) return;
    void this.refreshDaemonProfile().catch(() => {
      /* Flag stays set; the next run's end tries again. */
    });
  }

  /**
   * Rebuild the daemon session, which is the only way to replace what was
   * pushed at hello.
   *
   * It must carry everything `start` carries. It did not carry `roles`, and
   * that is the whole of two reported failures: `ui/setRole` calls this, so
   * changing a role handed the daemon a session with *no role table at all* —
   * the one edit guaranteed to leave it stale. Embeddings then either ran the
   * chat model (a 400 from the provider naming a model that cannot embed) or,
   * once roles that inherit nothing stopped falling back, reported
   * "no-embedder" for a role that was plainly set.
   */
  private async reconnect(): Promise<void> {
    this.connection?.close();
    this.connection = undefined;
    const profile = this.profile!;
    const apiKey = await this.deps.secrets.getApiKey(profile.name);
    this.connection = await this.deps.connect({
      root: this.root,
      profiles: [profile],
      activeProfile: profile.name,
      roles: await this.deps.config.getRoles(),
      keys: apiKey ? { [profile.name]: apiKey } : {},
    });
    this.registerDaemonHandlers(this.connection.peer);
    this.forgetConnectionWhenItCloses(this.connection);
    this.warmContextWindow();
  }

  /**
   * Ask the endpoint how big its window is now, rather than on first use.
   *
   * `known()` answers with the preset's guess until the real number arrives,
   * which keeps it off the run's critical path — but the first read of a
   * session was happening inside the first run, so that run got the guess.
   * That is the run it matters for: it is usually the longest, and a guess
   * that is too small compacts it early, summarising away what it had already
   * looked up. Then it looks the same things up again.
   *
   * Seen on a real session: the preset says 128k, the endpoint serves a
   * million, and a research-heavy first turn re-issued six searches it had
   * already run.
   *
   * Starting it at hello costs one request nobody waits for, and by the time
   * a human has typed a prompt the answer is there.
   */
  private warmContextWindow(): void {
    const profile = this.profile;
    if (!profile) return;
    void this.contextWindowFor.resolve(profile, this.model).catch(() => {
      /* Falls back to the preset exactly as before — never worth surfacing. */
    });
  }

  /**
   * Let go of a daemon that has gone, so the next request builds a new one.
   *
   * The daemon outlives this host by design, and it also exits without asking:
   * it goes idle, it retires because its bundle was rebuilt, someone kills it.
   * Holding the dead peer meant every later request rejected with "connection
   * closed" until the host itself was restarted — the browser sat on a
   * daemon-down badge with no way back. Which is how a rebuilt daemon stayed
   * invisible: the one thing that would have picked up the new build was the
   * thing that could no longer happen.
   *
   * `start()` rebuilds from `this.connection` being undefined, so dropping the
   * reference is the whole recovery. A run that was in flight is already lost
   * with the socket; that is reported by its own rejection, not here.
   */
  private forgetConnectionWhenItCloses(connection: ServerConnection): void {
    connection.peer.onClose(() => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      void this.pushState();
    });
  }

  /**
   * `edit_file`'s fast-apply fallback, routed to the daemon.
   *
   * Swallows everything. This runs only after a search/replace has already
   * failed, so any error here means the rescue did not happen — and the edit
   * failure it was rescuing is the result the model needs to see, not a second
   * error about the merge model.
   */
  private async applyMerge(original: string, snippet: string): Promise<string | undefined> {
    if (!this.connection) return undefined;
    try {
      const res = await this.connection.peer.request<{ merged?: string }>(METHODS.applyMerge, {
        original,
        snippet,
        profileName: this.profile?.name,
      });
      return res.merged;
    } catch {
      return undefined;
    }
  }

  /** Both indexes, side by side — see `UiIndexStatus` for why both. */
  private async indexStatus(): Promise<UiIndexStatus> {
    const map = this.session!.repoMapIndexer;
    const snapshot = map.snapshot();
    let semantic = { state: 'unavailable', files: 0, chunks: 0, available: false };
    try {
      const res = await this.connection!.peer.request<{
        state: string;
        files: number;
        chunks: number;
        available: boolean;
        message?: string;
      }>(METHODS.ragStatus, {});
      semantic = res;
    } catch {
      // A daemon that cannot answer is reported as unavailable rather than
      // failing the whole panel — the repo-map half is still worth showing.
    }
    return {
      semantic,
      repoMap: {
        ready: map.ready,
        files: snapshot.length,
        symbols: snapshot.reduce((n, e) => n + e.symbols.length, 0),
        links: snapshot.reduce((n, e) => n + e.imports.length, 0),
      },
      progress: this.indexProgress,
    };
  }

  /** Pushes index status to the attached tab, so a rebuild is watchable. */
  private async pushIndex(): Promise<void> {
    if (!this.ui || !this.session || !this.connection) return;
    this.ui.notify(UI_METHODS.indexChanged, await this.indexStatus());
  }

  /** Fire-and-forget state push, so switchers update every attached tab. */
  private async pushState(): Promise<void> {
    if (!this.ui) return;
    this.ui.notify(UI_METHODS.stateChanged, await this.state());
  }

  /** Called when a browser disconnects. The run deliberately keeps going. */
  detach(ui: RpcPeer): void {
    if (this.ui === ui) this.ui = undefined;
  }

  async state(): Promise<UiState> {
    const cfg = await this.deps.config.load();
    const profiles = await Promise.all(
      (cfg.profiles ?? []).map(async (p) => ({
        name: p.name,
        model: p.model,
        // Never the key itself (§6.1) — only whether one exists.
        hasKey: Boolean(await this.deps.secrets.getApiKey(p.name)),
      })),
    );
    return {
      root: this.root,
      workspaceName: basename(this.root),
      profile: this.profile?.name ?? '',
      // `this.model`, not the profile's — otherwise `ui/setModel` changed which
      // model actually ran while every picker and header in the UI went on
      // naming the profile's, so switching models looked like it had failed.
      model: this.model,
      persona: this.personaId ?? 'agent',
      permissionMode: this.mode,
      // The meter's denominator before any run has reported usage — otherwise
      // the window is invisible until the first turn, which is exactly when
      // someone wants to check it.
      contextWindow: this.profile ? this.contextWindowFor.known(this.profile, this.model).window : undefined,
      profiles,
      daemon: this.connection ? 'up' : 'down',
      runId: this.activeRunId,
      lan: this.deps.lan,
    };
  }

  // -------------------------------------------------------------------------
  // running
  // -------------------------------------------------------------------------

  async run(task: string, runId: string, images?: string[]): Promise<UiSendMessageResult> {
    await this.start();
    const { peer } = this.connection!;
    const session = this.session!;
    const profile = this.profile!;

    if (this.activeRunId) throw new Error('A run is already in progress; cancel it first.');
    this.activeRunId = runId;
    this.abort = new AbortController();
    this.buffers.set(runId, []);
    /** Whether the success path already wrote this turn — see the `finally`. */
    let persisted = false;

    const persona = applyModeToPersona(getPersona(this.personaId), this.mode);
    // CREATE_ARTIFACT_TOOL is added HERE, by this host only — the CLI and the
    // extension never see it, because neither can render one (artifacts.ts).
    const offeredTools = filterToolsForPersona(
      [...session.tools, DELEGATE_TASK_TOOL, CREATE_ARTIFACT_TOOL, ...session.mcpManager.getToolDefinitions()],
      persona,
    );

    // Same config key the CLI reads, so one machine's runs share a ceiling no
    // matter which host started them. Resolved here rather than left undefined
    // for core to default, because the browser is told which number applied.
    const maxIterations = (await this.deps.config.load()).maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // The conversation as it stood BEFORE this turn — the agent gets prior
    // context, not the message it is currently answering.
    const history = trimHistoryForAgent(this.conversation!.messages);

    // Same preamble shape as headless and the Ink UI: persona constraints and
    // project instructions, then the task.
    const instructions = await this.deps.loadInstructions?.(this.root).catch(() => '') ?? '';
    const fullTask = buildAgentTask({ personaAddendum: persona.taskAddendum, instructions, task });

    // Multiple assistant messages can occur in one run (narration, then a
    // summary). `lastText` tracks the most recently COMPLETED one, mirroring
    // headless.ts:294-317, so a streamed turn isn't concatenated onto an
    // earlier one; `turnEntries` keeps all of them, in order, with the tool
    // chips and plans between them.
    this.lastText = '';
    this.deltaAcc = '';
    this.reasoningAcc = '';
    this.turnEntries = [];
    this.pendingDisplay = task;
    // Announce the run at its START, not only when it ends. `state.runId` is
    // how a reattached tab knows a run is still going and — more importantly —
    // how it learns the run finished: a browser that reloaded mid-run has no
    // `agent/run` promise of its own to settle on, so without this push its
    // composer stayed stuck on "Running — Esc to stop" forever.
    void this.pushState();

    try {
      const { outcome } = await peer.request<AgentRunResult>(
        METHODS.agentRun,
        {
          runId,
          profileName: profile.name,
          model: this.model,
          task: fullTask,
          history,
          workspaceName: basename(this.root),
          tools: offeredTools,
          // Resolved from the PROFILE, like the CLI (App.tsx:1659) and
          // headless (headless.ts:335) — not hardcoded. Hardcoding `true` sent
          // native tool definitions to endpoints that reject them, so the model
          // narrated what it would do instead of calling anything: no tool
          // chips, no edits. `deps` stays as an override for tests only.
          nativeToolCalls: this.deps.nativeToolCalls ?? resolveCapabilities(profile).nativeToolCalls,
          // The endpoint's own number where it has one. A preset default that
          // overstates the real window means the loop never compacts and the
          // endpoint truncates the prompt instead, silently.
          contextWindow: this.contextWindowFor.known(profile, this.model).window,
          // Was missing entirely, so a profile's maxTokens was honoured by the
          // CLI (App.tsx) and ignored here — replies got truncated at the
          // provider default with no way to raise it from the browser.
          maxTokens: profile.maxTokens,
          subAgents: this.subAgents,
          persona,
          images,
          maxIterations,
          // The browser renders ask_user as a card, so it can answer this one.
          askToContinueAtLimit: true,
        } satisfies AgentRunParams,
        this.abort.signal,
      );
      await this.persistTurn(task, images?.length);
      persisted = true;
      return { runId, outcome, maxIterations };
    } finally {
      if (!persisted) await this.persistUnfinishedTurn(task, images?.length);
      this.activeRunId = undefined;
      this.abort = undefined;
      this.pendingDisplay = undefined;
      this.flushProfileRefresh();
      void this.pushState();
    }
  }

  /**
   * Keep a turn that did not finish cleanly.
   *
   * `persistTurn` sits on the success path, and this host -- alone among the
   * three -- hands its own AbortSignal to `agent/run`. So Stop rejects the
   * request here instead of letting the daemon answer `outcome: 'stopped'`,
   * which is what the CLI and the extension get (both only notify
   * `agent/cancel`, and both persist normally afterwards). The turn was
   * therefore discarded whole: every file it read, every edit it made, gone
   * from the conversation at the moment you stopped it -- and gone from the
   * next turn's history, so the model could not be told what it had just
   * done and started over.
   *
   * The local abort stays, because it is what makes Stop work against a
   * daemon that has stopped answering. It just no longer costs the transcript.
   *
   * A run that produced nothing writes nothing: a request that never reached
   * the daemon is not an exchange, and recording it would leave an
   * unanswered prompt in the history for the next turn to puzzle over.
   */
  private async persistUnfinishedTurn(task: string, imageCount?: number): Promise<void> {
    if (!this.conversation) return;
    if (this.turnEntries.length === 0 && !this.lastText.trim() && !this.reasoningAcc.trim()) return;
    try {
      await this.persistTurn(task, imageCount);
    } catch {
      /* Losing the write is bad; losing the error that caused it is worse. */
    }
  }

  /**
   * `/pr-review` — the same review the CLI and the extension run, against the
   * same server-side `review/run`.
   *
   * This is only the browser adapter: progress and warnings become
   * `ui/reviewEvent` notifications, the confirmation becomes a
   * `ui/reviewConfirm` request the user answers with a click, and the outcome
   * comes back as a note in the transcript. `log` events are dropped, as they
   * are in the CLI — per-tool-call noise buries a transcript, and the progress
   * lines already say what is happening.
   *
   * It takes the run slot (`activeRunId`) rather than running alongside a chat
   * turn. One thing at a time per workspace is the rule everywhere else here
   * (§12 Q10), and a review shares the same Stop button and the same busy
   * composer — `agent/cancel` stops a review too.
   */
  async review(deep: boolean, runId: string): Promise<UiReviewResult> {
    await this.start();
    const { peer } = this.connection!;
    const session = this.session!;
    const profile = this.profile!;

    if (this.activeRunId) throw new Error('A run is already in progress; cancel it first.');
    this.activeRunId = runId;
    this.abort = new AbortController();
    this.activeReview = runId;
    void this.pushState();

    try {
      const result = await peer.request<ReviewRunResult>(
        METHODS.reviewRun,
        {
          runId,
          profileName: profile.name,
          model: this.model,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          contextWindow: this.contextWindowFor.known(profile, this.model).window,
          // The review filters this to the read-only tools itself
          // (prReview.ts:457); handing it the full list is what every host does.
          tools: [...session.tools, ...session.mcpManager.getToolDefinitions()],
          client: WEB_REVIEW_CLIENT,
          deep,
        } satisfies ReviewRunParams,
        this.abort.signal,
      );
      return result.status === 'posted'
        ? { status: 'posted', pr: { number: result.pr.number, url: result.pr.url } }
        : { status: result.status };
    } finally {
      this.activeReview = undefined;
      this.activeRunId = undefined;
      this.abort = undefined;
      this.flushProfileRefresh();
      void this.pushState();
    }
  }

  /**
   * The in-flight turn as UI messages: the prompt, then everything recorded so
   * far, then whatever is still streaming.
   *
   * Built from `turnEntries` — the same list `persistTurn` writes — rather than
   * from the event buffer, so what a mid-run reload draws is exactly what the
   * finished conversation will contain, minus the part that hasn't happened.
   */
  private pendingTurn(): UiMessage[] {
    const out: UiMessage[] = [];
    if (this.pendingDisplay) out.push({ role: 'user', content: this.pendingDisplay });
    out.push(...toUiMessages(this.turnEntries, { live: true }));
    // The tail: text or reasoning mid-stream. Marked `streaming` so the
    // browser's reducer appends the next delta to it instead of opening a
    // second block beside it.
    if (this.reasoningAcc.trim())
      out.push({ role: 'assistant', content: this.reasoningAcc, ui: { reasoning: true, streaming: true } });
    if (this.deltaAcc.trim()) out.push({ role: 'assistant', content: this.deltaAcc, ui: { streaming: true } });
    return out;
  }


  /**
   * Records the turn. `display` is what the user typed; `content` is what the
   * model saw — the preamble-expanded task. Keeping both is why the sidebar
   * can show a readable transcript while the agent still gets full context
   * on the next turn (history/types.ts:7-10).
   */
  private async persistTurn(display: string, imageCount?: number): Promise<void> {
    const convo = this.conversation!;
    // Attachments are noted, not stored. A screenshot is a couple of megabytes
    // of base64, and conversations.json is read whole on every load — the same
    // reason `clipArgs` exists. The model saw them on the turn they were sent;
    // a reload gets the note, which is the honest record of what happened.
    const line = imageCount
      ? `${display}\n\n_(${imageCount} image${imageCount === 1 ? '' : 's'} attached)_`
      : display;
    // A run that ends mid-thought (cancelled, or a provider that never sends
    // `reasoning_end`) still has thinking worth keeping.
    if (this.reasoningAcc.trim()) {
      this.turnEntries.push({
        role: 'assistant',
        content: this.reasoningAcc,
        ui: { reasoning: true },
      } as StoredMessage);
      this.reasoningAcc = '';
    }
    // An empty turn still gets an assistant message: a conversation whose last
    // entry is a user message reads as unanswered when it is reloaded. A turn
    // of nothing but thinking counts as empty here — reasoning never becomes
    // context, so a reasoning-only turn would leave the model with a dangling
    // question on the next one.
    const answered = this.turnEntries.some((m) => !m.ui?.reasoning);
    const entries = answered
      ? this.turnEntries
      : [...this.turnEntries, { role: 'assistant', content: this.lastText } as StoredMessage];
    convo.messages.push({ role: 'user', content: display, display: line } as StoredMessage, ...entries);
    if (convo.title === 'New chat') convo.title = display.slice(0, 60);
    convo.updatedAt = Date.now();
    await this.history!.save(convo);
  }

  async cancel(_runId?: string): Promise<void> {
    // Cancels whatever is actually running, ignoring the id the caller named.
    // Matching on it was wrong: a browser that reconnected mid-run, or a
    // command whose id was assigned host-side, would send an id that never
    // matched and the click would silently do nothing. There is only ever one
    // run per session, so "the active one" is unambiguous.
    const target = this.activeRunId;
    if (!target) return;

    // A NOTIFICATION, not a request — the daemon registers `agent/cancel` on
    // its notification channel (server.ts:361). Sending it as a request got
    // `methodNotFound` back, which a `.catch()` then swallowed, so Stop looked
    // wired up and did nothing. Every other host uses notify here
    // (App.tsx:1309, serverLink.ts:265).
    this.connection?.peer.notify(METHODS.agentCancel, { runId: target });

    // Also abort locally, so `agent/run` settles even if the daemon is wedged.
    this.abort?.abort();
  }

  // -------------------------------------------------------------------------
  // daemon side — the four server→host requests, plus events
  // -------------------------------------------------------------------------

  private registerDaemonHandlers(peer: RpcPeer): void {
    const session = this.session!;

    peer.onRequest(METHODS.toolExecute, async (raw, signal): Promise<ToolResult> => {
      const { call } = raw as ToolExecuteParams;
      // The signal MUST be threaded through. Cancelling a run fires
      // `$/cancelRequest` for the outstanding tool/execute, and that is what
      // `runCommand` listens to in order to kill the child process group
      // (workspaceTools.ts:566). Dropping it — as this did — meant Stop ended
      // the loop but left `npm test` running to completion, so the request
      // never settled and the agent looked like it had ignored the click.
      // The CLI threads it the same way (App.tsx:609-612).
      return this.executeTool(call, signal);
    });

    peer.onRequest(METHODS.permissionRequest, async (raw): Promise<PermissionRequestResult> => {
      const { call, permission } = raw as PermissionRequestParams;
      // Sub-agent delegation resolves to an informative error server-side; a
      // generic denial here would hide from the model WHY it can't delegate.
      if (call.name === 'delegate_task' && !this.subAgents) return { granted: true };
      const tool = { name: call.name, description: '', parameters: {}, permission };
      const description = session.executor.describe(call);
      const granted = await this.permissions!.request(call, tool, description);
      return { granted };
    });

    peer.onRequest(METHODS.snapshotBefore, async (raw) => {
      const { call } = raw as SnapshotBeforeParams;
      await session.shadowGit.snapshot(`${call.name}: ${session.executor.describe(call).slice(0, 80)}`);
      return null;
    });

    peer.onRequest(METHODS.keyRequest, async (raw): Promise<KeyRequestResult> => {
      const { profileName } = raw as KeyRequestParams;
      const target = await this.deps.config.getProfile(profileName);
      if (!target) return {};
      return { profile: target, apiKey: await this.deps.secrets.getApiKey(profileName) };
    });

    // ---- PR review ----
    //
    // The confirmation is the one place a model's output becomes a public
    // comment on someone's PR, so it is gated three ways: it must belong to the
    // review THIS session started, a browser must be attached to answer it, and
    // the user must click. Any of those missing is a "no" — never a default
    // yes, and never a silent post while nobody is looking.
    peer.onRequest(METHODS.reviewConfirm, async (raw): Promise<ReviewConfirmResult> => {
      const { runId, confirmation } = raw as ReviewConfirmParams;
      if (!this.activeReview || this.activeReview !== runId) return { ok: false };
      if (!this.ui) return { ok: false };
      const answer = await this.ui.request<UiReviewConfirmResult>(UI_METHODS.reviewConfirm, {
        runId,
        pr: { number: confirmation.pr.number, url: confirmation.pr.url, title: confirmation.pr.title },
        preview: confirmation.preview,
        findingCount: confirmation.findingCount,
        inlineCount: confirmation.inlineCount,
        plainText: confirmation.plainText,
      } satisfies UiReviewConfirmParams);
      return { ok: Boolean(answer?.ok) };
    });

    peer.onNotification(METHODS.reviewEvent, (raw) => {
      const { runId, event } = raw as ReviewEventParams;
      if (this.activeReview !== runId) return;
      // `log` is diagnostic — the CLI drops it for the same reason: it is one
      // line per tool call, and it would bury the transcript it lands in.
      if (event.kind === 'log') return;
      this.ui?.notify(UI_METHODS.reviewEvent, {
        runId,
        kind: event.kind,
        message: event.message,
      } satisfies UiReviewEventParams);
    });

    // Indexing progress. The daemon streams it; the panel renders it — the
    // same arrangement the CLI's progress line and the extension's status bar
    // already use (server/protocol.ts, `rag/event`).
    peer.onNotification(METHODS.ragEvent, (raw) => {
      const { event } = raw as { event: { kind: string; embedded?: number; total?: number } };
      this.indexProgress =
        event.kind === 'progress' ? { embedded: event.embedded ?? 0, total: event.total ?? 0 } : undefined;
      void this.pushIndex();
    });

    peer.onNotification(METHODS.agentEvent, (raw) => {
      const params = raw as AgentEventParams;
      this.recordForHistory(params.event);
      const buffer = this.buffers.get(params.runId);
      if (buffer) {
        buffer.push(params);
        // Bounded: a long run must not grow the host's memory without limit.
        if (buffer.length > REPLAY_BUFFER) buffer.splice(0, buffer.length - REPLAY_BUFFER);
      }
      // A detached browser is not an error — the run continues and the buffer
      // is what the next tab replays.
      this.ui?.notify(UI_METHODS.event, params satisfies UiEventParams);
    });
  }

  /**
   * Folds one live event into the turn that will be written to history.
   *
   * The browser rebuilds its view from `transcript.ts`'s reducer while a run is
   * streaming; this is the durable half of the same story, so a reload lands on
   * the same transcript rather than on prose with the tool calls cut out.
   *
   * Reasoning is recorded too, as a `ui.reasoning` entry. It used to be dropped
   * on the grounds that the UI collapses it anyway — but collapsed is not gone,
   * and a reloaded conversation lost every thinking block it had shown. It is
   * transcript furniture like a tool chip: drawn, never fed back as context
   * (`trimHistoryForAgent` filters it out on the way to the model).
   */
  private recordForHistory(event: AgentEvent): void {
    switch (event.type) {
      case 'text':
        this.lastText = event.text;
        this.turnEntries.push({ role: 'assistant', content: event.text } as StoredMessage);
        return;
      case 'text_delta':
        this.deltaAcc += event.text;
        return;
      case 'text_end':
        if (this.deltaAcc.trim()) {
          this.lastText = this.deltaAcc;
          this.turnEntries.push({ role: 'assistant', content: this.deltaAcc } as StoredMessage);
        }
        this.deltaAcc = '';
        return;
      case 'reasoning_delta':
        this.reasoningAcc += event.text;
        return;
      case 'reasoning_end':
        if (this.reasoningAcc.trim())
          this.turnEntries.push({
            role: 'assistant',
            content: this.reasoningAcc,
            ui: { reasoning: true },
          } as StoredMessage);
        this.reasoningAcc = '';
        return;
      case 'plan':
        this.turnEntries.push({ role: 'assistant', content: event.text, ui: { plan: true } } as StoredMessage);
        return;
      case 'todo_update': {
        // One card per turn, replaced in place — the live answer to "what is
        // left", not a log of every write the model made.
        const existing = this.turnEntries.find((m) => m.ui?.todos);
        if (existing) existing.ui!.todos = event.todos;
        else this.turnEntries.push({ role: 'assistant', content: '', ui: { todos: event.todos } } as StoredMessage);
        return;
      }
      case 'tool_call':
        this.turnEntries.push({
          role: 'assistant',
          content: '',
          ui: {
            tool: {
              id: event.id,
              name: event.name,
              // `description` is what the CLI and the extension render; the web
              // UI renders from `args`. Both are stored so neither host has to
              // reconstruct the other's.
              description: describeCall(event.name, event.args),
              args: clipArgs(event.args),
              ok: true,
            },
          },
        } as StoredMessage);
        return;
      case 'tool_result': {
        // Search backwards: the matching call is almost always the last one.
        for (let i = this.turnEntries.length - 1; i >= 0; i--) {
          const tool = this.turnEntries[i]!.ui?.tool;
          if (tool && tool.id === event.id) {
            tool.ok = !event.isError;
            tool.summary = event.content.slice(0, TOOL_SUMMARY_CHARS);
            return;
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private async executeTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const session = this.session!;

    if (call.name === 'ask_user') {
      const answer = await this.askUser(call, signal);
      return { id: call.id, name: call.name, content: answer };
    }

    if (call.name === CREATE_ARTIFACT_TOOL.name) return this.createArtifact(call);

    if (session.mcpManager.isMcpTool(call.name)) {
      // MCP stays host-side, as in the other hosts.
      try {
        return { id: call.id, name: call.name, content: await session.mcpManager.call(call.name, call.args) };
      } catch (err) {
        return {
          id: call.id,
          name: call.name,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }

    return session.executor.execute(call, signal);
  }

  /**
   * `create_artifact`. Validation is strict and errors are returned to the
   * model rather than thrown: a bad `kind` is something it can correct on the
   * next turn, whereas an exception would surface as a tool failure with no
   * hint about what to fix.
   */
  private async createArtifact(call: ToolCall): Promise<ToolResult> {
    const args = call.args as { id?: string; title?: string; kind?: string; content?: string; language?: string };
    const fail = (message: string): ToolResult => ({ id: call.id, name: call.name, content: message, isError: true });

    if (!isArtifactKind(args.kind)) {
      return fail(`Unknown artifact kind "${String(args.kind)}". Use one of: ${ARTIFACT_KINDS.join(', ')}.`);
    }
    if (typeof args.content !== 'string' || !args.content.trim()) return fail('An artifact needs content.');
    if (typeof args.title !== 'string' || !args.title.trim()) return fail('An artifact needs a title.');

    try {
      const artifact = await this.artifacts.put({
        id: args.id,
        title: args.title,
        kind: args.kind,
        content: args.content,
        language: args.language,
      });
      this.ui?.notify(UI_METHODS.artifactChanged, toArtifactMeta(artifact));
      return {
        id: call.id,
        name: call.name,
        content:
          `Artifact "${artifact.title}" (id: ${artifact.id}, v${artifact.versions.length}) is now showing in the ` +
          `user's Preview panel. Do not repeat its content in your reply — they can see it.`,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async askUser(call: ToolCall, signal?: AbortSignal): Promise<string> {
    // No browser attached → the same "proceed with best judgment" fallback
    // headless uses. Blocking forever on a closed tab would wedge the run.
    if (!this.ui) return ASK_USER_NO_ANSWER;
    const args = call.args as { question?: string; options?: string[] };
    try {
      // Signal passed on: Stop must also abandon a question the user never
      // answered, or the run hangs on a card nobody is looking at.
      const { answer } = await this.ui.request<UiAskUserResult>(
        UI_METHODS.askUser,
        {
          runId: this.activeRunId ?? '',
          callId: call.id,
          question: String(args.question ?? ''),
          options: args.options,
          blocksAction: askUserBlocksAction(call.args),
        } satisfies UiAskUserParams,
        signal,
      );
      return answer.trim() ? askUserAnswerMessage(answer) : ASK_USER_NO_ANSWER;
    } catch {
      // The tab went away mid-question.
      return ASK_USER_NO_ANSWER;
    }
  }
}

/** Same cap the extension uses for a persisted chip body (controller.ts:829). */
const TOOL_SUMMARY_CHARS = 5_000;

/** Long enough to identify a call, short enough that a written file's contents
 *  never land in conversations.json — the chip shows ~80 characters. */
const ARG_CHARS = 200;

/**
 * The stored arguments for a tool chip, with every long string clipped.
 *
 * Without this a single `write_file` would persist the entire file body into
 * the conversation, once per call, forever.
 */
export function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') out[key] = value.length > ARG_CHARS ? `${value.slice(0, ARG_CHARS)}…` : value;
    else if (value === null || ['number', 'boolean'].includes(typeof value)) out[key] = value;
    // Objects and arrays (multi_edit's edit list, for one) are dropped rather
    // than walked: nothing renders them, and their size is unbounded.
  }
  return out;
}

/**
 * A one-line rendering of a call for hosts that display `description`.
 *
 * Deliberately dumb — the real `executor.describe` is per-executor and this
 * runs for MCP and artifact tools too, where there is no executor to ask.
 */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const first = Object.values(clipArgs(args)).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  return first ? `${name}: ${first.slice(0, 80)}` : name;
}

/**
 * A token budget from the browser: a positive integer, `null` to clear, or
 * `undefined` to leave alone. Rejecting rather than coercing, because a
 * silently-clamped context window would misreport the meter and compact at a
 * size the user never chose.
 */
/**
 * Fields the host re-sends on every run, so a change to them reaches the
 * daemon without rebuilding the session.
 *
 * Deliberately a list of exceptions rather than a list of what matters. A
 * profile crosses to the daemon whole and is read from that copy; these two
 * are the only ones the host also passes per run (see `run`). Anything added
 * to a profile later is therefore treated as needing a reconnect until
 * someone proves otherwise, which is the safe direction to be wrong in --
 * the previous version guessed the other way and left every role redirect
 * inert.
 */
const RESENT_EACH_RUN = new Set<keyof ProviderProfileConfig>(['contextWindow', 'maxTokens']);

/** Did this edit touch anything the daemon is holding its own copy of? */
function daemonHeldFieldsChanged(
  before: ProviderProfileConfig | undefined,
  after: ProviderProfileConfig,
): boolean {
  if (!before) return true;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as Array<keyof ProviderProfileConfig>);
  for (const key of keys) {
    if (RESENT_EACH_RUN.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return true;
  }
  return false;
}

function tokenCount(value: number | null | undefined, label: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive whole number of tokens.`);
  return value;
}

/**
 * Applies the browser's patch to a stored profile.
 *
 * The browser edits four or five fields; a profile has twenty. Replacing the
 * whole object with what came over the wire is how `temperature`, `headers`,
 * `timeoutMs` and the per-role model overrides used to disappear the first
 * time someone pressed "Save changes" in the web settings.
 *
 * `null` is the explicit "clear it" signal — distinct from `undefined`, which
 * means the browser had nothing to say about that field. That distinction is
 * what lets a numeric box be emptied back to the inherited default.
 */
export function mergeProfile(
  existing: ProviderProfileConfig | undefined,
  patch: UiSaveProfileParams['profile'],
): ProviderProfileConfig {
  const next: ProviderProfileConfig = {
    ...(existing ?? { name: patch.name, preset: 'custom', baseUrl: '', model: '' }),
    name: patch.name,
  };
  if (patch.preset !== undefined) {
    // Validated rather than cast: `getPreset` silently falls back to "custom"
    // for an unknown id, so a typo would quietly change the endpoint's
    // capabilities instead of failing the save.
    const preset = providerPresets.find((p) => p.id === patch.preset);
    if (!preset) throw new Error(`Unknown provider preset "${patch.preset}".`);
    next.preset = preset.id;
  }
  if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) next.model = patch.model;
  // `null` is the editor's "back to automatic", which is the absence of the
  // field rather than a third value — the same distinction the numeric
  // overrides below make.
  if (patch.promptTier !== undefined) next.promptTier = patch.promptTier ?? undefined;
  // `?? undefined` is the clear: JSON.stringify drops the key on persist, so
  // the profile goes back to inheriting the preset's value.
  if (patch.contextWindow !== undefined) next.contextWindow = patch.contextWindow ?? undefined;
  if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens ?? undefined;
  if (patch.temperature !== undefined) next.temperature = patch.temperature ?? undefined;
  return next;
}

/**
 * Stored transcript → what the browser renders.
 *
 * Prefers `display` over `content`: the stored `content` is the
 * preamble-expanded task the model saw, and showing a user their own three-word
 * prompt wrapped in project instructions is not what they asked to see
 * (history/types.ts:7-10).
 *
 * Tool chips, plans and reasoning blocks come back too. They used to be
 * filtered out here on the grounds that the live event stream would supply them
 * — true only for the tab that watched the run happen. Reload it, or open the
 * conversation tomorrow, and the events are long gone: the transcript came back
 * as bare prose with every command, edit, plan and thought missing from the
 * middle of it.
 *
 * Status markers stay dropped: they are a CLI spinner's state, with nothing to
 * draw here.
 *
 * `live` marks a turn still in flight (`pendingTurn`), where a tool chip with
 * no result yet is a call still running rather than one that returned nothing.
 */
export function toUiMessages(messages: StoredMessage[], opts?: { live?: boolean }): UiMessage[] {
  const out: UiMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.ui?.status) continue;

    const tool = m.ui?.tool;
    if (tool) {
      out.push({
        role: 'assistant',
        content: '',
        ui: {
          tool: {
            id: tool.id,
            name: tool.name,
            description: tool.description,
            args: tool.args,
            result: tool.summary,
            isError: tool.ok === false,
            // `summary` is written by `tool_result` and only by it, so its
            // absence mid-run is exactly "hasn't come back yet".
            done: opts?.live ? tool.summary !== undefined : true,
          },
        },
      });
      continue;
    }

    // The task-list card before the empty-content skip: its content is always
    // empty (the state lives in `ui.todos`), which is what that check drops.
    if (m.ui?.todos) {
      out.push({ role: 'assistant', content: '', ui: { todos: m.ui.todos } });
      continue;
    }

    const content = m.display ?? m.content ?? '';
    if (!content.trim()) continue;
    if (m.ui?.reasoning) {
      out.push({ role: 'assistant', content, ui: { reasoning: true } });
      continue;
    }
    out.push({ role: m.role, content, ...(m.ui?.plan ? { ui: { plan: true } } : {}) });
  }
  return out;
}
