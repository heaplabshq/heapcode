import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ASK_USER_NO_ANSWER,
  DEFAULT_MAX_ITERATIONS,
  McpManager,
  METHODS,
  SEARCH_PRESETS,
  WEB_SEARCH_SECRET_NAME,
  askUserAnswerMessage,
  describeRole,
  providerPresets,
  resolveCapabilities,
  type AgentEvent,
  type AgentEventParams,
  type AgentRunParams,
  type AgentRunResult,
  type Conversation,
  type KeyRequestParams,
  type KeyRequestResult,
  type ModelInfo,
  type PermissionRequestResult,
  type ProviderProfileConfig,
  type RpcPeer,
  type ServerConnection,
  type StoredMessage,
  type ToolCall,
  type ChatSendParams,
  type DocumentExtractParams,
  type DocumentExtractResult,
  type ToolExecuteParams,
  type ToolResult,
} from '@heapcode/core';
import {
  JsonConversationStore,
  describeMcpServer,
  loadMcpServerSources,
  loadMcpServers,
  mcpNameProblem,
  parseMcpServerSpec,
  withEnv,
  SessionCheckpoint,
  WorkspaceToolExecutor,
  canonicalize,
  chatMemoryFile,
  createContextWindowResolver,
  profileContextWindow,
  projectStateDir,
  trimHistoryForAgent,
  type ConfigStore,
  SecretsMcpAuthStore,
  type SecretsStore,
} from '@heapcode/host';
import {
  ARTIFACT_KINDS,
  ArtifactStore,
  CREATE_ARTIFACT_TOOL,
  acceptImages,
  isArtifactKind,
  listDirectory,
  mergeProfile,
  readWorkspaceFile,
  clipArgs,
  describeCall,
  listFolders,
  toUiMessages,
  type DaemonHello,
  type HostSession,
  type WorkspaceStore,
} from '@heapcode/web-host';
import { UI_MODEL_ROLES } from '@heapcode/web-host/protocol';
import type { Artifact } from '@heapcode/web-host';
import { startMcpSignIn, storedTokenNames, type McpLoginRegistry } from '@heapcode/web-host';
import type { UiEventParams, UiMessage } from '@heapcode/web-host/protocol';
import {
  IMAGE_MAX_BYTES,
  chatExtractors,
  describeMissingParsers,
  exifSummary,
  imageMediaType,
  isImage,
} from './extractors.js';
import {
  VERIFY_SYSTEM_PROMPT,
  buildProvenance,
  formatEvidence,
  isGroundedAnswer,
  parseVerification,
  splitHits,
  type Evidence,
  type Grounding,
} from './grounding.js';
import { ChatMemory, memorySection } from './memory.js';
import { CHAT_METHODS, CHAT_PROTOCOL_VERSION } from './protocol.js';
import type {
  ChatArtifactMeta,
  ChatArtifactResult,
  ChatArtifactsResult,
  ChatAskUserParams,
  ChatFileTreeResult,
  ChatReadFileResult,
  ChatSaveArtifactResult,
  ChatConnectionModelsResult,
  ChatForgetParams,
  ChatGroundingParams,
  ChatMemoryResult,
  ChatProbeProviderParams,
  ChatProbeProviderResult,
  ChatSaveProfileParams,
  ChatSetRoleParams,
  ChatAskUserResult,
  ChatPermissionParams,
  ChatPermissionResult,
  ChatBrowseFoldersParams,
  ChatBrowseFoldersResult,
  ChatConversationMeta,
  ChatHelloParams,
  ChatHelloResult,
  ChatIndexStatus,
  ChatListModelsParams,
  ChatListModelsResult,
  ChatOpenConversationParams,
  ChatOpenConversationResult,
  ChatRecentFoldersResult,
  ChatSendMessageParams,
  ChatSendMessageResult,
  ChatSetFolderParams,
  ChatSetFolderResult,
  ChatSetModelParams,
  ChatSettings,
  ChatState,
} from './protocol.js';
import { CHAT_SYSTEM_PROMPT } from './prompt.js';
import { CHAT_TOOL_NAMES, chatToolDefinitions, permissionFor } from './tools.js';

/**
 * The three outcomes of trying to read a path as a document.
 *
 * Distinguished because the two callers want different things from a failure:
 * the index must store nothing, while the model must be told, or it treats an
 * unreadable scan as an empty file and answers from the silence.
 */
type DocumentRead =
  | { kind: 'text'; text: string }
  | { kind: 'unreadable'; format?: string }
  | { kind: 'not-a-document' };

/** Metadata only — content is fetched per version, so a list stays cheap. */
function toArtifactMeta(a: Artifact): ChatArtifactMeta {
  return {
    id: a.id,
    title: a.title,
    kind: a.kind,
    language: a.language,
    versions: a.versions.length,
    updatedAt: a.versions.at(-1)?.createdAt ?? 0,
  };
}

/** Extensions this host declares to the daemon — the parsers' plus the images. */
const DOCUMENT_EXTENSIONS = [
  '.txt', '.text', '.csv', '.tsv', '.log', '.vtt', '.srt', '.tex', '.pdf', '.docx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
];

/**
 * What the vision model is asked for.
 *
 * Specific and literal on purpose: this text is what the photo will be
 * *found* by, so "a receipt from a hardware shop for 34.90 dated 3 March"
 * earns its place in an index and "a photograph of a piece of paper" does not.
 */
const DESCRIBE_IMAGE_PROMPT =
  'Describe this image so it can be found by search later. Be concrete and literal: name what is in it, ' +
  'and transcribe any text, numbers, dates, totals or names you can read, exactly as they appear. If it is ' +
  'a document, receipt or screenshot, the text on it matters more than the scene. Two or three sentences. ' +
  'No preamble, no hedging, and do not say what you cannot tell.';

/**
 * Evidence rows carried into a verification prompt — most recent wins.
 *
 * Rows are per hit rather than per result block, so this is a budget of
 * snippets, not of tool calls: one `semantic_search` can contribute six.
 */
const MAX_EVIDENCE = 24;

/** Per-run event retention for replay after a browser refresh. */
const REPLAY_BUFFER = 2_000;
/** How much of a tool's output is kept on the stored chip. */
const TOOL_SUMMARY_CHARS = 2_000;

export interface ChatSessionDeps {
  /** The folder this session reads. Canonicalized by the caller. */
  root: string;
  config: ConfigStore;
  secrets: SecretsStore;
  connect: (hello: DaemonHello) => Promise<ServerConnection>;
  clientVersion?: string;
  /**
   * OAuth logins in flight. The same registry the code product uses: chat is
   * mounted on that server, so one `/oauth/callback` answers for both.
   */
  mcpLogins?: McpLoginRegistry;
  /** Recently opened folders, for the picker. */
  workspaces?: WorkspaceStore;
  /** Bound to a non-loopback address — passed down, never inferred here. */
  lan?: boolean;
  /** Overridden by tests; real hosts read it from the profile's capabilities. */
  nativeToolCalls?: boolean;
  /**
   * Where personal memory lives. Defaults to the global `chat-memory.json`.
   *
   * Injectable because the benchmark must not read it: the eval runs against
   * the real config (that is the point — a real model, a real index), and it
   * was therefore also inheriting whatever the person had asked the assistant
   * to remember, straight into the system prompt of every case. A corpus whose
   * results depend on the operator's own memory is not a baseline.
   */
  memoryFile?: string;
}

