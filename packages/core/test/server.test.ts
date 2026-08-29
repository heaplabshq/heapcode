import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from './mockServer.js';
import {
  HeapcodeServer,
  METHODS,
  getPersona,
  PROTOCOL_VERSION,
  RpcPeer,
  Session,
  daemonAddress,
  socketAddressProblem,
  type AgentEventParams,
  type AgentRunParams,
  type AgentRunResult,
  type HelloParams,
  type PermissionRequestResult,
  type ToolDefinition,
  type ToolExecuteParams,
  type ToolResult,
} from '../src/index.js';
import { connect } from 'node:net';

let home: string;
let server: HeapcodeServer;
let mock: MockServer | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heapcode-server-'));
});

afterEach(async () => {
  await server?.close();
  await mock?.close();
  mock = undefined;
  await rm(home, { recursive: true, force: true });
});

async function startServer(opts: { idleShutdownMs?: number } = {}): Promise<HeapcodeServer> {
  server = new HeapcodeServer({ home, address: join(home, 'test.sock'), idleShutdownMs: opts.idleShutdownMs ?? 0 });
  await server.listen();
  return server;
}

/** A raw client peer, authenticated, with no host handlers registered yet. */
async function connectClient(
  hello: Partial<HelloParams> & Pick<HelloParams, 'root' | 'profiles' | 'activeProfile'>,
  token = server.token,
): Promise<RpcPeer> {
  const socket = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const s = connect(server.address);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(socket, 'c');
  await peer.request(METHODS.hello, {
    token,
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    ...hello,
  } satisfies HelloParams);
  return peer;
}

const ECHO_TOOL: ToolDefinition = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: {} },
  permission: 'read',
};

describe('HeapcodeServer — authentication', () => {
  it('writes a per-launch token to a 0600 file and rejects a connection presenting the wrong one', async () => {
    await startServer();
    const tokenFile = join(home, `daemon-${PROTOCOL_VERSION}.token`);
    expect((await readFile(tokenFile, 'utf8')).trim()).toBe(server.token);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);

    await expect(
      connectClient({ root: home, profiles: [], activeProfile: 'x' }, 'not-the-token'),
    ).rejects.toThrow(/unauthorized/);
  });

  it('accepts the right token and reports the protocol version back', async () => {
    await startServer();
    const socket = connect(server.address);
    await new Promise((resolve) => socket.once('connect', resolve));
    const peer = new RpcPeer(socket, 'c');
    const hello = await peer.request<{ protocolVersion: number; sessionId: string }>(METHODS.hello, {
      token: server.token,
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'test' },
      root: home,
      profiles: [],
      activeProfile: 'x',
    } satisfies HelloParams);
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hello.sessionId).toBeTruthy();
    peer.close();
  });
});

/**
 * docs/phase3-protocol-design.md §2's invariant: no session may reach
 * another's key or Provider. Enforced structurally — everything hangs off
 * the per-connection Session — so this checks the structure holds rather
 * than that a convention was followed.
 */
