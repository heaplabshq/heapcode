import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { daemonAddress, daemonLogFile, daemonTokenFile, heapcodeHome } from './address.js';
import { RpcPeer } from './rpc.js';
import { METHODS, PROTOCOL_VERSION, type HelloParams, type HelloResult } from './protocol.js';

export interface ConnectOptions {
  /** Overrides the versioned per-user address; tests point this at their own server. */
  address?: string;
  /** Overrides the token file's contents; tests pass their server's token directly. */
  token?: string;
  home?: string;
  /** Off for tests that run a server in-process — nothing to spawn. */
  autostart?: boolean;
  /** How long to keep poll-connecting after spawning, in ms. */
  startupTimeoutMs?: number;
  /**
   * Path to the host's bundled daemon entry script. Each host builds its own
   * (packages/cli/dist/daemon.js, packages/vscode/dist/daemon.js) because
   * each host is what actually gets installed; core only knows how to run
   * one. Without it, autostart cannot spawn and connection failure is fatal.
   */
  daemonEntry?: string;
  /** Injected for tests; defaults to spawning `daemonEntry` detached. */
  spawnServer?: () => void;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;

/**
 * A connected, authenticated peer plus the session it opened.
 *
 * `hello` has already been sent by the time this resolves, so key material
 * (custody note, Option A2) is in the server before any run starts.
 */
export interface ServerConnection {
  peer: RpcPeer;
  session: HelloResult;
  close(): void;
}

/**
 * Connect to the core server, starting it if nothing is listening.
 *
 * The sequence is docs/phase3-protocol-design.md §6's: try to connect, spawn
 * detached on failure, then poll-connect with backoff. Both races are handled
 * by the socket rather than a lock file — a simultaneous start makes the
 * loser exit on EADDRINUSE, and a stale socket file is only unlinked by the
 * server after a connect attempt actually failed.
 *
 * This lives in core rather than in one host because all three clients share
 * it: the CLI's headless and interactive surfaces and the extension. A second
 * implementation of the socket/auth/framing layer is exactly what §6 exists
 * to avoid.
 */
export async function connectToServer(
  hello: Omit<HelloParams, 'token' | 'protocolVersion'>,
  opts: ConnectOptions = {},
): Promise<ServerConnection> {
  const home = opts.home ?? heapcodeHome();
  const address = opts.address ?? daemonAddress(home);
  const autostart = opts.autostart ?? true;
  const deadline = Date.now() + (opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);

  let socket = await tryConnect(address);
  if (!socket && autostart) {
    const spawnServer = opts.spawnServer ?? (opts.daemonEntry ? () => spawnDaemon(opts.daemonEntry!, home) : undefined);
    if (spawnServer) {
      spawnServer();
      while (!socket && Date.now() < deadline) {
        await delay(50);
        socket = await tryConnect(address);
      }
    }
  }
  if (!socket) {
    throw new Error(
      `Could not reach the Heap Code server at ${address}. ` +
        `See ${daemonLogFile(home)} for why it did not start.`,
    );
  }

  const peer = new RpcPeer(socket, 'c');
  const token = opts.token ?? (await readToken(home));
  try {
    const session = await peer.request<HelloResult>(METHODS.hello, {
      ...hello,
      token,
      protocolVersion: PROTOCOL_VERSION,
    } satisfies HelloParams);
    return { peer, session, close: () => peer.close() };
  } catch (err) {
    peer.close();
    throw err;
  }
}

function tryConnect(address: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = connect(address);
    const done = (value: Socket | undefined): void => {
      socket.removeAllListeners('connect');
      socket.removeAllListeners('error');
      if (!value) socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(socket));
    socket.once('error', () => done(undefined));
  });
}

/**
 * Spawn the daemon fully detached so it outlives whoever started it — the
 * point of a shared server is that the next `heapcode -p`, or the next VS
 * Code window, reuses it rather than paying startup again.
 *
 * ELECTRON_RUN_AS_NODE is set unconditionally because one of the three
 * clients is a VS Code extension, where `process.execPath` is the Electron
 * binary rather than node; without it the daemon would come up as a second
 * editor window. It is meaningless (and harmless) under a plain node
 * execPath, which is the CLI's case.
 */
function spawnDaemon(entry: string, home: string): void {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HEAPCODE_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
}

async function readToken(home: string): Promise<string> {
  try {
    return (await readFile(daemonTokenFile(home), 'utf8')).trim();
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