/**
 * One folder's bridge between a browser and the daemon, for Heap Chat.
 *
 * A sibling of `WebSession`, not a mode of it. The two share this shape —
 * outlive the tab, own run state, forward daemon events — and share the
 * engine underneath, but nothing about *what the agent is* crosses between
 * them: this one offers a read-only roster (`tools.ts`), replaces the system
 * prompt (`prompt.ts`), and has no checkpoint, no shadow-git, no repo map and
 * no workspace panel, because it changes nothing and there is nothing to
 * revert.
 *
 * See docs/CHAT_MODE_PLAN.md for why that separation is structural rather
 * than a filter over the coding session.
 */
export class ChatSession implements HostSession {
  private root: string;
  private connection?: ServerConnection;
  private executor?: WorkspaceToolExecutor;
  private mcp?: McpManager;
  /** Connector tools allowed for the rest of this conversation. Never stored. */
  private allowedTools = new Set<string>();
  /**
   * What the assistant has produced, under the state dir — never in the
   * folder. Rebuilt on a folder switch, like everything else derived from the
   * root.
   */
  private artifacts: ArtifactStore;
  private profile?: ProviderProfileConfig;
  private ui?: RpcPeer;

  private activeRunId?: string;
  private abort?: AbortController;

  private readonly buffers = new Map<string, UiEventParams[]>();
  private history?: JsonConversationStore;
  private conversation?: Conversation;
  private turnEntries: StoredMessage[] = [];
  private deltaAcc = '';
  private reasoningAcc = '';
  private pendingDisplay?: string;
  /**
   * What the run actually read, in the order it read it — the raw material
   * the grounding layer works from. Cleared per turn: evidence from the last
   * question is not evidence for this one.
   */
  private evidence: Evidence[] = [];
  /** Facts about the person, global rather than per folder — see memory.ts. */
  private readonly memory: ChatMemory;
  /**
   * The out-of-band model call in flight, if any — verification or an image
   * description. Its events stream over the same channel as the run's and must
   * not reach the transcript.
   */
  private verifying?: { runId: string; text: string };
  /** The text that call produced, readable after `verifying` is cleared. */
  private lastDescription = '';
  private modelOverride?: string;
  private chatModel = '';
  private indexProgress?: { embedded: number; total: number };

  private readonly contextWindowFor = createContextWindowResolver((profileName, model) =>
    this.connection
      ? this.connection.peer
          .request<{ models: ModelInfo[] }>(METHODS.listModels, { profileName, model })
          .then((r) => r.models)
      : Promise.resolve([]),
  );

  constructor(private readonly deps: ChatSessionDeps) {
    this.root = deps.root;
    this.memory = new ChatMemory(deps.memoryFile ?? chatMemoryFile());
    this.artifacts = new ArtifactStore(join(projectStateDir(deps.root), 'artifacts'));
  }

  /** The model this session's runs use — the chat role, then the profile's own. */
  private get model(): string {
    return this.modelOverride || this.chatModel || this.profile?.model || '';
  }

  get folderRoot(): string {
    return this.root;
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  /** Connects to the daemon and builds the tool executor. Idempotent. */
  async start(): Promise<void> {
    if (this.connection) return;

    const { config, secrets } = this.deps;
    const profile = await config.getActiveProfile();
    if (!profile) {
      const connections = await config.listConnections();
      throw new Error(
        connections.length > 0
          ? 'Heap Chat has no model set. Run `heapcode model set chat <connection> <model>` first.'
          : 'No provider connection configured. Run `heapcode connection add` before `heapcode chat`.',
      );
    }
    this.profile = profile;
    this.chatModel = (await config.resolve('chat'))?.model ?? profile.model;

    this.history = new JsonConversationStore(chatConversationsFile(this.root));
    this.conversation ??= { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [] };

    // A checkpoint is constructed because the executor's constructor takes
    // one, and nothing here will ever ask it to record anything: no tool on
    // this roster writes. It is not a latent write path — `CHAT_TOOL_NAMES`
    // is checked before dispatch, so a tool that is not on the list is
    // refused rather than executed.
    // MCP servers — global (~/.heapcode/config.json) merged with the folder's
    // own .heapcode/mcp.json, exactly as Heap Code loads them, because they
    // are the same config. Reconnect is idempotent.
    this.mcp ??= new McpManager(
      () => loadMcpServers(this.root, config),
      undefined,
      this.deps.clientVersion,
      new SecretsMcpAuthStore(this.deps.secrets),
      this.deps.mcpLogins?.redirectUri(),
    );
    void this.mcp.ensureConnected().catch(() => undefined);

    this.executor = new WorkspaceToolExecutor(
      this.root,
      new SessionCheckpoint(this.root),
      60_000,
      undefined,
      undefined,
      undefined,
      async () => ({
        config: (await config.load()).webSearch ?? {},
        apiKey: await secrets.getApiKey(WEB_SEARCH_SECRET_NAME),
      }),
      // The live conversation, not a copy from the store: the turn in progress
      // is only written when it finishes, and that is exactly the part a long
      // conversation is asked about.
      async (id) => (!id || id === this.conversation?.id ? this.conversation : this.history?.get(id)),
    );

    const apiKey = await secrets.getApiKey(profile.name);
    this.connection = await this.deps.connect({
      root: this.root,
      profiles: [profile],
      activeProfile: profile.name,
      roles: await config.getRoles(),
      keys: apiKey ? { [profile.name]: apiKey } : {},
      // What this host can turn into text. The daemon widens its index
      // selection by these and calls `document/extract` back for each one —
      // the parsers live here, the indexer lives there.
      documentExtensions: DOCUMENT_EXTENSIONS,
    });
    this.registerDaemonHandlers(this.connection.peer);
    void this.warmContextWindow();
    void this.startIndexing();
    await this.deps.workspaces?.record(this.root);
  }

  async close(): Promise<void> {
    this.abort?.abort();
    this.connection?.close();
    this.connection = undefined;
    this.mcp?.dispose();
  }

  /**
   * Repoint at another folder.
   *
   * Tears down and rebuilds rather than updating in place, for the reason
   * `WebSession.setWorkspace` does: an executor still jailed to the old folder
   * while the conversation store has already moved is a worse failure than a
   * slow switch. Refused mid-run — the agent is reading files in the old one.
   */
  async setFolder(path: string): Promise<void> {
    if (this.activeRunId) throw new Error('A run is in progress; stop it before switching folder.');
    const target = canonicalize(path);
    const info = await stat(target).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`Not a folder: ${path}`);
    if (target === this.root) return;

    this.connection?.close();
    this.connection = undefined;
    this.executor = undefined;
    this.mcp?.dispose();
    this.mcp = undefined;
    this.root = target;
    this.artifacts = new ArtifactStore(join(projectStateDir(target), 'artifacts'));
    this.conversation = undefined;
    this.history = undefined;
    this.turnEntries = [];
    this.deltaAcc = '';
    this.reasoningAcc = '';
    this.buffers.clear();

    await this.start();
    void this.pushState();
  }

