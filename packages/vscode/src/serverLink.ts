import * as vscode from 'vscode';
import {
  METHODS,
  connectToServer,
  type AgentEvent,
  type AgentEventParams,
  type ChatSendParams,
  type ChatSendResult,
  type ConnectOptions,
  type KeyRequestParams,
  type KeyRequestResult,
  type ListModelsParams,
  type ListModelsResult,
  type ModelInfo,
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

/**
 * The extension's connection for everything that is not an agent run: chat
 * turns and model listing.
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
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const connection = await connectToServer(
      {
        client: { name: 'heapcode-vscode-chat', version: this.options.clientVersion },
        root,
        // Only the profile in use, per §2's least-exposure argument; anything
        // else is resolved on demand through key/request.
        profiles: profile ? [profile] : [],
        activeProfile: profileName,
        keys: apiKey ? { [profileName]: apiKey } : {},
      },
      this.options,
    );
    this.connection = connection;
    this.connectedProfile = profileName;
    const { peer } = connection;

    peer.onRequest(METHODS.toolExecute, async (raw, signal) => {
      const { runId, call } = raw as ToolExecuteParams;
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

    return connection;
  }

  /** Model list for a profile, resolved with the server's copy of the key. */
  async listModels(profileName: string): Promise<ModelInfo[]> {
    const { peer } = await this.ensureConnection(profileName);
    const { models } = await peer.request<ListModelsResult>(METHODS.listModels, {
      profileName,
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
