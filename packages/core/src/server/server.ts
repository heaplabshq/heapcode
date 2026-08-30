import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { effectivePermission } from '../agent/commandRisk.js';
import { buildCommitMessages, normalizeCommitMessage } from '../prompts/edit.js';
import { buildApplyMessages, extractUpdatedCode } from '../prompts/apply.js';
import { extractFirstCodeBlock } from '../edit/codeBlocks.js';
import { runAgentForSession, type RunHost } from './agentRun.js';
import { runChatForSession, type ChatHost } from './chatSend.js';
import { runReviewForSession, type ReviewHost } from './review.js';
import { RpcPeer } from './rpc.js';
import { SessionRag } from './rag.js';
import { Session } from './session.js';
import { addressIsFile, daemonAddress, daemonTokenFile, heapcodeHome, socketAddressProblem } from './address.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  type AgentCancelParams,
  type AgentEvent,
  type AgentRunParams,
  type ChatSendParams,
  type ApplyMergeParams,
  type ApplyMergeResult,
  type CommitMessageParams,
  type CommitMessageResult,
  type HelloParams,
  type HelloResult,
  type KeyRequestParams,
  type KeyRequestResult,
  type ListModelsParams,
  type ListModelsResult,
  type PermissionRequestParams,
  type PermissionRequestResult,
  type RagEventParams,
  type RagIndexParams,
  type RagQueryParams,
  type ReviewConfirmParams,
  type ReviewConfirmResult,
  type ReviewEvent,
  type ReviewEventParams,
  type ReviewRunParams,
  type SnapshotBeforeParams,
  type ToolExecuteParams,
  type ToolExecuteResult,
} from './protocol.js';

export interface ServerOptions {
  /** Defaults to the versioned per-user address (see address.ts). */
  address?: string;
  home?: string;
  /** Pre-set token; otherwise one is generated and written to the 0600 token file. */
  token?: string;
  /** Exit after this long with no connections. 0 disables. Default 30 minutes. */
  idleShutdownMs?: number;
  onLog?: (line: string) => void;
  /** Called when idle shutdown fires; defaults to closing the server. */
  onIdle?: () => void;
}

const DEFAULT_IDLE_MS = 30 * 60_000;

/**
 * The core server: one process per user, many sessions.
 *
 * Session isolation (docs/phase3-protocol-design.md §2) is structural — the
 * only place keys and Providers exist is inside a `Session` owned by one
 * connection. There is deliberately no map of keys on this class.
 */