  /**
   * Make the folder searchable without being asked.
   *
   * The difference from Heap Code is the product, not an oversight there: a
   * repo you opened in an editor has a reason to be indexed on demand, but the
   * entire point of pointing this at a folder is that its contents become
   * answerable. Waiting for a `semantic_search` to build the index means the
   * first question is answered from an empty one — which reads as "there is
   * nothing about that in this folder", the single worst wrong answer this
   * product can give.
   *
   * Incremental, not `clear`: unchanged files keep their vectors. Fired and
   * forgotten, because a first build is minutes of embedding and `start()`
   * has a page waiting on it.
   */
  private async startIndexing(): Promise<void> {
    await this.connection?.peer.request(METHODS.ragIndex, { full: true }).catch(() => undefined);
    void this.indexStatus()
      .then((s) => this.ui?.notify(CHAT_METHODS.indexChanged, s))
      .catch(() => {});
  }

  /**
   * Tear the daemon link down and build it again.
   *
   * The profile and the role table cross once, at hello, and the daemon reads
   * its own copy from then on — so a settings change that does not reconnect
   * leaves the run using the values from before the edit.
   */
  private async reconnect(): Promise<void> {
    this.connection?.close();
    this.connection = undefined;
    await this.start();
  }

  private async warmContextWindow(): Promise<void> {
    if (!this.profile) return;
    await this.contextWindowFor.resolve(this.profile, this.model).catch(() => undefined);
    void this.pushState();
  }

  // ---------------------------------------------------------------------------
  // browser side
  // ---------------------------------------------------------------------------