describe('HeapcodeServer — session isolation', () => {
  it('two concurrent sessions resolve the same profile name to different keys and different Provider instances', async () => {
    const profileA = { name: 'shared', preset: 'custom' as const, baseUrl: 'http://a.invalid/v1', model: 'm' };
    const profileB = { name: 'shared', preset: 'custom' as const, baseUrl: 'http://b.invalid/v1', model: 'm' };

    const one = new Session('one', {
      token: 't',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'a' },
      root: '/a',
      profiles: [profileA],
      activeProfile: 'shared',
      keys: { shared: 'key-A' },
    });
    const two = new Session('two', {
      token: 't',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'b' },
      root: '/b',
      profiles: [profileB],
      activeProfile: 'shared',
      keys: { shared: 'key-B' },
    });

    const a = one.providerFor('shared');
    const b = two.providerFor('shared');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Same profile *name*, different sessions — must not be the same object.
    expect(a!.provider).not.toBe(b!.provider);
    expect(a!.profile.baseUrl).toBe('http://a.invalid/v1');
    expect(b!.profile.baseUrl).toBe('http://b.invalid/v1');

    // A profile only one session knows about stays invisible to the other.
    one.adoptResolvedKey('private', { apiKey: 'secret', profile: { name: 'private', preset: 'custom', baseUrl: 'http://p/v1', model: 'm' } });
    expect(one.providerFor('private')).toBeDefined();
    expect(two.providerFor('private')).toBeUndefined();
    expect(two.hasKey('private')).toBe(false);
  });

  it('disposing a session drops its keys and providers', async () => {
    const session = new Session('one', {
      token: 't',
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'a' },
      root: '/a',
      profiles: [{ name: 'p', preset: 'custom', baseUrl: 'http://a/v1', model: 'm' }],
      activeProfile: 'p',
      keys: { p: 'key' },
    });
    expect(session.hasKey('p')).toBe(true);
    session.dispose();
    expect(session.hasKey('p')).toBe(false);
    expect(session.providerFor('p')).toBeUndefined();
  });

  it('a disconnect disposes that session without touching the other', async () => {
    await startServer();
    const profiles = [{ name: 'p', preset: 'custom' as const, baseUrl: 'http://a/v1', model: 'm' }];
    const first = await connectClient({ root: home, profiles, activeProfile: 'p', keys: { p: 'k1' } });
    const second = await connectClient({ root: home, profiles, activeProfile: 'p', keys: { p: 'k2' } });
    expect(server.sessionCount).toBe(2);

    first.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.sessionCount).toBe(1);

    // The survivor is still usable.
    second.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.sessionCount).toBe(0);
  });

  it('an attached host is not, by itself, work in progress', async () => {
    // `busy` is what a rebuilt daemon waits for before retiring, and it has to
    // mean "something is running", not "someone is connected". A session lives
    // as long as its host does — a browser tab, an editor window, a terminal —
    // so gating on attachment meant waiting for the user to quit everything,
    // which nobody does. The daemon then served the old build indefinitely.
    await startServer();
    const profiles = [{ name: 'p', preset: 'custom' as const, baseUrl: 'http://a/v1', model: 'm' }];
    const client = await connectClient({ root: home, profiles, activeProfile: 'p', keys: { p: 'k' } });

    expect(server.sessionCount).toBe(1);
    expect(server.busy).toBe(false);

    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.busy).toBe(false);
  });
});

/** §6's two races, both resolved by the socket rather than a lock file. */
describe('HeapcodeServer — startup races', () => {
  it('a second server on the same address fails with EADDRINUSE and leaves the first serving', async () => {
    await startServer();
    const loser = new HeapcodeServer({ home, address: server.address, idleShutdownMs: 0 });
    await expect(loser.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });

    // The original is untouched and still accepts clients.
    const peer = await connectClient({ root: home, profiles: [], activeProfile: 'p' });
    expect(server.sessionCount).toBe(1);
    peer.close();
  });

  it('a stale socket file left by a crashed server is cleaned up and rebound', async () => {
    const address = join(home, 'test.sock');
    // A genuinely crashed server: a child binds the socket and is SIGKILLed,
    // so the file survives with nothing listening. Node's own server.close()
    // unlinks, which is why this can't be faked in-process — and a plain file
    // at the path is a different situation the server should NOT touch.
    const child = spawn(process.execPath, [
      '-e',
      'require("net").createServer().listen(process.argv[1], () => console.log("up"));',
      address,
    ]);
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      setTimeout(() => reject(new Error('child never bound the socket')), 5_000);
    });
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    await expect(stat(address)).resolves.toBeTruthy(); // the corpse is still there

    server = new HeapcodeServer({ home, address, idleShutdownMs: 0 });
    await expect(server.listen()).resolves.toBeUndefined();
    const peer = await connectClient({ root: home, profiles: [], activeProfile: 'p' });
    peer.close();
  }, 15_000);

  it('does NOT unlink a socket a live server still owns', async () => {
    await startServer();
    // Same address, live owner: the newcomer must fail rather than unlink and
    // steal it, or two servers would stomp each other (§6).
    const intruder = new HeapcodeServer({ home, address: server.address, idleShutdownMs: 0 });
    await expect(intruder.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const peer = await connectClient({ root: home, profiles: [], activeProfile: 'p' });
    peer.close();
  });
});

