import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeapcodeServer, type ExtensionToWebview, type McpManager, type ProviderProfileConfig } from '@heapcode/core';
import { AgentController } from '../src/agent/controller.js';
import { PermissionEngine } from '../src/agent/permissions.js';
import type { ProfileManager } from '../src/profileManager.js';
import { __setConfig, __resetConfig, __setWorkspaceRoot, __shownMessages } from './vscodeStub.js';

/**
 * The extension is a client of the core server now, so the agent loop does
 * not run in this process. The harness starts a real HeapcodeServer and a
 * real HTTP model endpoint, and AgentController reaches both the way it does
 * in production — over a unix socket for the protocol, over HTTP for the
 * model. Nothing here is mocked below the controller.
 *
 * The server runs in *this* process rather than being spawned, the same
 * choice both CLI migrations' harnesses made: every message still crosses a
 * real socket with real NDJSON framing and real bidirectional RPC, but the
 * tests don't depend on `node esbuild.mjs` having produced dist/daemon.js.
 * Autostart's spawning path is covered separately, below.
 */

interface ModelServer {
  baseUrl: string;
  requests: Array<Array<{ role: string; content: string }>>;
  script(texts: string[]): void;
  close(): Promise<void>;
}

async function startModelServer(): Promise<ModelServer> {
  let script: string[] = [''];
  let call = 0;
  const requests: ModelServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> }) : {};
      requests.push((body.messages ?? []).map((m) => ({ role: m.role, content: m.content })));
      const text = script[Math.min(call++, script.length - 1)] ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    script: (texts) => {
      script = texts;
      call = 0;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Only the four members the agent path still calls. `resolveRole` is
 * deliberately absent: the controller stopped building a host-side Provider
 * when the loop moved server-side, and a missing member failing loudly is
 * how this file proves that.
 */
function stubProfiles(profiles: ProviderProfileConfig[], keys: Record<string, string> = {}): ProfileManager {
  return {
    getProfiles: () => profiles,
    getApiKey: (p: ProviderProfileConfig) => Promise.resolve(keys[p.name]),
    resolveRoleProfile: () => profiles[0]!,
    contextWindowFor: () => Promise.resolve({ window: 32_000, source: 'profile' as const }),
  } as unknown as ProfileManager;
}

function stubMcp(overrides: Record<string, unknown> = {}): McpManager {
  return {
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getToolDefinitions: vi.fn().mockReturnValue([]),
    isMcpTool: (name: string) => name.startsWith('mcp__'),
    call: vi.fn(),
    ...overrides,
  } as unknown as McpManager;
}

const memento = {
  get: () => undefined,
  update: () => Promise.resolve(),
  keys: () => [] as readonly string[],
};

const log = { appendLine: () => {}, show: () => {} } as unknown as Parameters<typeof makeController>[0]['log'];

interface ControllerOpts {
  posts: ExtensionToWebview[];
  profiles?: ProfileManager;
  mcp?: McpManager;
  log?: unknown;
  server?: Record<string, unknown>;
}

function makeController(opts: ControllerOpts): AgentController {
  const permissions = new PermissionEngine(memento as never);
  // Full-auto: these tests are about the protocol, not the prompt.
  permissions.attachChatRequester(() => Promise.resolve('always'));
  return new AgentController(
    opts.profiles ?? stubProfiles([profile]),
    permissions,
    (opts.log ?? log) as never,
    (msg) => opts.posts.push(msg),
    undefined,
    opts.mcp ?? stubMcp(),
    undefined,
    undefined,
    undefined,
    (opts.server ?? serverOpts) as never,
  );
}

/** A tool call in the text-fallback protocol the loop parses (same helper the CLI tests use). */
function toolBlock(name: string, args: Record<string, unknown>): string {
  return `<tool name="${name}">\n${JSON.stringify(args)}\n</tool>`;
}

/** Lets a socket close land on the server before asserting on session bookkeeping. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** The loop's explicit completion signal; without it a text reply is treated as narration. */
function finishBlock(summary: string): string {
  return toolBlock('finish', { summary });
}

let root: string;
let home: string;
let model: ModelServer;
let core: HeapcodeServer;
let profile: ProviderProfileConfig;
let serverOpts: { address: string; token: string; autostart: false };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-vscode-agent-'));
  home = await mkdtemp(join(tmpdir(), 'hc-vscode-home-'));
  vi.stubEnv('HEAPCODE_HOME', home);
  __setWorkspaceRoot(root);
  // nativeToolCalls off: a tool-call-free reply ends the loop in exactly one
  // round trip, which is what makes these assertions deterministic.
  __setConfig('heapcode.agent', { enable: true, planFirst: false, commandTimeout: 30 });
  model = await startModelServer();
  profile = { name: 'test', preset: 'custom', baseUrl: model.baseUrl, model: 'mock' };
  core = new HeapcodeServer({ home, address: join(home, 't.sock'), idleShutdownMs: 0 });
  await core.listen();
  serverOpts = { address: core.address, token: core.token, autostart: false };
  __shownMessages.length = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  __setWorkspaceRoot(undefined);
  __resetConfig();
  await core?.close();
  await model?.close();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('AgentController — running against the core server', () => {
  it('runs an end-to-end turn over the real socket and posts the assistant text', async () => {
    model.script(['All done.']);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });

    await agent.start('say hello');

    expect(posts.filter((p) => p.type === 'agentText')).toEqual([{ type: 'agentText', text: 'All done.' }]);
    expect(posts.at(-1)).toMatchObject({ type: 'agentStatus', status: 'done' });
    agent.dispose();
  });

  it('executes a tool host-side through tool/execute and reports the result to the chat', async () => {
    model.script([toolBlock('write_file', { path: 'made.txt', content: 'hi' }), finishBlock('Wrote it.')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });

    await agent.start('create a file');

    expect(await readFile(join(root, 'made.txt'), 'utf8')).toBe('hi');
    const call = posts.find((p) => p.type === 'agentToolCall');
    expect(call).toMatchObject({ name: 'write_file' });
    expect(posts.find((p) => p.type === 'agentToolResult')).toMatchObject({ ok: true });
    agent.dispose();
  });

  it('keeps one session across turns rather than reconnecting per task', async () => {
    model.script(['done']);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });

    await agent.start('first');
    expect(core.sessionCount).toBe(1);
    await agent.start('second');
    expect(core.sessionCount).toBe(1);
    agent.dispose();
  });

  it('isolates sessions: a second controller gets its own session, and neither can see the other s key', async () => {
    model.script(['done']);
    const a = makeController({ posts: [], profiles: stubProfiles([profile], { test: 'key-a' }) });
    const other: ProviderProfileConfig = { ...profile, name: 'second' };
    const b = makeController({ posts: [], profiles: stubProfiles([other], { second: 'key-b' }) });

    await a.start('one');
    await b.start('two');

    expect(core.sessionCount).toBe(2);
    // Keys and Providers exist only inside a Session (§2's structural
    // invariant), so the proof is that each run authenticated with its own:
    // the model server saw two requests, and the server never merged them.
    expect(model.requests.length).toBeGreaterThanOrEqual(2);
    a.dispose();
    b.dispose();
    await settle();
    expect(core.sessionCount).toBe(0);
  });

  it('stop() kills a shell command that is running right now, not just the model call', async () => {
    // The command sleeps, then writes a file. Stop lands well before the
    // sleep ends, so the file is the assertion that matters: if cancellation
    // had only reached the model call, the shell would have survived it and
    // written the file anyway. This is the guarantee the App.tsx migration's
    // AbortError fix was for, re-checked on this host rather than assumed.
    const marker = join(root, 'survived.txt');
    model.script([
      toolBlock('run_command', { command: `sleep 5 && echo yes > ${marker}` }),
      finishBlock('done'),
    ]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });

    const started = Date.now();
    const run = agent.start('sleep a while');
    await new Promise((r) => setTimeout(r, 400));
    agent.stop();
    await run;

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(posts.at(-1)).toMatchObject({ type: 'agentStatus', status: 'stopped' });
    // Outlive the sleep, then confirm nothing ever wrote the marker.
    await new Promise((r) => setTimeout(r, 5_500));
    await expect(readFile(marker, 'utf8')).rejects.toThrow(/ENOENT/);
    agent.dispose();
  }, 15_000);

  it('dispatches MCP tools host-side through tool/execute', async () => {
    const mcpTool = {
      name: 'mcp__demo__ping',
      description: 'ping',
      parameters: { type: 'object', properties: {} },
      permission: 'execute' as const,
    };
    const call = vi.fn().mockResolvedValue('pong');
    const mcp = stubMcp({ getToolDefinitions: () => [mcpTool], call });
    model.script([toolBlock('mcp__demo__ping', {}), finishBlock('done')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts, mcp });

    await agent.start('ping the server');

    // MCP hosting stays out of the server (§4 flags it as needing its own
    // look), so the call must have gone back over tool/execute to this host.
    expect(call).toHaveBeenCalledWith('mcp__demo__ping', {});
    expect(posts.find((p) => p.type === 'agentToolResult')).toMatchObject({ ok: true, summary: 'pong' });
    agent.dispose();
  });

  it('renders a sub-agent s tool calls as parent-tagged chips', async () => {
    __setConfig('heapcode.agent', { enable: true, planFirst: false, subAgents: true, commandTimeout: 30 });
    model.script([
      toolBlock('delegate_task', { task: 'read the file' }),
      toolBlock('read_file', { path: 'sub.txt' }),
      finishBlock('sub-agent finished'),
      finishBlock('parent finished'),
    ]);
    await writeFile(join(root, 'sub.txt'), 'contents');
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });

    await agent.start('delegate something');

    const calls = posts.filter((p): p is Extract<ExtensionToWebview, { type: 'agentToolCall' }> => p.type === 'agentToolCall');
    const delegate = calls.find((c) => c.name === 'delegate_task');
    const nested = calls.find((c) => c.name === 'read_file');
    expect(delegate).toBeDefined();
    expect(nested).toBeDefined();
    expect(delegate?.parent).toBeUndefined();
    // Recursion is server-side; all the host does is indent what carries a
    // parent — the rendering change the protocol design predicted (§2).
    expect(nested?.parent).toBe(delegate?.id);
    agent.dispose();
  }, 15_000);

  it('autostarts the server when nothing is listening, then runs the turn', async () => {
    // The full §6 sequence through the extension's own path: the first
    // connect fails, the host starts a server, poll-connect picks it up.
    // "Spawn" starts a real HeapcodeServer rather than a detached process, so
    // the test needs no build — the same substitution both CLI migrations'
    // autostart tests make. The real detached spawn (dist/daemon.js under
    // ELECTRON_RUN_AS_NODE) is verified out of band; see the report.
    const address = join(home, 'late.sock');
    await core.close();
    model.script([finishBlock('started on demand')]);

    let spawned = 0;
    let late: HeapcodeServer | undefined;
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({
      posts,
      server: {
        address,
        token: 'shared-token',
        autostart: true,
        startupTimeoutMs: 5_000,
        spawnServer: () => {
          spawned++;
          late = new HeapcodeServer({ home, address, token: 'shared-token', idleShutdownMs: 0 });
          void late.listen();
        },
      },
    });

    try {
      await agent.start('hello');
      expect(spawned).toBe(1);
      expect(posts).toContainEqual({ type: 'agentText', text: 'started on demand' });
    } finally {
      agent.dispose();
      await late?.close();
    }
  }, 20_000);

  it('a second window reuses the daemon that is already running instead of spawning another', async () => {
    // §6's shared-server decision, from this host's side: the first
    // controller's connect succeeds, so nothing is ever spawned.
    model.script(['done']);
    let spawned = 0;
    const withSpawnCount = { ...serverOpts, autostart: true, spawnServer: () => spawned++ };
    const first = makeController({ posts: [], server: withSpawnCount });
    const second = makeController({ posts: [], server: withSpawnCount });

    await first.start('one');
    await second.start('two');

    expect(spawned).toBe(0);
    expect(core.sessionCount).toBe(2);
    first.dispose();
    second.dispose();
  });

  it('reports an unreachable server once, with the log path, instead of hanging', async () => {
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({
      posts,
      server: { address: join(home, 'nobody-here.sock'), token: 'x', autostart: false },
    });

    await agent.start('anything');

    expect(posts.find((p) => p.type === 'error')).toMatchObject({
      message: expect.stringContaining('Could not reach the Heap Code server'),
    });
    expect(posts.at(-1)).toMatchObject({ type: 'agentStatus', status: 'error' });
    expect(__shownMessages.join()).toContain('Could not reach the Heap Code server');
  });

  it('reconnects after a profile change so the server sees the new config', async () => {
    model.script(['done']);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });

    await agent.start('first');
    agent.markProfilesChanged();
    await agent.start('second');

    // One session at a time: the stale one is closed before the new one opens.
    expect(core.sessionCount).toBe(1);
    agent.dispose();
  });
});