  attach(ui: RpcPeer): void {
    this.ui = ui;

    ui.onRequest(CHAT_METHODS.hello, async (raw): Promise<ChatHelloResult> => {
      const params = raw as ChatHelloParams;
      // Connect on hello, not at construction: a configuration error should
      // reach the page as a message rather than crash the launch.
      await this.start();
      const replay = params.resumeRunId ? this.buffers.get(params.resumeRunId) : undefined;
      return {
        protocolVersion: CHAT_PROTOCOL_VERSION,
        state: await this.state(),
        messages: toUiMessages(this.conversation?.messages ?? []),
        activeRunId: this.activeRunId,
        replay: replay ? [...replay] : undefined,
        pending: this.activeRunId ? this.pendingMessages() : undefined,
      };
    });

    ui.onRequest(CHAT_METHODS.state, async () => this.state());

    ui.onRequest(CHAT_METHODS.sendMessage, async (raw): Promise<ChatSendMessageResult> => {
      const { text, runId, images } = raw as ChatSendMessageParams;
      return this.send(text, runId, acceptImages(images));
    });

    ui.onRequest(CHAT_METHODS.cancel, async () => {
      await this.cancel();
      return null;
    });

    ui.onRequest(CHAT_METHODS.conversations, async (): Promise<ChatConversationMeta[]> => {
      const all = (await this.history?.list()) ?? [];
      return all.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        active: c.id === this.conversation?.id,
      }));
    });

    ui.onRequest(CHAT_METHODS.openConversation, async (raw): Promise<ChatOpenConversationResult> => {
      if (this.activeRunId) throw new Error('A run is in progress; stop it before switching conversation.');
      const { id } = raw as ChatOpenConversationParams;
      const found = await this.history?.get(id);
      if (!found) throw new Error('No such conversation');
      this.conversation = found;
      this.turnEntries = [];
      // A grant was given for what was happening in the other conversation.
      this.allowedTools.clear();
      return { id: found.id, messages: toUiMessages(found.messages) };
    });

    ui.onRequest(CHAT_METHODS.newConversation, async (): Promise<ChatOpenConversationResult> => {
      if (this.activeRunId) throw new Error('A run is in progress; stop it before starting a new chat.');
      this.conversation = { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [] };
      this.turnEntries = [];
      this.allowedTools.clear();
      return { id: this.conversation.id, messages: [] };
    });

    ui.onRequest(CHAT_METHODS.listModels, async (raw): Promise<ChatListModelsResult> => {
      const { profileName } = (raw ?? {}) as ChatListModelsParams;
      const res = await this.connection!.peer.request<{ models: ModelInfo[] }>(METHODS.listModels, {
        profileName: profileName ?? this.profile?.name,
      });
      return { models: res.models.map((m) => ({ id: m.id, contextLength: m.contextLength })) };
    });

    ui.onRequest(CHAT_METHODS.setModel, async (raw) => {
      const { model } = raw as ChatSetModelParams;
      this.modelOverride = model || undefined;
      void this.warmContextWindow();
      void this.pushState();
      return null;
    });

    ui.onRequest(CHAT_METHODS.settings, async (): Promise<ChatSettings> => this.settings());

    ui.onRequest(CHAT_METHODS.recentFolders, async (): Promise<ChatRecentFoldersResult> => ({
      current: this.root,
      recent: (await this.deps.workspaces?.list()) ?? [],
      home: homedir(),
    }));

    ui.onRequest(CHAT_METHODS.browseFolders, async (raw): Promise<ChatBrowseFoldersResult> => {
      const { path } = (raw ?? {}) as ChatBrowseFoldersParams;
      return listFolders(path ?? this.root);
    });

    ui.onRequest(CHAT_METHODS.setFolder, async (raw): Promise<ChatSetFolderResult> => {
      const { path } = raw as ChatSetFolderParams;
      await this.setFolder(path);
      return { state: await this.state(), messages: toUiMessages(this.conversation?.messages ?? []) };
    });

    ui.onRequest(CHAT_METHODS.indexStatus, async (): Promise<ChatIndexStatus> => this.indexStatus());

    // ---- settings ----
    //
    // The same edits Heap Code's dialog makes, against the same global store.
    // Deliberately not a reduced set: a connection added here has to be the
    // connection the other product sees, because there is one config file and
    // one role table.

    ui.onRequest(CHAT_METHODS.saveProfile, async (raw) => {
      const { profile, apiKey } = raw as ChatSaveProfileParams;
      const next = mergeProfile(await this.deps.config.getProfile(profile.name), profile);
      await this.deps.config.saveProfile(next);
      if (apiKey) await this.deps.secrets.setApiKey(profile.name, apiKey);
      if (profile.name === this.profile?.name) {
        this.profile = (await this.deps.config.getProfile(profile.name)) ?? next;
        // The daemon was handed the profile once, at hello, and reads its own
        // copy for the rest of the session — so an edit that is not followed
        // by a reconnect runs the profile as it was before the edit, with
        // nothing anywhere saying so.
        await this.reconnect();
      }
      void this.pushState();
      return null;
    });

    ui.onRequest(CHAT_METHODS.deleteProfile, async (raw) => {
      const { name } = raw as { name: string };
      await this.deps.config.deleteProfile(name);
      await this.deps.secrets.deleteApiKey(name).catch(() => undefined);
      void this.pushState();
      return null;
    });

    ui.onRequest(CHAT_METHODS.useProfile, async (raw) => {
      const { name } = raw as { name: string };
      await this.deps.config.setActiveProfile(name);
      this.profile = (await this.deps.config.getActiveProfile()) ?? this.profile;
      this.modelOverride = undefined;
      await this.reconnect();
      void this.pushState();
      return null;
    });

    ui.onRequest(CHAT_METHODS.setRole, async (raw) => {
      const { role, assignment } = raw as ChatSetRoleParams;
      if (role === 'chat') {
        if (!assignment) throw new Error('Chat is what the other roles inherit from, so it cannot be cleared.');
        await this.deps.config.setChatModel(assignment.connection, assignment.model);
        this.profile = (await this.deps.config.getActiveProfile()) ?? this.profile;
        this.modelOverride = undefined;
      } else {
        await this.deps.config.setRole(role, assignment);
      }
      this.chatModel = (await this.deps.config.resolve('chat'))?.model ?? this.profile?.model ?? '';
      // The table crossed once, at hello; reconnecting is the only way to
      // replace it. An embeddings reassignment also has to reach the index.
      await this.reconnect();
      void this.pushState();
      return null;
    });

    ui.onRequest(CHAT_METHODS.listConnectionModels, async (raw): Promise<ChatConnectionModelsResult> => {
      const { connection } = raw as { connection: string };
      const res = await this.connection!.peer
        .request<{ models: ModelInfo[] }>(METHODS.listModels, { profileName: connection })
        .catch(() => ({ models: [] as ModelInfo[] }));
      return { models: res.models.map((m) => m.id) };
    });

    ui.onRequest(CHAT_METHODS.probeProvider, async (raw): Promise<ChatProbeProviderResult> => {
      const params = raw as ChatProbeProviderParams;
      return this.connection!.peer.request<ChatProbeProviderResult>(METHODS.listModels, {
        probe: { baseUrl: params.baseUrl, apiKey: params.apiKey, preset: params.preset },
      });
    });

    ui.onRequest(CHAT_METHODS.setWebSearch, async (raw) => {
      const { provider, enabled, apiKey } = raw as { provider?: string; enabled?: boolean; apiKey?: string };
      if (apiKey !== undefined) await this.deps.secrets.setApiKey(WEB_SEARCH_SECRET_NAME, apiKey);
      const patch: Record<string, unknown> = {};
      if (provider !== undefined) patch.provider = provider;
      if (enabled !== undefined) patch.enabled = enabled;
      if (Object.keys(patch).length) await this.deps.config.saveWebSearch(patch);
      return null;
    });

    // ---- the folder, and what has been made from it ----

    ui.onRequest(CHAT_METHODS.fileTree, async (raw): Promise<ChatFileTreeResult> => {
      const { path } = (raw ?? {}) as { path?: string };
      return { path: path ?? '', entries: await listDirectory(this.root, path ?? '') };
    });

    ui.onRequest(CHAT_METHODS.readFile, async (raw): Promise<ChatReadFileResult> => {
      const { path } = raw as { path: string };
      // Shown as the text the agent sees, not as bytes: clicking a PDF here
      // must not produce FlateDecode noise, and the panel must not disagree
      // with the transcript about what a file says.
      const read = await this.readDocument(path);
      if (read.kind === 'text') return { path, content: read.text };
      if (read.kind === 'unreadable') {
        return { path, content: '', note: `No preview — this ${read.format ?? 'file'} has no readable text.` };
      }
      return { path, ...(await readWorkspaceFile(this.root, path)) };
    });

    ui.onRequest(CHAT_METHODS.artifacts, async (): Promise<ChatArtifactsResult> => ({
      artifacts: (await this.artifacts.list()).map(toArtifactMeta),
    }));

    ui.onRequest(CHAT_METHODS.artifact, async (raw): Promise<ChatArtifactResult> => {
      const { id, version } = raw as { id: string; version?: number };
      const artifact = await this.artifacts.get(id);
      if (!artifact) throw new Error(`No artifact ${id}`);
      const index = version ? version - 1 : artifact.versions.length - 1;
      const chosen = artifact.versions[index];
      if (!chosen) throw new Error(`No version ${version} of ${id}`);
      return { ...toArtifactMeta(artifact), version: index + 1, content: chosen.content };
    });

    /**
     * Save an artifact into the person's own files.
     *
     * The one path by which anything this product produces reaches the folder,
     * and it is theirs to take: they pick the name, they pick the moment. The
     * agent cannot do it, which is the whole point of artifacts here.
     */
    ui.onRequest(CHAT_METHODS.saveArtifact, async (raw): Promise<ChatSaveArtifactResult> => {
      const { id, path, version } = raw as { id: string; path: string; version?: number };
      const artifact = await this.artifacts.get(id);
      if (!artifact) throw new Error(`No artifact ${id}`);
      const chosen = artifact.versions[version ? version - 1 : artifact.versions.length - 1];
      if (!chosen) throw new Error('No such version');
      // Root-jailed by the executor, like every other path this host touches.
      const result = await this.executor!.execute({
        id: `save-artifact-${id}`,
        name: 'write_file',
        args: { path, content: chosen.content },
      });
      if (result.isError) throw new Error(result.content);
      return { path };
    });

    ui.onRequest(CHAT_METHODS.saveMcpServer, async (raw) => {
      const { name, spec, env } = raw as { name: string; spec: string; env?: string };
      const nameProblem = mcpNameProblem(name);
      if (nameProblem) throw new Error(nameProblem);
      const parsed = parseMcpServerSpec(spec);
      if ('error' in parsed) throw new Error(parsed.error);
      await this.deps.config.saveMcpServer(name.trim(), await withEnv(this.deps.config, name.trim(), parsed, env));
      await this.mcp?.ensureConnected().catch(() => undefined);
      void this.pushState();
      return null;
    });

    ui.onRequest(CHAT_METHODS.signInMcpServer, async (raw) => {
      const { name } = raw as { name: string };
      return startMcpSignIn(this.mcp!, this.deps.mcpLogins, name, () => void this.pushState());
    });

    ui.onRequest(CHAT_METHODS.signOutMcpServer, async (raw) => {
      const { name } = raw as { name: string };
      await this.mcp?.signOut(name);
      await this.mcp?.ensureConnected().catch(() => undefined);
      void this.pushState();
      return null;
    });

    ui.onRequest(CHAT_METHODS.deleteMcpServer, async (raw) => {
      const { name } = raw as { name: string };
      await this.deps.config.deleteMcpServer(name);
      await this.mcp?.ensureConnected().catch(() => undefined);
      return null;
    });

    ui.onRequest(CHAT_METHODS.memory, async (): Promise<ChatMemoryResult> => ({
      entries: await this.memory.list(),
    }));

    ui.onRequest(CHAT_METHODS.forget, async (raw) => {
      const { id } = raw as ChatForgetParams;
      await this.memory.forget(id);
      return null;
    });

    ui.onRequest(CHAT_METHODS.reindex, async () => {
      await this.connection?.peer.request(METHODS.ragIndex, { full: true }).catch(() => undefined);
      return null;
    });
  }

  detach(ui: RpcPeer): void {
    if (this.ui === ui) this.ui = undefined;
  }

  // ---------------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------------

  async state(): Promise<ChatState> {
    const profiles = await this.deps.config.listProfiles().catch(() => []);
    const withKeys = await Promise.all(
      profiles.map(async (p) => ({
        name: p.name,
        model: p.model,
        hasKey: Boolean(await this.deps.secrets.getApiKey(p.name).catch(() => undefined)),
      })),
    );
    return {
      folder: this.root,
      folderName: basename(this.root),
      profile: this.profile?.name ?? '',
      model: this.model,
      contextWindow: this.profile ? this.contextWindowFor.known(this.profile, this.model).window : undefined,
      profiles: withKeys,
      daemon: this.connection ? 'up' : 'down',
      runId: this.activeRunId,
      lan: this.deps.lan,
    };
  }

  private pushState(): void {
    void this.state()
      .then((s) => this.ui?.notify(CHAT_METHODS.stateChanged, s))
      .catch(() => {});
  }

  /**
   * The same payload Heap Code's settings dialog reads, built from the same
   * global config — because connections, the model role table and web search
   * ARE the same config. Adding a provider in one product must show up in the
   * other, and it does, because there is only one store.
   *
   * The fields this product has no concept of are sent empty rather than
   * faked: no personas, no permission mode, no sub-agents, no MCP servers, no
   * permission grants. The dialog is told not to offer those pages.
   */
  private async settings(): Promise<ChatSettings> {
    const cfg = await this.deps.config.load();
    const modelConfig = await this.deps.config.modelConfig();
    const profiles = await Promise.all(
      (await this.deps.config.listProfiles()).map(async (p) => ({
        name: p.name,
        preset: p.preset,
        baseUrl: p.baseUrl,
        model: p.model,
        temperature: p.temperature,
        hasKey: Boolean(await this.deps.secrets.getApiKey(p.name).catch(() => undefined)),
        active: p.name === this.profile?.name,
        nativeToolCalls: resolveCapabilities(p).nativeToolCalls,
        contextWindow: p.contextWindow,
        effectiveContextWindow: profileContextWindow(p),
        maxTokens: p.maxTokens,
        promptTier: p.promptTier,
      })),
    );
    return {
      personas: [],
      persona: '',
      permissionMode: '',
      subAgents: false,
      nativeToolCalls: this.profile ? resolveCapabilities(this.profile).nativeToolCalls : true,
      profiles,
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
        hasKey: Boolean(await this.deps.secrets.getApiKey(WEB_SEARCH_SECRET_NAME).catch(() => undefined)),
      },
      mcpServers: await this.listMcpServers(),
      permissionGrants: [],
    };
  }

  /** Both sources — personal config and the folder's own `.heapcode/mcp.json`. */
  private async listMcpServers(): Promise<ChatSettings['mcpServers']> {
    const { global, project } = await loadMcpServerSources(this.root, this.deps.config);
    const connected = new Set(this.mcp?.connectedServerNames() ?? []);
    const tools = this.mcp?.getToolDefinitions() ?? [];
    const signedIn = await storedTokenNames(this.deps.secrets, Object.keys({ ...global, ...project }));
    return Object.entries({ ...global, ...project }).map(([name, server]) => ({
      name,
      connected: connected.has(name),
      tools: tools.map((t) => t.name).filter((t) => t.startsWith(name.replace(/[^a-zA-Z0-9_-]/g, '_'))),
      spec: describeMcpServer(server),
      error: connected.has(name) ? undefined : this.mcp?.failureFor(name),
      needsAuth: !connected.has(name) && Boolean(this.mcp?.awaitingSignIn(name)),
      signedIn: signedIn.has(name),
      // Names only. These are credentials, and this list is on screen.
      envKeys: Object.keys(server.env ?? {}),
      project: name in project,
    }));
  }

  private async indexStatus(): Promise<ChatIndexStatus> {
    if (!this.connection) return { state: 'unconfigured', files: 0, chunks: 0 };
    const res = await this.connection.peer
      .request<{ state: string; files?: number; chunks?: number; message?: string }>(METHODS.ragStatus, {})
      .catch(() => undefined);
    if (!res) return { state: 'unconfigured', files: 0, chunks: 0 };
    // "Nothing in this folder about the deposit" and "the PDF holding it was
    // never indexed" look identical to whoever asked. Only one is true, so
    // the missing parser is surfaced rather than swallowed.
    const missing = await describeMissingParsers();
    return {
      state: (res.state as ChatIndexStatus['state']) ?? 'idle',
      files: res.files ?? 0,
      chunks: res.chunks ?? 0,
      message: res.message,
      progress: this.indexProgress,
      missingParsers: missing.length > 0 ? missing : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // running a turn
  // ---------------------------------------------------------------------------

  private async send(
    text: string,
    clientRunId?: string,
    images?: string[],
  ): Promise<ChatSendMessageResult> {
    if (!this.connection) await this.start();
    if (this.activeRunId) throw new Error('A run is already in progress.');

    const task = text.trim();
    if (!task && !images?.length) throw new Error('Nothing to send.');

    const runId = clientRunId || randomUUID();
    this.activeRunId = runId;
    this.abort = new AbortController();
    this.buffers.set(runId, []);
    this.turnEntries = [];
    this.deltaAcc = '';
    this.reasoningAcc = '';
    this.pendingDisplay = task;
    void this.pushState();

    const profile = this.profile!;
    const maxIterations = DEFAULT_MAX_ITERATIONS;
    const history = trimHistoryForAgent(this.conversation?.messages ?? []);
    // `known`, not `resolve`: sizing the window must never delay a turn behind
    // an endpoint that has stopped answering. The preset default is the same
    // fallback every host used before the lookup existed.
    const contextWindow = this.contextWindowFor.known(profile, this.model).window;

    let persisted = false;
    try {
      const { outcome } = await this.connection!.peer.request<AgentRunResult>(
        METHODS.agentRun,
        {
          runId,
          profileName: profile.name,
          model: this.model,
          task,
          history,
          images,
          workspaceName: basename(this.root),
          // The roster, and the identity that goes with it. Both are this
          // product's, sent per run — the daemon holds no opinion about which
          // agent it is running, which is exactly what lets one daemon serve
          // both products without either leaking into the other.
          // The static roster plus whatever the connected MCP servers offer.
          tools: [...chatToolDefinitions, ...(this.mcp?.getToolDefinitions() ?? [])],
          // Composed per run rather than cached: a fact remembered during this
          // conversation should be in scope for the next question in it.
          systemPrompt: CHAT_SYSTEM_PROMPT + memorySection(await this.memory.list().catch(() => [])),
          nativeToolCalls: this.deps.nativeToolCalls ?? resolveCapabilities(profile).nativeToolCalls,
          contextWindow,
          maxTokens: profile.maxTokens,
          // No sub-agents: delegation exists to parallelize work over a
          // codebase, and this roster cannot do work.
          subAgents: false,
          maxIterations,
          askToContinueAtLimit: true,
        } satisfies AgentRunParams,
        this.abort.signal,
      );
      // Live only, and knowingly so: `UiMessage` has nowhere to put a badge,
      // so a reloaded conversation shows the answer without it. Storing it in
      // an entry the transcript cannot render would be dead weight in
      // chats.json pretending to be persistence. Widening UiMessage is the
      // honest fix when a reload needs it.
      const grounding = await this.groundingFor(this.lastAnswerText()).catch(() => undefined);
      if (grounding) this.ui?.notify(CHAT_METHODS.grounding, { runId, grounding } satisfies ChatGroundingParams);
      await this.persistTurn(task, images?.length);
      persisted = true;
      return { runId, outcome, maxIterations };
    } finally {
      if (!persisted) await this.persistTurn(task, images?.length);
      this.activeRunId = undefined;
      this.abort = undefined;
      this.pendingDisplay = undefined;
      this.evidence = [];
      this.buffers.delete(runId);
      void this.pushState();
    }
  }

  /**
   * Stop whatever is running.
   *
   * Three things here are deliberate, and all three were wrong first time —
   * `WebSession.cancel` documents the same lessons, having hit them already:
   *
   * - The caller's runId is **ignored**. A browser that reconnected mid-run
   *   sends an id that no longer matches, and the click silently did nothing.
   *   There is one run per session, so "the active one" is unambiguous.
   * - `agent/cancel` is a **notification**, not a request: the daemon
   *   registers it on the notification channel (server.ts:466). Sent as a
   *   request it comes back `methodNotFound`, and a `.catch()` swallows that
   *   — so Stop looks wired up and does nothing.
   * - The local abort happens too, so `agent/run` settles even if the daemon
   *   is wedged and never answers.
   */
  async cancel(): Promise<void> {
    const target = this.activeRunId;
    if (!target) return;
    this.connection?.peer.notify(METHODS.agentCancel, { runId: target });
    this.abort?.abort();
  }

  /** The prose of the answer just produced — what grounding is computed against. */
  private lastAnswerText(): string {
    return this.turnEntries
      .filter((m) => m.role === 'assistant' && !m.ui && (m.content ?? '').trim())
      .map((m) => m.content)
      .join('\n');
  }

  /** The in-flight turn as the page should draw it — prompt plus what has arrived. */
  private pendingMessages(): UiMessage[] {
    const live: StoredMessage[] = [];
    if (this.pendingDisplay) live.push({ role: 'user', content: this.pendingDisplay } as StoredMessage);
    live.push(...this.turnEntries);
    if (this.deltaAcc.trim())
      live.push({ role: 'assistant', content: this.deltaAcc } as StoredMessage);
    return toUiMessages(live, { live: true });
  }

  private async persistTurn(task: string, imageCount?: number): Promise<void> {
    if (!this.conversation || !this.history) return;
    const user: StoredMessage = {
      role: 'user',
      content: imageCount ? `${task}\n\n[${imageCount} image${imageCount === 1 ? '' : 's'} attached]` : task,
    } as StoredMessage;
    this.conversation.messages.push(user, ...this.turnEntries);
    this.conversation.updatedAt = Date.now();
    if (this.conversation.title === 'New chat' && task) {
      this.conversation.title = task.slice(0, 60);
    }
    this.turnEntries = [];
    await this.history.save(this.conversation).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // daemon side
  // ---------------------------------------------------------------------------

  private registerDaemonHandlers(peer: RpcPeer): void {
    peer.onRequest(METHODS.toolExecute, async (raw, signal): Promise<ToolResult> => {
      const { call } = raw as ToolExecuteParams;
      return this.executeTool(call, signal);
    });

    /**
     * Granted for anything on the roster, denied for anything else.
     *
     * Nothing on this roster can destroy anything. `remember` is the only
     * `write`, and what it writes is the assistant's own memory, never the
     * folder — not a prompt-worthy action, since the person just asked for it,
     * and the control that helps is the reviewable, deletable list in the
     * sidebar. `web_search` and `fetch_url` are `execute` because reaching the
     * network is its own risk; both are opt-in by configuration, and neither
     * can change anything locally.
     *
     * The check is on the *name*, not on the class the daemon reports, so a
     * tool that reached this host without being on the roster is refused here
     * as well as in `executeTool`.
     */
    peer.onRequest(METHODS.permissionRequest, async (raw): Promise<PermissionRequestResult> => {
      const { call } = raw as { call: ToolCall };
      // Nothing on this roster changes the folder, so there is nothing to ask
      // about.
      const outcome = permissionFor(
        call.name,
        Boolean(this.mcp?.isMcpTool(call.name)),
        this.allowedTools.has(call.name),
      );
      if (outcome === 'grant') return { granted: true };
      if (outcome === 'deny') return { granted: false };
      return { granted: await this.askPermission(call) };
    });

    // Nothing to snapshot: no tool on this roster changes a file.
    peer.onRequest(METHODS.snapshotBefore, async () => null);

    /**
     * Read one non-code file for the index.
     *
     * The path arrives from the daemon, so it is resolved under this
     * session's folder and anything that escapes is refused. The daemon only
     * ever sends paths it walked inside that folder, but "the caller is
     * well-behaved" is not a boundary — this is a filesystem read driven by a
     * path this process did not choose.
     */
    peer.onRequest(METHODS.documentExtract, async (raw): Promise<DocumentExtractResult> => {
      const { path } = raw as DocumentExtractParams;
      const read = await this.readDocument(path);
      // Only real text reaches the index. An explanation of why a file could
      // not be read is not that file's content, and indexing it would make
      // the folder searchable for words nobody wrote.
      return read.kind === 'text' ? { text: read.text } : {};
    });

    peer.onRequest(METHODS.keyRequest, async (raw): Promise<KeyRequestResult> => {
      const { profileName } = raw as KeyRequestParams;
      const target = await this.deps.config.getProfile(profileName);
      if (!target) return {};
      return { profile: target, apiKey: await this.deps.secrets.getApiKey(profileName) };
    });

    peer.onNotification(METHODS.ragEvent, (raw) => {
      const { event } = raw as { event: { kind: string; embedded?: number; total?: number } };
      this.indexProgress =
        event.kind === 'progress' ? { embedded: event.embedded ?? 0, total: event.total ?? 0 } : undefined;
      void this.indexStatus()
        .then((s) => this.ui?.notify(CHAT_METHODS.indexChanged, s))
        .catch(() => {});
    });

    peer.onNotification(METHODS.agentEvent, (raw) => {
      const params = raw as AgentEventParams;
      // The verification pass streams over the same channel. Its text is a
      // JSON verdict about the answer, not part of it, so it is collected
      // here and never reaches the transcript or the browser.
      if (this.verifying && params.runId === this.verifying.runId) {
        const { event } = params;
        if (event.type === 'text' || event.type === 'text_delta') this.verifying.text += event.text;
        this.lastDescription = this.verifying.text;
        return;
      }
      this.recordForHistory(params.event);
      const buffer = this.buffers.get(params.runId);
      if (buffer) {
        buffer.push(params);
        if (buffer.length > REPLAY_BUFFER) buffer.splice(0, buffer.length - REPLAY_BUFFER);
      }
      this.ui?.notify(CHAT_METHODS.event, params satisfies UiEventParams);
    });
  }

  /**
   * Dispatch a tool call.
   *
   * The roster check is first and is not defensive programming for its own
   * sake: the daemon is told which tools exist per run, but this host is what
   * actually has hands. A model that hallucinates `run_command` — or a future
   * bug that sends the wrong roster — gets an error string, not execution.
   */
  private async executeTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    if (!CHAT_TOOL_NAMES.has(call.name) && !this.mcp?.isMcpTool(call.name)) {
      return {
        id: call.id,
        name: call.name,
        content:
          `\`${call.name}\` is not available in Heap Chat. This assistant reads files and answers ` +
          'questions about them; it cannot change anything or run commands.',
        isError: true,
      };
    }
    if (call.name === 'remember') {
      const entry = await this.memory.remember(String(call.args.fact ?? ''));
      return {
        id: call.id,
        name: call.name,
        // "Already knew that" is a real and useful answer: it stops the model
        // re-asserting the fact as though it were new information.
        content: entry ? `Remembered: ${entry.text}` : 'Nothing saved — already known, or empty.',
      };
    }

    if (call.name === CREATE_ARTIFACT_TOOL.name) return this.createArtifact(call);

    if (this.mcp?.isMcpTool(call.name)) {
      try {
        return { id: call.id, name: call.name, content: await this.mcp.call(call.name, call.args) };
      } catch (err) {
        return { id: call.id, name: call.name, content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }

    // Answered by the person through the page, not by the filesystem.
    if (call.name === 'ask_user') {
      return { id: call.id, name: call.name, content: await this.askUser(call, signal) };
    }

    // `read_file` on a PDF or a .docx would hand the model the container's
    // bytes — a wall of FlateDecode noise it will either quote as if it were
    // content or give up on. Retrieval already returns extracted text, so a
    // direct read must too, or the two disagree about what the file says.
    if (call.name === 'read_file') {
      const path = String(call.args.path ?? '');
      const read = await this.readDocument(path);
      if (read.kind === 'text') return { id: call.id, name: call.name, content: read.text };
      if (read.kind === 'unreadable') {
        // Told plainly rather than returned as empty: "I could not read this"
        // and "this file is empty" lead the model to opposite conclusions,
        // and only one of them is honest about a scanned or encrypted PDF.
        return {
          id: call.id,
          name: call.name,
          content:
            `Could not read ${path}. It is a ${read.format ?? 'document'} file with no extractable ` +
            'text — it may be encrypted, malformed, or a scan with no text layer. Say so rather than ' +
            'guessing at its contents.',
          isError: true,
        };
      }
    }

    return this.executor!.execute(call, signal);
  }

  /**
   * A document as text, or undefined when this path is not one.
   *
   * Shares the traversal guard with `document/extract` rather than repeating
   * it: both take a path this process did not choose — one from the daemon,
   * one from the model — and a second copy of a security check is a second
   * place for it to be wrong.
   */
  private async readDocument(path: string): Promise<DocumentRead> {
    if (isImage(path)) return this.describeImage(path);
    const extractor = chatExtractors.find((e) => e.handles(path));
    if (!extractor) return { kind: 'not-a-document' };
    try {
      const full = canonicalize(resolve(this.root, path));
      const rel = relative(this.root, full);
      if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') return { kind: 'unreadable' };
      const bytes = await readFile(full);
      if (extractor.maxBytes && bytes.byteLength > extractor.maxBytes) return { kind: 'unreadable' };
      const text = await extractor.extract(path, bytes);
      return text === undefined
        ? { kind: 'unreadable', format: extractor.name }
        : { kind: 'text', text };
    } catch {
      return { kind: 'unreadable', format: extractor.name };
    }
  }

  /**
   * An image, as text: what the vision model sees, plus what the file says
   * about itself.
   *
   * Not a `DocumentExtractor` like the others, because describing an image
   * costs a model call and the extractor contract is deliberately pure — this
   * is the one place in the host that has both the bytes and a provider.
   *
   * The description is what makes a photo findable at all: without it a
   * receipt is a filename. EXIF is added because it is the part a model cannot
   * infer and a person actually searches on — "the photos from March" is a
   * date, not a description.
   *
   * Costs one call per image per *change*: the indexer caches by file hash, so
   * a re-index does not re-describe anything that has not been edited.
   */
  private async describeImage(path: string): Promise<DocumentRead> {
    const mediaType = imageMediaType(path);
    if (!mediaType || !this.connection || !this.profile) return { kind: 'unreadable', format: 'image' };
    // Gated on the endpoint's declared capability, the same way tool calls
    // are. Sending an image to a text-only model does not fail cleanly: it
    // answers anyway, describing an image it never saw, and that description
    // goes into the index as if it were what the photo shows. A wrong
    // description is worse than no description, because it is searchable.
    if (!resolveCapabilities(this.profile).vision) return { kind: 'unreadable', format: 'image' };
    try {
      const full = canonicalize(resolve(this.root, path));
      const rel = relative(this.root, full);
      if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') return { kind: 'unreadable', format: 'image' };
      const bytes = await readFile(full);
      if (bytes.byteLength > IMAGE_MAX_BYTES) return { kind: 'unreadable', format: 'image' };

      const runId = `describe_${randomUUID()}`;
      this.verifying = { runId, text: '' };
      try {
        await this.connection.peer.request(METHODS.chatSend, {
          runId,
          profileName: this.profile.name,
          model: this.model,
          maxTokens: 300,
          temperature: 0,
          messages: [
            { role: 'system', content: DESCRIBE_IMAGE_PROMPT },
            {
              role: 'user',
              content: `Describe this image (${path}).`,
              images: [`data:${mediaType};base64,${bytes.toString('base64')}`],
            },
          ],
        } satisfies ChatSendParams);
      } finally {
        this.verifying = undefined;
      }

      const described = this.lastDescription.trim();
      // A model with no vision returns nothing useful here. Indexing an empty
      // or apologetic string would make the photo searchable for the wrong
      // words, which is worse than leaving it unindexed.
      if (described.length < 12) return { kind: 'unreadable', format: 'image' };

      const exif = await exifSummary(bytes);
      return { kind: 'text', text: exif ? `${described}\n\n${exif}` : described };
    } catch {
      return { kind: 'unreadable', format: 'image' };
    }
  }

  /** Store an artifact and tell the page about it. */
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
      this.ui?.notify(CHAT_METHODS.artifactChanged, toArtifactMeta(artifact));
      return {
        id: call.id,
        name: call.name,
        content: `Created "${artifact.title}" (${artifact.kind}), shown beside the conversation. The person can save it into their files from there.`,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Ask the person a question, through the page. Fails closed with no page attached. */
  /**
   * Ask before running a connector's tool.
   *
   * Fails closed. No UI attached means nobody can answer, and a silent yes is
   * the one outcome this exists to prevent — so a run with no one watching
   * gets a refusal the model can report rather than a write nobody saw.
   *
   * "Allow for this chat" is remembered in memory only, and only for the
   * conversation it was given in: a grant is a judgement about what is
   * happening now, not a setting.
   */
  private async askPermission(call: ToolCall): Promise<boolean> {
    if (this.allowedTools.has(call.name)) return true;
    if (!this.ui) return false;
    const server = call.name.slice('mcp__'.length).split('__')[0] ?? '';
    const answer = await this.ui
      .request<ChatPermissionResult>(CHAT_METHODS.permission, {
        runId: this.activeRunId ?? '',
        callId: call.id,
        tool: call.name,
        server,
        args: call.args,
      } satisfies ChatPermissionParams)
      .catch(() => undefined);
    if (!answer?.granted) return false;
    if (answer.remember) this.allowedTools.add(call.name);
    return true;
  }

  private async askUser(call: ToolCall, signal?: AbortSignal): Promise<string> {
    if (!this.ui) return ASK_USER_NO_ANSWER;
    const answer = await this.ui
      .request<ChatAskUserResult>(
        CHAT_METHODS.askUser,
        {
          runId: this.activeRunId ?? '',
          callId: call.id,
          question: String(call.args.question ?? ''),
          options: Array.isArray(call.args.options) ? (call.args.options as string[]) : undefined,
          blocksAction: Boolean(call.args.blocksAction),
        } satisfies ChatAskUserParams,
        signal,
      )
      .catch(() => undefined);
    return answer?.answer ? askUserAnswerMessage(answer.answer) : ASK_USER_NO_ANSWER;
  }

  /**
   * Record what a tool returned as evidence, tagged with where it came from.
   *
   * `search` counts, and an earlier version of this was wrong to exclude it on
   * the theory that it returns paths rather than text. It returns the matching
   * line with two lines of context either side — often the most precise
   * evidence in the whole run, because it is the exact line holding the number
   * that was asked about. The eval caught this: a correct invoice answer came
   * back with no badge at all.
   *
   * Both search tools put the filename in the block itself, so the source is
   * read out of the result rather than guessed from the call arguments.
   */
  private collectEvidence(name: string, args: Record<string, unknown> | undefined, content: string): void {
    if (!content.trim()) return;
    let source: string | undefined;
    switch (name) {
      case 'read_file':
        source = typeof args?.path === 'string' ? args.path : undefined;
        break;
      case 'fetch_url':
        source = typeof args?.url === 'string' ? args.url : undefined;
        break;
      case 'search':
      case 'semantic_search': {
        // One row per hit, not per block. A block spanning four files carried
        // as a single row makes every number in it look like it came from all
        // four, which is exactly the claim this feature exists to make
        // precisely.
        for (const hit of splitHits(content)) this.pushEvidence(hit);
        return;
      }
      default:
        return;
    }
    if (!source) return;
    this.pushEvidence({ source, text: content });
  }

  /**
   * Bounded: a run that reads forty files must not carry forty file bodies
   * into a verification prompt, and the most recent reads are the ones the
   * answer is most likely built on.
   */
  private pushEvidence(item: Evidence): void {
    this.evidence.push(item);
    if (this.evidence.length > MAX_EVIDENCE) this.evidence.shift();
  }

  /**
   * What the finished answer is standing on.
   *
   * Provenance first, because it is mechanical and free: every distinctive
   * number in the answer either appears in something the run read or it does
   * not, and no model call can be wrong about that. Verification second,
   * because it costs a model call and can be wrong in both directions — so it
   * annotates the answer and never suppresses it.
   */
  private async groundingFor(answer: string): Promise<Grounding | undefined> {
    if (!answer.trim() || this.evidence.length === 0) return undefined;
    const provenance = buildProvenance(answer, this.evidence);
    if (!isGroundedAnswer(this.evidence, provenance)) return undefined;

    const sources = [...new Set(this.evidence.map((e) => e.source))].filter(Boolean);
    const grounding: Grounding = { sources, provenance };

    const checked = await this.verify(answer).catch(() => undefined);
    if (checked?.verdict) {
      grounding.verdict = checked.verdict;
      grounding.issues = checked.issues;
      // The verifier's own list of what the answer leans on is better than
      // "everything the run happened to open", which is what the sources
      // above are. Only trusted when it names files we actually read.
      const used = (checked.used ?? []).filter((u) => this.evidence.some((e) => e.text.includes(u) || e.source === u));
      if (used.length > 0) grounding.sources = used;
    }
    return grounding;
  }

  /**
   * A second model pass over the answer against the evidence.
   *
   * Uses `chat/send` rather than `agent/run`: this is one question with no
   * tools, and running it through the agent loop would cost several model
   * calls to ask something that fits in one.
   */
  private async verify(answer: string): Promise<ReturnType<typeof parseVerification> | undefined> {
    if (!this.connection || !this.profile) return undefined;
    const runId = `verify_${randomUUID()}`;
    // Routed by runId through the one agent-event handler rather than by
    // registering a second one: `onNotification` replaces by method name, so
    // a temporary handler silently displaces the transcript's until it is put
    // back — a restore that a thrown error skips.
    this.verifying = { runId, text: '' };
    try {
      await this.connection.peer.request(METHODS.chatSend, {
        runId,
        profileName: this.profile.name,
        model: this.model,
        maxTokens: 400,
        temperature: 0,
        messages: [
          { role: 'system', content: VERIFY_SYSTEM_PROMPT },
          { role: 'user', content: `EVIDENCE:\n${formatEvidence(this.evidence)}\n\nANSWER:\n${answer}` },
        ],
      } satisfies ChatSendParams);
      return parseVerification(this.verifying.text);
    } finally {
      this.verifying = undefined;
    }
  }

  /** Folds one live event into the turn that will be written to history. */
  private recordForHistory(event: AgentEvent): void {
    switch (event.type) {
      case 'text':
        this.turnEntries.push({ role: 'assistant', content: event.text } as StoredMessage);
        return;
      case 'text_delta':
        this.deltaAcc += event.text;
        return;
      case 'text_end':
        if (this.deltaAcc.trim())
          this.turnEntries.push({ role: 'assistant', content: this.deltaAcc } as StoredMessage);
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
      case 'tool_call':
        this.turnEntries.push({
          role: 'assistant',
          content: '',
          ui: {
            tool: {
              id: event.id,
              name: event.name,
              description: describeCall(event.name, event.args),
              args: clipArgs(event.args),
              ok: true,
            },
          },
        } as StoredMessage);
        return;
      case 'tool_result': {
        for (let i = this.turnEntries.length - 1; i >= 0; i--) {
          const tool = this.turnEntries[i]!.ui?.tool;
          if (tool && tool.id === event.id) {
            tool.ok = !event.isError;
            tool.summary = event.content.slice(0, TOOL_SUMMARY_CHARS);
            if (!event.isError) this.collectEvidence(tool.name, tool.args, event.content);
            return;
          }
        }
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Where a folder's chats live.
 *
 * Under the folder's state dir like Heap Code's, but in `chats.json`, not
 * `conversations.json`. Separate stores is a decision, not an accident
 * (docs/CHAT_MODE_PLAN.md): opening a folder that happens to be a repo must
 * not show you the coding sessions you had in it, and vice versa.
 */
export function chatConversationsFile(root: string): string {
  return join(projectStateDir(root), 'chats.json');
}
