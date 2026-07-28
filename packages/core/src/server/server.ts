import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { runAgentForSession, type RunHost } from './agentRun.js';
import { RpcPeer } from './rpc.js';
import { Session } from './session.js';
import { addressIsFile, daemonAddress, daemonTokenFile, heapcodeHome, socketAddressProblem } from './address.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  type AgentCancelParams,
  type AgentEvent,
  type AgentRunParams,
  type HelloParams,
  type HelloResult,
  type KeyRequestParams,
  type KeyRequestResult,
  type PermissionRequestParams,
  type PermissionRequestResult,
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
            { runId: params.runId, call, permission: tool.permission, toolName: tool.name } satisfies PermissionRequestParams,
            controller.signal,
          );
          return res.granted;
        },
        snapshotBefore: async (call) => {
          await peer
            .request(METHODS.snapshotBefore, { runId: params.runId, call } satisfies SnapshotBeforeParams, controller.signal)
            .catch(() => {}); // best-effort, never fails a tool call
        },
        requestKey: async (profileName) => {
          const res = await peer
            .request<KeyRequestResult>(METHODS.keyRequest, { profileName } satisfies KeyRequestParams, controller.signal)
            .catch(() => ({}) as KeyRequestResult);
          active.adoptResolvedKey(profileName, res);
        },
      };
      try {
        return await runAgentForSession(session, params, host, controller.signal);
      } finally {
        active.endRun(params.runId);
      }
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
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // close() only stops accepting; existing sockets are already handled by
      // their own 'close' listeners.
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