describe('HeapcodeServer — idle shutdown', () => {
  it('fires only once the last session disconnects', async () => {
    let idled = false;
    server = new HeapcodeServer({
      home,
      address: join(home, 'test.sock'),
      idleShutdownMs: 40,
      onIdle: () => (idled = true),
    });
    await server.listen();

    const peer = await connectClient({ root: home, profiles: [], activeProfile: 'p' });
    await new Promise((r) => setTimeout(r, 120));
    expect(idled).toBe(false); // a live session holds it open

    peer.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(idled).toBe(true);
  });
});

/**
 * The end-to-end proof: a real agent turn driven by a real model response,
 * over a real socket, with the tool executed by the "host" side of the
 * connection. Nothing here is mocked except the LLM endpoint itself.
 */
describe('HeapcodeServer — end-to-end agent run', () => {
  it('runs a task through the socket: tool/execute and permission/request round-trip, events stream, outcome returns', async () => {
    mock = await startMockServer({
      kind: 'sequence',
      responses: [
        { kind: 'sse', chunks: ['<tool name="echo">\n{"text":"hi"}\n</tool>'] },
        { kind: 'sse', chunks: ['<tool name="finish">\n{"summary":"all done"}\n</tool>'] },
      ],
    });
    await startServer();
    const profiles = [{ name: 'p', preset: 'custom' as const, baseUrl: mock.baseUrl, model: 'mock-model' }];
    const peer = await connectClient({ root: home, profiles, activeProfile: 'p', keys: { p: 'k' } });

    const executed: string[] = [];
    const permissions: string[] = [];
    const events: AgentEventParams['event'][] = [];

    peer.onRequest(METHODS.toolExecute, async (raw) => {
      const { call } = raw as ToolExecuteParams;
      executed.push(call.name);
      return { id: call.id, name: call.name, content: 'echoed: hi' } satisfies ToolResult;
    });
    peer.onRequest(METHODS.permissionRequest, async () => {
      permissions.push('asked');
      return { granted: true } satisfies PermissionRequestResult;
    });
    peer.onRequest(METHODS.snapshotBefore, async () => null);
    peer.onNotification(METHODS.agentEvent, (raw) => events.push((raw as AgentEventParams).event));

    const result = await peer.request<AgentRunResult>(METHODS.agentRun, {
      runId: 'r1',
      model: 'mock-model',
      task: 'echo something',
      workspaceName: 'proj',
      tools: [ECHO_TOOL],
      nativeToolCalls: false,
    } satisfies AgentRunParams);

    expect(result.outcome).toBe('done');
    expect(executed).toContain('echo');
    expect(events.some((e) => e.type === 'tool_call' && e.name === 'echo')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    peer.close();
  });

  it('cancellation stops the run AND cancels the in-flight tool the host is still running', async () => {
    // The model asks for a tool; the host's handler hangs. Cancelling the run
    // must abort both the loop and the outstanding tool/execute — §5's note
    // that stopping the model without stopping the command is the bug.
    mock = await startMockServer({ kind: 'sse', chunks: ['<tool name="echo">\n{"text":"hi"}\n</tool>'] });
    await startServer();
    const profiles = [{ name: 'p', preset: 'custom' as const, baseUrl: mock.baseUrl, model: 'mock-model' }];
    const peer = await connectClient({ root: home, profiles, activeProfile: 'p', keys: { p: 'k' } });

    let toolCancelled = false;
    let toolStarted: () => void;
    const started = new Promise<void>((resolve) => (toolStarted = resolve));

    peer.onRequest(METHODS.toolExecute, async (raw, signal) => {
      const { call } = raw as ToolExecuteParams;
      toolStarted();
      await new Promise<void>((resolve) => {
        // Never resolves on its own — only the cancel gets us out.
        signal.addEventListener('abort', () => {
          toolCancelled = true;
          resolve();
        });
      });
      return { id: call.id, name: call.name, content: 'interrupted' } satisfies ToolResult;
    });
    peer.onRequest(METHODS.permissionRequest, async () => ({ granted: true }) satisfies PermissionRequestResult);
    peer.onRequest(METHODS.snapshotBefore, async () => null);

    const run = peer.request<AgentRunResult>(METHODS.agentRun, {
      runId: 'r-cancel',
      model: 'mock-model',
      task: 'hang',
      workspaceName: 'proj',
      tools: [ECHO_TOOL],
      nativeToolCalls: false,
    } satisfies AgentRunParams);

    await started;
    peer.notify(METHODS.agentCancel, { runId: 'r-cancel' });

    const result = await run;
    expect(result.outcome).toBe('stopped');
    expect(toolCancelled).toBe(true);
    peer.close();
  }, 15_000);

  it('tells the model the full persona guard message, including how to proceed', async () => {
    // The guard blocks a write-looking shell command for a write-restricted
    // persona. Its second sentence ("Use a persona with file-editing tools
    // instead") was dropped when this moved server-side in Phase 2; without it
    // the model knows only that it was blocked.
    mock = await startMockServer({
      kind: 'sequence',
      responses: [
        { kind: 'sse', chunks: ['<tool name="run_command">\n{"command":"rm -rf build"}\n</tool>'] },
        { kind: 'sse', chunks: ['<tool name="finish">\n{"summary":"blocked"}\n</tool>'] },
      ],
    });
    await startServer();
    const profiles = [{ name: 'p', preset: 'custom' as const, baseUrl: mock.baseUrl, model: 'mock-model' }];
    const peer = await connectClient({ root: home, profiles, activeProfile: 'p', keys: { p: 'k' } });

    const executed: string[] = [];
    const results: string[] = [];
    peer.onRequest(METHODS.toolExecute, async (raw) => {
      const { call } = raw as ToolExecuteParams;
      executed.push(call.name);
      return { id: call.id, name: call.name, content: 'should never run' } satisfies ToolResult;
    });
    peer.onRequest(METHODS.permissionRequest, async () => ({ granted: true }) satisfies PermissionRequestResult);
    peer.onRequest(METHODS.snapshotBefore, async () => null);
    peer.onNotification(METHODS.agentEvent, (raw) => {
      const { event } = raw as AgentEventParams;
      if (event.type === 'tool_result') results.push(event.content);
    });

    const runCommandTool: ToolDefinition = {
      name: 'run_command',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
      permission: 'execute',
    };
    await peer.request<AgentRunResult>(METHODS.agentRun, {
      runId: 'r-guard',
      model: 'mock-model',
      task: 'clean the build directory',
      workspaceName: 'proj',
      tools: [runCommandTool],
      nativeToolCalls: false,
      persona: getPersona('architect'),
    } satisfies AgentRunParams);

    // Blocked before reaching the host at all.
    expect(executed).not.toContain('run_command');
    expect(results[0]).toBe(
      'Blocked: this command looks like it would create, modify, or delete files, which the ' +
        'Architect persona does not allow. Use a persona with file-editing tools instead.',
    );
    peer.close();
  }, 15_000);
});

describe('HeapcodeServer — socket address limits', () => {
  it('reports an over-long socket path instead of failing with a bare EINVAL', async () => {
    // Found the hard way: a 130-byte path made listen() fail EINVAL with no
    // mention of length, and because the daemon exited before its unawaited
    // log write flushed, the log was empty too. Both halves are fixed; this
    // covers the half that has a return value.
    const long = join(home, 'x'.repeat(120), 'daemon.sock');
    const overlong = new HeapcodeServer({ home, address: long, idleShutdownMs: 0 });
    await expect(overlong.listen()).rejects.toThrow(/HEAPCODE_HOME/);
    await expect(overlong.listen()).rejects.toThrow(/over this platform's \d+-byte limit/);
  });

  it('accepts a normal-length path', () => {
    expect(socketAddressProblem(join('/tmp', 'heapcode', 'daemon-1.sock'))).toBeUndefined();
  });
});

describe('daemonAddress', () => {
  it('embeds the protocol version so mismatched peers never meet', () => {
    const address = daemonAddress('/tmp/heapcode-home');
    expect(address).toContain(String(PROTOCOL_VERSION));
  });
});
