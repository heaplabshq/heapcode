import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METHODS,
  PROTOCOL_VERSION,
  RpcPeer,
  daemonAddress,
  daemonLogFile,
  daemonTokenFile,
  type HelloParams,
  type HelloResult,
} from '@heapcode/core';
import { globalDir } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  /** Injected for tests; defaults to spawning dist/daemon.js detached. */
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
 */
export async function connectToServer(
  hello: Omit<HelloParams, 'token' | 'protocolVersion'>,
  opts: ConnectOptions = {},
): Promise<ServerConnection> {
  const home = opts.home ?? globalDir();
  const address = opts.address ?? daemonAddress(home);
  const autostart = opts.autostart ?? true;
  const deadline = Date.now() + (opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);

  let socket = await tryConnect(address);
  if (!socket && autostart) {
    (opts.spawnServer ?? (() => spawnDaemon(home)))();
    while (!socket && Date.now() < deadline) {
      await delay(50);
      socket = await tryConnect(address);
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
 * Spawn the daemon fully detached so it outlives this CLI invocation — the
 * point of a shared server is that the next `heapcode -p` reuses it rather
 * than paying startup again.
 */
function spawnDaemon(home: string): void {
  const entry = join(__dirname, 'daemon.js');
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HEAPCODE_HOME: home },
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
