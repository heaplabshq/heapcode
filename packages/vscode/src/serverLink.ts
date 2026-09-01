import * as vscode from 'vscode';
import {
  METHODS,
  connectToServer,
  type AgentEvent,
  type AgentEventParams,
  type ChatSendParams,
  type ChatSendResult,
  type CommitMessageParams,
  type CommitMessageResult,
  type ConnectOptions,
  type KeyRequestParams,
  type KeyRequestResult,
  type ListModelsParams,
  type ListModelsResult,
  type ModelInfo,
  type RagEvent,
  type RagEventParams,
  type RagIndexParams,
  type RagIndexResult,
  type RagQueryParams,
  type RagQueryResult,
  type RagStatusResult,
  type ReviewConfirmParams,
  type ReviewConfirmResult,
  type ReviewEvent,
  type ReviewEventParams,
  type ReviewRunParams,
  type ReviewRunResult,
  type ServerConnection,
  type ToolCall,
  type ToolExecuteParams,
  type ToolResult,
} from '@heapcode/core';
import type { ProfileManager } from './profileManager.js';

/** How this host reaches the core server; `daemonEntry` is set by extension.ts, the rest by tests. */
export interface ServerLinkOptions extends ConnectOptions {
  /** Reported to the server's log only, never used for authorization. */
  clientVersion?: string;
}

/** What a chat turn needs from its caller while it runs. */
export interface ChatTurnHandlers {
  onEvent(event: AgentEvent): void;
  /** Runs an ask-mode tool. Absent when the turn offers no tools. */
  execute?(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}

/** What a PR review needs from its caller while it runs. */
export interface ReviewHandlers {
  onEvent(event: ReviewEvent): void;
  /** Runs one of the review's read-only tools. */
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  /** Show the preview and ask whether to post. False cancels; nothing is posted. */
  confirm(confirmation: ReviewConfirmParams['confirmation']): Promise<boolean>;
}

/**
 * The extension's connection for everything that is not an agent run: chat
 * turns, model listing, and the semantic index.
 *
 * Separate from AgentController's connection on purpose. `tool/execute` is one
 * handler per peer, and chat's executor is deliberately unlike the agent's —
 * no permission engine, no MCP dispatch, no shadow-git snapshots. Sharing one
 * peer would mean a single handler demultiplexing by runId into two unrelated
 * worlds, which couples the chat view to the controller's internals for no
 * gain. Two connections means two sessions, which §2 of the protocol design
 * already treats as the normal case; the same key being pushed twice inside
 * one process is no new exposure.
 */
export class ServerLink {
  private connection?: ServerConnection;
  private connectedProfile?: string;
  /** Set when profile config changes under us; the next call reconnects, since profiles are pushed at hello. */
  private stale = false;
  /** The turn currently streaming, so one set of handlers serves every turn. */
  private activeTurn?: { runId: string } & ChatTurnHandlers;
  /** The review currently running, for the same reason. */
  private activeReview?: { runId: string } & ReviewHandlers;
  /** Indexing progress/state listeners — the status bar is the only one. */
  private readonly ragListeners = new Set<(event: RagEvent) => void>();

  constructor(
    private readonly profiles: ProfileManager,
    private readonly log: vscode.OutputChannel,
    private readonly options: ServerLinkOptions,
  ) {}

  markProfilesChanged(): void {
    this.stale = true;
  }

