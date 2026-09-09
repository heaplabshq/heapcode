import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ASK_USER_NO_ANSWER,
  DEFAULT_MAX_ITERATIONS,
  METHODS,
  WEB_SEARCH_SECRET_NAME,
  askUserAnswerMessage,
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
  type DocumentExtractParams,
  type DocumentExtractResult,
  type ToolExecuteParams,
  type ToolResult,
} from '@heapcode/core';
import {
  JsonConversationStore,
  SessionCheckpoint,
  WorkspaceToolExecutor,
  canonicalize,
  createContextWindowResolver,
  projectStateDir,
  trimHistoryForAgent,
  type ConfigStore,
  type SecretsStore,
} from '@heapcode/host';
import {
  acceptImages,
  clipArgs,
  describeCall,
  listFolders,
  toUiMessages,
  type DaemonHello,
  type HostSession,
  type WorkspaceStore,
} from '@heapcode/web-host';
import type { UiEventParams, UiMessage } from '@heapcode/web-host/protocol';
import { chatExtractors, describeMissingParsers } from './extractors.js';
import { CHAT_METHODS, CHAT_PROTOCOL_VERSION } from './protocol.js';
import type {
  ChatAskUserParams,
  ChatAskUserResult,
  ChatBrowseFoldersParams,
  ChatBrowseFoldersResult,
  ChatCancelParams,
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
import { CHAT_TOOL_NAMES, chatToolDefinitions } from './tools.js';

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

/** Extensions this host declares to the daemon — derived from the extractors themselves. */
const DOCUMENT_EXTENSIONS = ['.txt', '.text', '.csv', '.tsv', '.log', '.vtt', '.srt', '.tex', '.pdf', '.docx'];

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
  /** Recently opened folders, for the picker. */
  workspaces?: WorkspaceStore;
  /** Bound to a non-loopback address — passed down, never inferred here. */
  lan?: boolean;
  /** Overridden by tests; real hosts read it from the profile's capabilities. */
  nativeToolCalls?: boolean;
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
    this.root = target;
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

    ui.onRequest(CHAT_METHODS.cancel, async (raw) => {
      const { runId } = raw as ChatCancelParams;
      if (runId && runId !== this.activeRunId) return null;
      this.abort?.abort();
      await this.connection?.peer.request(METHODS.agentCancel, { runId: this.activeRunId }).catch(() => undefined);
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
      return { id: found.id, messages: toUiMessages(found.messages) };
    });

    ui.onRequest(CHAT_METHODS.newConversation, async (): Promise<ChatOpenConversationResult> => {
      if (this.activeRunId) throw new Error('A run is in progress; stop it before starting a new chat.');
      this.conversation = { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [] };
      this.turnEntries = [];
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

  private async settings(): Promise<ChatSettings> {
    const cfg = await this.deps.config.load();
    const profiles = await this.deps.config.listProfiles().catch(() => []);
    const embeddings = await this.deps.config.resolve('embeddings').catch(() => undefined);
    return {
      profiles: await Promise.all(
        profiles.map(async (p) => ({
          name: p.name,
          model: p.model,
          baseUrl: p.baseUrl,
          preset: p.preset,
          hasKey: Boolean(await this.deps.secrets.getApiKey(p.name).catch(() => undefined)),
        })),
      ),
      activeProfile: this.profile?.name ?? '',
      webSearch: Boolean(cfg.webSearch?.enabled),
      embeddingsConfigured: Boolean(embeddings?.model),
    };
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
          tools: chatToolDefinitions,
          systemPrompt: CHAT_SYSTEM_PROMPT,
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
      await this.persistTurn(task, images?.length);
      persisted = true;
      return { runId, outcome, maxIterations };
    } finally {
      if (!persisted) await this.persistTurn(task, images?.length);
      this.activeRunId = undefined;
      this.abort = undefined;
      this.pendingDisplay = undefined;
      this.buffers.delete(runId);
      void this.pushState();
    }
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
     * Every tool on this roster is `read` class, so there is nothing to ask
     * about — granting is the honest answer, not a rubber stamp. The check is
     * on the *name* rather than the class the daemon reports, so a tool that
     * somehow reached this host without being on the roster is denied here as
     * well as refused in `executeTool`.
     */
    peer.onRequest(METHODS.permissionRequest, async (raw): Promise<PermissionRequestResult> => {
      const { call } = raw as { call: ToolCall };
      return { granted: CHAT_TOOL_NAMES.has(call.name) };
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
    if (!CHAT_TOOL_NAMES.has(call.name)) {
      return {
        id: call.id,
        name: call.name,
        content:
          `\`${call.name}\` is not available in Heap Chat. This assistant reads files and answers ` +
          'questions about them; it cannot change anything or run commands.',
        isError: true,
      };
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

  /** Ask the person a question, through the page. Fails closed with no page attached. */
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