export class HeapcodeServer {
  readonly address: string;
  readonly token: string;
  private readonly home: string;
  private readonly idleShutdownMs: number;
  private readonly onLog: (line: string) => void;
  private server?: Server;
  private readonly sessions = new Set<Session>();
  /** Live sockets, so shutdown can drop them — net.Server has no closeAllConnections(). */
  private readonly sockets = new Set<Socket>();
  private idleTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly opts: ServerOptions = {}) {
    this.home = opts.home ?? heapcodeHome();
    this.address = opts.address ?? daemonAddress(this.home);
    this.token = opts.token ?? randomBytes(32).toString('hex');
    this.idleShutdownMs = opts.idleShutdownMs ?? DEFAULT_IDLE_MS;
    this.onLog = opts.onLog ?? (() => {});
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Whether anything is actually running — an agent turn, a review, an index.
   *
   * Distinct from `sessionCount` on purpose. A session lives as long as its
   * host does: a browser tab left open, an editor window, a terminal. Waiting
   * for those to go before retiring a rebuilt daemon meant waiting for the
   * user to quit everything, which nobody does, so in practice a rebuilt
   * daemon never retired and went on serving yesterday's code. What must not
   * be interrupted is work in flight, and that is this.
   */
  get busy(): boolean {
    for (const session of this.sessions) if (session.runCount > 0) return true;
    return false;
  }

  /**
   * Bind, writing the token file first so a client that sees the socket
   * always finds a usable token.
   *
   * Stale-socket handling per §6: a socket file whose server is gone answers
   * a connect attempt with ECONNREFUSED. Only then is it safe to unlink and
   * rebind — unlinking unconditionally would let a second server stomp a
   * live one. EADDRINUSE from a live peer is left to propagate so the loser
   * of a simultaneous start exits quietly.
   */
  async listen(): Promise<void> {
    const problem = socketAddressProblem(this.address);
    if (problem) throw new Error(problem);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    if (!this.opts.token) await this.writeToken();

    if (addressIsFile(this.address) && (await isStaleSocket(this.address))) {
      await unlink(this.address).catch(() => {});
    }

    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    if (addressIsFile(this.address)) await chmod(this.address, 0o600).catch(() => {});
    this.armIdleTimer();
    this.onLog(`listening on ${this.address}`);
  }

  private async writeToken(): Promise<void> {
    const file = daemonTokenFile(this.home);
    await writeFile(file, this.token, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));

    // Layer 1 (§3): reject any peer whose uid isn't ours, where the platform
    // lets us ask. Node exposes no peer-credential API, so this is a
    // best-effort check and layer 2 (the token) is the real gate — which is
    // also what keeps this free of a native dependency (guardrail #5).
    const peerUid = peerUidOf(socket);
    if (peerUid !== undefined && typeof process.getuid === 'function' && peerUid !== process.getuid()) {
      this.onLog(`[auth] rejected connection from uid ${peerUid}`);
      socket.destroy();
      return;
    }

    const peer = new RpcPeer(socket, 's', (err) => this.onLog(`[rpc] ${err.message}`));
    let session: Session | undefined;
    let rag: SessionRag | undefined;

    /** Resolve a profile's key through the host — shared by every path that may need one. */
    const requestKey = async (profileName: string): Promise<void> => {
      const active = session;
      if (!active) return;
      const res = await peer
        .request<KeyRequestResult>(METHODS.keyRequest, { profileName } satisfies KeyRequestParams)
        .catch(() => ({}) as KeyRequestResult);
      active.adoptResolvedKey(profileName, res);
    };

    /** The session's semantic index, built on first use so a session that never asks pays nothing. */
    const ragFor = (active: Session): SessionRag => {
      rag ??= new SessionRag(active, {
        emit: (event, runId) => void peer.notifyWithBackpressure(METHODS.ragEvent, { runId, event } satisfies RagEventParams),
        requestKey,
      });
      return rag;
    };

    peer.onRequest(METHODS.hello, async (raw) => {
      const params = raw as HelloParams;
      if (!constantTimeEquals(params?.token ?? '', this.token)) {
        // Answer before closing rather than dropping silently: a stale token
        // after a server restart is far likelier than an attack, and a silent
        // drop is indistinguishable from a crash (§3).
        this.onLog(`[auth] rejected: bad token${peerUid !== undefined ? ` (uid ${peerUid})` : ''}`);
        setTimeout(() => socket.destroy(), 10);
        throw Object.assign(new Error('unauthorized'), { code: RPC_ERRORS.unauthorized });
      }
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Protocol version mismatch: server ${PROTOCOL_VERSION}, client ${params.protocolVersion}`);
      }
      session = new Session(randomUUID(), params);
      this.sessions.add(session);
      this.armIdleTimer();
      this.onLog(`[session ${session.id.slice(0, 8)}] hello from ${params.client.name} root=${params.root}`);
      return { protocolVersion: PROTOCOL_VERSION, serverVersion: '0.1.0', sessionId: session.id } satisfies HelloResult;
    });

    peer.onRequest(METHODS.agentRun, async (raw) => {
      if (!session) throw new Error('session/hello must be sent first');
      const params = raw as AgentRunParams;
      const controller = session.beginRun(params.runId);
      const active = session;
      const host: RunHost = {
        emit: (event: AgentEvent) => void peer.notifyWithBackpressure(METHODS.agentEvent, { runId: params.runId, event }),
        executeTool: (call, parent) =>
          peer.request<ToolExecuteResult>(
            METHODS.toolExecute,
            { runId: params.runId, call, parent } satisfies ToolExecuteParams,
            controller.signal,
          ),
        requestPermission: async (call, tool) => {
          const res = await peer.request<PermissionRequestResult>(
            METHODS.permissionRequest,
            {
              runId: params.runId,
              call,
              // Escalated here, not just in PermissionEngine: the hosts that
              // decide from this field alone — headless via resolveUnattended,
              // web-host via a synthetic tool — have no tool definition to
              // consult, so an un-escalated `execute` would be the whole of
              // what they ever saw for `rm -rf` (commandRisk.ts).
              permission: effectivePermission(call, tool.permission),
              toolName: tool.name,
            } satisfies PermissionRequestParams,
            controller.signal,
          );
          return res.granted;
        },
        snapshotBefore: async (call) => {
          await peer
            .request(METHODS.snapshotBefore, { runId: params.runId, call } satisfies SnapshotBeforeParams, controller.signal)
            .catch(() => {}); // best-effort, never fails a tool call
        },
        requestKey,
        semanticSearch: (query) => ragFor(active).searchForTool(query),
      };
      try {
        return await runAgentForSession(session, params, host, controller.signal);
      } finally {
        active.endRun(params.runId);
      }
    });

    peer.onRequest(METHODS.chatSend, async (raw) => {
      if (!session) throw new Error('session/hello must be sent first');
      const params = raw as ChatSendParams;
      const controller = session.beginRun(params.runId);
      const active = session;
      const host: ChatHost = {
        emit: (event: AgentEvent) => void peer.notifyWithBackpressure(METHODS.agentEvent, { runId: params.runId, event }),
        executeTool: (call) =>
          peer.request<ToolExecuteResult>(
            METHODS.toolExecute,
            { runId: params.runId, call } satisfies ToolExecuteParams,
            controller.signal,
          ),
        semanticSearch: (query) => ragFor(active).searchForTool(query),
      };
      try {
        return await runChatForSession(session, params, host, controller.signal);
      } finally {
        active.endRun(params.runId);
      }
    });

    // Request/response, no callbacks — the shape session/hello has. The
    // session is what makes it safe: the key comes from this connection's map
    // and nowhere else.
    peer.onRequest(METHODS.listModels, async (raw) => {
      if (!session) throw new Error('session/hello must be sent first');
      const { profileName, model } = (raw ?? {}) as ListModelsParams;
      const name = profileName ?? session.activeProfile;
      // `resolveProfile`, not `providerFor`: every host pushes only the ACTIVE
      // profile at hello (App.tsx:426, headless.ts:207, serverLink.ts:91), so
      // asking for any other one's models used to fail with "Unknown profile"
      // even though the host knew it perfectly well. This is the same
      // key/request path `providerForRole` already uses for `<role>Profile`
      // redirects — the profile a role is redirected TO is exactly the profile
      // whose models a settings UI needs to offer.
      const resolved = await session.resolveProfile(name, requestKey);
      if (!resolved) throw new Error(`Unknown profile "${name}" for this session.`);
      const models = await resolved.provider.listModels();
      // Asked about one model in particular, and the catalogue did not say how
      // big its window is: ask the endpoint's own API. Only the daemon can —
      // the key is here and nowhere else — and a host that guesses instead
      // sizes its window off a preset default, which is how compaction ends up
      // never firing on an endpoint that serves far less than the preset says.
      if (model && !models.find((m) => m.id === model)?.contextLength) {
        const length = await resolved.provider.contextLengthFor?.(model).catch(() => undefined);
        if (length) {
          const existing = models.findIndex((m) => m.id === model);
          if (existing >= 0) models[existing] = { ...models[existing]!, contextLength: length };
          else models.push({ id: model, contextLength: length });
        }
      }
      return { models } satisfies ListModelsResult;
    });

    // Request/response like provider/listModels. Nothing binary crosses here:
    // vectors are produced and consumed server-side and `hits` carries HitMeta,
    // which has no vector field (docs/phase3-rag-design.md §1.2, §2.3).
    peer.onRequest(METHODS.ragQuery, async (raw) => {
      if (!session) throw new Error('session/hello must be sent first');
      return ragFor(session).query(raw as RagQueryParams);
    });

    // A long build has to be stoppable, so it registers as a run when the host
    // gives it a runId — `agent/cancel` then aborts it like any other.
    peer.onRequest(METHODS.ragIndex, async (raw, signal) => {
      if (!session) throw new Error('session/hello must be sent first');
      const params = (raw ?? {}) as RagIndexParams;
      const active = session;
      const controller = params.runId ? active.beginRun(params.runId) : undefined;
      // $/cancelRequest on this call aborts it too, so a host that drops the
      // request rather than sending agent/cancel still stops the work.
      signal.addEventListener('abort', () => controller?.abort(), { once: true });
      try {
        return await ragFor(active).runIndex(params, controller?.signal ?? signal);
      } finally {
        if (params.runId) active.endRun(params.runId);
      }
    });

    /**
     * A single model call on the `editModel` role, which is why it goes through
     * providerForRole rather than providerFor: a profile can point commit
     * messages at another profile entirely via `editProfile`, and that
     * redirect's key is resolved through key/request like any other.
     */
    peer.onRequest(METHODS.commitMessage, async (raw, signal) => {
      if (!session) throw new Error('session/hello must be sent first');
      const { diff, profileName } = (raw ?? {}) as CommitMessageParams;
      if (!diff?.trim()) return { message: '' } satisfies CommitMessageResult;
      const resolved = await session.providerForRole('editModel', requestKey, profileName);
      if (!resolved) throw new Error(`Unknown profile "${profileName ?? session.activeProfile}" for this session.`);
      const res = await resolved.provider.chat({
        model: resolved.profile.editModel || resolved.profile.model,
        messages: buildCommitMessages(diff),
        temperature: 0.2,
        maxTokens: 500,
        signal,
      });
      return { message: normalizeCommitMessage(res.content) } satisfies CommitMessageResult;
    });

    /**
     * `edit_file`'s fast-apply fallback: search/replace failed to match, so
     * hand the whole file and the intended change to a small merge model and
     * let it place the edit.
     *
     * Server-side for the same reason `git/commitMessage` is — a single call
     * on a role that can point at a different profile entirely, which the host
     * has no provider to make for itself.
     *
     * An unconfigured `applyModel` returns `{}`, not an error. Nothing is
     * broken when a profile has no merge model; the caller simply reports the
     * edit that did not apply, exactly as it did before this existed. Same for
     * a model that answers with something other than a merged file: a bad
     * rescue attempt must never be louder than the original failure.
     */
    peer.onRequest(METHODS.applyMerge, async (raw, signal) => {
      if (!session) throw new Error('session/hello must be sent first');
      const { original, snippet, profileName } = (raw ?? {}) as ApplyMergeParams;
      if (!original || !snippet?.trim()) return {} satisfies ApplyMergeResult;

      const resolved = await session.providerForRole('applyModel', requestKey, profileName);
      if (!resolved?.profile.applyModel) return {} satisfies ApplyMergeResult;

      try {
        const res = await resolved.provider.chat({
          model: resolved.profile.applyModel,
          messages: buildApplyMessages(original, snippet),
          temperature: 0,
          // The model re-emits the whole file, so the cap has to scale with
          // the input rather than sit at some fixed number of tokens.
          maxTokens: Math.max(4096, Math.ceil(original.length / 2)),
          signal,
        });
        const merged = extractUpdatedCode(res.content) ?? extractFirstCodeBlock(res.content);
        return { merged } satisfies ApplyMergeResult;
      } catch {
        // A merge model that is down, slow or wrong is a fallback that did not
        // fire. The edit failure it was trying to rescue is the real result.
        return {} satisfies ApplyMergeResult;
      }
    });

    /**
     * Its own method rather than agent/run: the review has its own loop and its
     * own termination policy (see ReviewRunParams). It registers as a run so
     * agent/cancel reaches it — and because RpcPeer wires the signal into every
     * outbound request, cancelling also fires $/cancelRequest for whatever
     * tool/execute or review/confirm is outstanding.
     */
    peer.onRequest(METHODS.reviewRun, async (raw, signal) => {
      if (!session) throw new Error('session/hello must be sent first');
      const params = raw as ReviewRunParams;
      const active = session;
      const controller = active.beginRun(params.runId);
      signal.addEventListener('abort', () => controller.abort(), { once: true });
      const host: ReviewHost = {
        emit: (event: ReviewEvent) =>
          void peer.notifyWithBackpressure(METHODS.reviewEvent, { runId: params.runId, event } satisfies ReviewEventParams),
        executeTool: (call) =>
          peer.request<ToolExecuteResult>(
            METHODS.toolExecute,
            { runId: params.runId, call } satisfies ToolExecuteParams,
            controller.signal,
          ),
        // No timeout, deliberately — the user is reading a full review preview
        // and may take minutes.
        //
        // Every failure resolves to "don't post": a cancellation mid-confirm, a
        // dropped socket, a host that threw. That is both the safe direction for
        // the one action in this product that cannot be un-sent, and what
        // happened before this moved — both hosts already turned an abort during
        // the prompt into `false`, which reviewCurrentPr reports as 'cancelled'
        // rather than letting it escape as an error.
        confirm: async (confirmation) => {
          const res = await peer
            .request<ReviewConfirmResult>(
              METHODS.reviewConfirm,
              { runId: params.runId, confirmation } satisfies ReviewConfirmParams,
              controller.signal,
            )
            .catch(() => ({ ok: false }) as ReviewConfirmResult);
          return res.ok;
        },
        requestKey,
      };
      try {
        return await runReviewForSession(active, params, host, controller.signal);
      } finally {
        active.endRun(params.runId);
      }
    });

    peer.onRequest(METHODS.ragStatus, async () => {
      if (!session) throw new Error('session/hello must be sent first');
      return ragFor(session).status();
    });

    peer.onNotification(METHODS.agentCancel, (raw) => {
      const { runId } = (raw ?? {}) as AgentCancelParams;
      // Aborting the run's controller also fires $/cancelRequest for any
      // outstanding tool/execute (RpcPeer.request wires the signal), so a
      // 60-second command the host is still running gets cancelled too (§5).
      session?.cancelRun(runId);
    });

    socket.on('close', () => {
      if (session) {
        this.sessions.delete(session);
        session.dispose(); // drops keys, aborts in-flight runs (§2)
      }
      peer.close();
      this.armIdleTimer();
    });
  }

  /** Exit after a quiet period so a long-lived process isn't holding keys forever (§6). */
  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.idleShutdownMs <= 0 || this.closed || this.sessions.size > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.sessions.size === 0) {
        this.onLog('idle shutdown');
        (this.opts.onIdle ?? (() => void this.close()))();
      }
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      const server = this.server;
      if (!server) return resolve();
      server.close(() => resolve());
      // close() only stops accepting — it resolves once every existing
      // connection ends, which for a live client is never. Shutdown must not
      // depend on clients being polite about it, so drop them. (net.Server
      // has no closeAllConnections(); that one is http.Server's.)
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
    if (addressIsFile(this.address)) await unlink(this.address).catch(() => {});
  }
}

/** A socket file with nobody listening: present, but refuses connections. */
function isStaleSocket(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(address);
    probe.once('connect', () => {
      probe.destroy();
      resolve(false); // a live server owns it
    });
    probe.once('error', (err: NodeJS.ErrnoException) => {
      probe.destroy();
      // ENOENT: nothing there at all, nothing to unlink.
      // ECONNREFUSED: the file outlived its server — safe to remove.
      resolve(err.code === 'ECONNREFUSED');
    });
  });
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Peer uid where the platform exposes it; undefined otherwise (always on Windows). */
function peerUidOf(socket: Socket): number | undefined {
  const candidate = (socket as unknown as { peerCredentials?: { uid?: number } }).peerCredentials;
  return typeof candidate?.uid === 'number' ? candidate.uid : undefined;
}