  dispose(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  /**
   * Opened lazily and kept afterwards, matching AgentController: most windows
   * activate the extension and never send a chat message, and connecting
   * spawns the server.
   */
  private async ensureConnection(profileName: string): Promise<ServerConnection> {
    const existing = this.connection;
    if (existing && !this.stale && this.connectedProfile === profileName) return existing;
    existing?.close();
    this.stale = false;

    const profile = this.profiles.getProfiles().find((p) => p.name === profileName);
    const apiKey = profile ? await this.profiles.getApiKey(profile) : undefined;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const root = folder?.fsPath ?? process.cwd();
    const connection = await connectToServer(
      {
        client: { name: 'heapcode-vscode-chat', version: this.options.clientVersion },
        root,
        // The server indexes the workspace for itself, which only works when
        // the root is a real directory. A virtual or remote-scheme workspace
        // says so and gets no semantic index, rather than having the server
        // index whatever `fsPath` happened to produce — the same posture
        // ShadowGit already takes (extension.ts:85).
        localRoot: !folder || folder.scheme === 'file',
        // Only the connection in use, per §2's least-exposure argument;
        // anything else is resolved on demand through key/request.
        profiles: profile ? [profile] : [],
        activeProfile: profileName,
        // The whole role table, so the server can resolve a role to another
        // connection and then ask for that one and its key.
        roles: this.profiles.getRoles(),
        keys: apiKey ? { [profileName]: apiKey } : {},
      },
      this.options,
    );
    this.connection = connection;
    this.connectedProfile = profileName;
    const { peer } = connection;

    // The daemon outlives this window by design, and it also exits without
    // asking: it goes idle, it retires because its bundle was rebuilt, someone
    // kills it. Holding the dead peer meant every later request rejected with
    // "connection closed" until the window was reloaded. Dropping the
    // reference is the whole recovery — the next call reconnects.
    peer.onClose(() => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      this.connectedProfile = undefined;
    });

    peer.onRequest(METHODS.toolExecute, async (raw, signal) => {
      const { runId, call } = raw as ToolExecuteParams;
      // One handler, two kinds of run on this connection — the review's
      // read-only tools and chat's ask-mode tools. Demultiplexed by runId
      // because both are the same channel by design.
      const review = this.activeReview;
      if (review && review.runId === runId) return review.execute(call, signal);
      const turn = this.activeTurn;
      if (!turn || turn.runId !== runId || !turn.execute) {
        return {
          id: call.id,
          name: call.name,
          content: 'This turn is no longer active.',
          isError: true,
        } satisfies ToolResult;
      }
      return turn.execute(call, signal);
    });

    peer.onRequest(METHODS.reviewConfirm, async (raw) => {
      const { runId, confirmation } = raw as ReviewConfirmParams;
      const review = this.activeReview;
      if (!review || review.runId !== runId) return { ok: false } satisfies ReviewConfirmResult;
      return { ok: await review.confirm(confirmation) } satisfies ReviewConfirmResult;
    });

    peer.onNotification(METHODS.reviewEvent, (raw) => {
      const { runId, event } = raw as ReviewEventParams;
      const review = this.activeReview;
      if (review && review.runId === runId) review.onEvent(event);
    });

    peer.onRequest(METHODS.keyRequest, async (raw) => {
      const { profileName: wanted } = raw as KeyRequestParams;
      const target = this.profiles.getProfiles().find((p) => p.name === wanted);
      // Unknown profile or no stored key → the server falls back to the
      // session's own provider, the same lenient behavior the agent path uses.
      if (!target) return {} satisfies KeyRequestResult;
      return { profile: target, apiKey: await this.profiles.getApiKey(target) } satisfies KeyRequestResult;
    });

    peer.onNotification(METHODS.agentEvent, (raw) => {
      const { runId, event } = raw as AgentEventParams;
      const turn = this.activeTurn;
      if (turn && turn.runId === runId) turn.onEvent(event);
    });

    peer.onNotification(METHODS.ragEvent, (raw) => {
      const { event } = raw as RagEventParams;
      for (const listener of [...this.ragListeners]) listener(event);
    });

    return connection;
  }

  /** Whichever profile is active — RAG has no notion of a per-call profile. */
  private activeProfileName(): string {
    return this.profiles.getActiveProfile().name;
  }

  /** Indexing progress and state, for the status bar. */
  onRagEvent(listener: (event: RagEvent) => void): vscode.Disposable {
    this.ragListeners.add(listener);
    return { dispose: () => this.ragListeners.delete(listener) };
  }

  /**
   * Semantic retrieval. The two toggles are read here rather than server-side:
   * they are host policy, and the server has no business reading this host's
   * settings (docs/phase3-rag-design.md §5.4, decision 6).
   *
   * Never throws — every caller treats "no results" and "no server" the same
   * way, by falling back to whatever context it can get without RAG.
   */
  async ragQuery(text: string, k?: number): Promise<RagQueryResult> {
    const config = vscode.workspace.getConfiguration('heapcode');
    try {
      const { peer } = await this.ensureConnection(this.activeProfileName());
      return await peer.request<RagQueryResult>(METHODS.ragQuery, {
        text,
        k,
        hybridSearch: config.get<boolean>('rag.hybridSearch', true),
        rerank: config.get<boolean>('rag.rerank', true),
      } satisfies RagQueryParams);
    } catch (err) {
      this.log.appendLine(`[rag] query failed: ${err instanceof Error ? err.message : String(err)}`);
      return { formatted: '', hits: [] };
    }
  }

  /**
   * A full rebuild or an incremental update.
   *
   * contextualRetrieval comes from this host's setting, which ships **off** —
   * unlike the CLI, which has no setting and always runs it. Decision 6 keeps
   * that difference by passing it per request.
   */
  async ragIndex(params: Omit<RagIndexParams, 'contextualRetrieval'>): Promise<RagIndexResult | undefined> {
    try {
      const { peer } = await this.ensureConnection(this.activeProfileName());
      return await peer.request<RagIndexResult>(METHODS.ragIndex, {
        ...params,
        contextualRetrieval: vscode.workspace
          .getConfiguration('heapcode')
          .get<boolean>('rag.contextualRetrieval', false),
      } satisfies RagIndexParams);
    } catch (err) {
      this.log.appendLine(`[rag] index failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * One PR review, server-side. Its own method rather than agent/run because it
   * has its own loop and its own termination policy — see ReviewRunParams.
   *
   * Cancellation is agent/cancel, exactly as on the agent and chat paths, and
   * because the server wires the run's signal into every outbound request,
   * aborting also stops whatever read-only tool call is in flight.
   */
  async reviewRun(
    params: Omit<ReviewRunParams, 'runId' | 'profileName'>,
    handlers: ReviewHandlers,
    signal: AbortSignal,
  ): Promise<ReviewRunResult> {
    const profileName = this.activeProfileName();
    const { peer } = await this.ensureConnection(profileName);
    const runId = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeReview = { runId, ...handlers };
    const onAbort = (): void => void peer.notify(METHODS.agentCancel, { runId });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await peer.request<ReviewRunResult>(METHODS.reviewRun, { ...params, runId } satisfies ReviewRunParams);
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (this.activeReview?.runId === runId) this.activeReview = undefined;
    }
  }

  /** Empties the index — the "Clear Index" command. */
  async ragClear(): Promise<void> {
    await this.ragIndex({ clear: true });
  }

  async ragStatus(): Promise<RagStatusResult | undefined> {
    try {
      const { peer } = await this.ensureConnection(this.activeProfileName());
      return await peer.request<RagStatusResult>(METHODS.ragStatus);
    } catch {
      return undefined;
    }
  }

  /**
   * One commit message from one diff, server-side.
   *
   * Request/response, no callbacks — genuinely a single model call, unlike
   * chat's hidden tool loop or PR review's. The diff is collected here because
   * the server has no business knowing about VS Code's git extension, and
   * "staged, else working tree" is a decision about what the user meant.
   */
  async commitMessage(diff: string, signal?: AbortSignal): Promise<string> {
    const profileName = this.activeProfileName();
    const { peer } = await this.ensureConnection(profileName);
    const { message } = await peer.request<CommitMessageResult>(
      METHODS.commitMessage,
      { diff } satisfies CommitMessageParams,
      signal,
    );
    return message;
  }

  /**
   * Model list for a profile, resolved with the server's copy of the key.
   *
   * `model` additionally asks what context length that one model really has,
   * falling back to the endpoint's own API where /v1/models omits it. The
   * server does that probe because the key is there — this used to be
   * attempted extension-side and could not authenticate.
   */
  async listModels(profileName: string, model?: string): Promise<ModelInfo[]> {
    const { peer } = await this.ensureConnection(profileName);
    const { models } = await peer.request<ListModelsResult>(METHODS.listModels, {
      profileName,
      model,
    } satisfies ListModelsParams);
    return models;
  }

  /**
   * One chat turn, server-side. Cancellation is `agent/cancel`, exactly as on
   * the agent path — aborting also fires `$/cancelRequest` for any outstanding
   * tool/execute, so stopping mid-search stops the search too.
   */
  async chatSend(
    params: Omit<ChatSendParams, 'runId'> & { profileName: string },
    handlers: ChatTurnHandlers,
    signal: AbortSignal,
  ): Promise<ChatSendResult> {
    const { peer } = await this.ensureConnection(params.profileName);
    const runId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeTurn = { runId, ...handlers };
    const onAbort = (): void => void peer.notify(METHODS.agentCancel, { runId });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await peer.request<ChatSendResult>(METHODS.chatSend, { ...params, runId } satisfies ChatSendParams);
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (this.activeTurn?.runId === runId) this.activeTurn = undefined;
    }
  }
}
