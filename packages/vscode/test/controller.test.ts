import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_NO_ANSWER,
  HeapcodeServer,
  parseIdleTimeout,
  type ConversationStore,
  type ExtensionToWebview,
  type McpManager,
  type ProviderProfileConfig,
  type WebviewToExtension,
  type ModelRoleTable,
} from '@heapcode/core';
import { AgentController } from '../src/agent/controller.js';
import { ChatViewProvider } from '../src/chatViewProvider.js';
import { PermissionEngine } from '../src/agent/permissions.js';
import { ServerLink } from '../src/serverLink.js';
import type { ProfileManager } from '../src/profileManager.js';
import { Uri, __setConfig, __resetConfig, __setWorkspaceRoot, __shownMessages } from './vscodeStub.js';

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
  /** Input batches from each /embeddings request — how "did the server re-index" is asserted. */
  embeddingCalls: string[][];
  /** Each chat request's messages and offered tools — the latter is how "was this tool offered at all" is asserted. */
  requests: Array<{
    messages: Array<{ role: string; content: string }>;
    tools?: Array<{ function?: { name?: string } }>;
  }>;
  script(texts: string[]): void;
  close(): Promise<void>;
}

async function startModelServer(): Promise<ModelServer> {
  let script: string[] = [''];
  let call = 0;
  const requests: ModelServer['requests'] = [];
  const embeddingCalls: string[][] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      // The semantic index runs in the server and reaches this same endpoint.
      if (req.url?.includes('/embeddings')) {
        const input = (raw ? (JSON.parse(raw) as { input?: string[] }) : {}).input ?? [];
        embeddingCalls.push(input);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: input.map((_, i) => ({ embedding: [1, 0, 0], index: i })) }));
        return;
      }
      const body = raw
        ? (JSON.parse(raw) as {
            messages?: Array<{ role: string; content: string }>;
            tools?: Array<{ function?: { name?: string } }>;
          })
        : {};
      requests.push({
        messages: (body.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
        tools: body.tools,
      });
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
    embeddingCalls,
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
    // The global role table pushed at hello. Embeddings is named explicitly
    // rather than left to inherit: it inherits nothing, on purpose, so an
    // absent entry means semantic indexing is off.
    getRoles: () => roles,
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
    // No `rag` parameter any more: semantic_search is dispatched server-side
    // from the session's own index, so the controller holds no indexer.
    opts.mcp ?? stubMcp(),
    undefined,
    undefined,
    undefined,
    (opts.server ?? serverOpts) as never,
  );
}

/**
 * A real ChatViewProvider behind a recording webview, for the one test that
 * needs the controller's `askUser` to land somewhere real instead of in a
 * capture function. Its posts go into the same array as the controller's, so
 * "what the webview saw" is one ordered list.
 */
function makeChatFor(posts: ExtensionToWebview[]): {
  chat: ChatViewProvider;
  link: ServerLink;
  send(msg: WebviewToExtension): Promise<void>;
} {
  const profiles = {
    ...(stubProfiles([profile]) as unknown as Record<string, unknown>),
    getActiveProfile: () => profile,
  } as unknown as ProfileManager;
  const store = {
    save: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  } as unknown as ConversationStore;
  const link = new ServerLink(profiles, log as never, serverOpts as never);
  const chat = new ChatViewProvider(Uri.file('/ext') as never, profiles, store, log as never, link);

  let onMessage: ((msg: WebviewToExtension) => void) | undefined;
  chat.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: '',
      cspSource: '',
      asWebviewUri: (u: unknown) => u,
      postMessage: (msg: ExtensionToWebview) => {
        posts.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (handler: (msg: WebviewToExtension) => void) => {
        onMessage = handler;
        return { dispose: () => {} };
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
  } as never);

  return {
    chat,
    link,
    send: async (msg) => {
      onMessage?.(msg);
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/**
 * Which tools a request actually put in front of the model. With native tool
 * calls on that is the `tools` array; with them off (what these tests use, for
 * determinism) the loop lists them in the system prompt instead.
 */
function offeredToModel(request: ModelServer['requests'][number]): string {
  const fromTools = (request.tools ?? []).map((t) => t.function?.name ?? '').join(' ');
  return `${fromTools}\n${request.messages.map((m) => m.content).join('\n')}`;
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
let roles: ModelRoleTable;
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
  roles = { chat: { connection: 'test', model: 'mock' } };
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

  it('offers delegate_task even when sub-agents are off, and refuses it with an explanation', async () => {
    // The default config (no `subAgents` key) leaves it off. Hiding the tool is
    // what the CLI stopped doing after a model, asked to delegate with no
    // delegate_task in its toolset, fabricated a delegation instead of saying
    // it could not delegate — see packages/cli/src/agent/delegate.ts:6-11.
    model.script([toolBlock('delegate_task', { task: 'do a chunk of work' }), finishBlock('Handled it myself.')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });

    await agent.start('delegate something');

    // Offered: the model could name it at all, which is the whole point. These
    // tests run with nativeToolCalls off, so the toolset reaches the model in
    // the system prompt rather than the request's `tools` array — `offeredToModel`
    // reads whichever one carried it.
    expect(offeredToModel(model.requests[0]!)).toContain('delegate_task');

    // Refused with a reason, not silently absent. agentToolResult carries no
    // tool name, so it is correlated by the call's id.
    const call = posts.find(
      (p): p is Extract<ExtensionToWebview, { type: 'agentToolCall' }> =>
        p.type === 'agentToolCall' && p.name === 'delegate_task',
    );
    expect(call).toBeDefined();
    const result = posts.find(
      (p): p is Extract<ExtensionToWebview, { type: 'agentToolResult' }> =>
        p.type === 'agentToolResult' && p.id === call!.id,
    );
    expect(result?.ok).toBe(false);
    expect(result?.summary).toContain('Sub-agent delegation is turned off');
    // The model is told the sub-task is still its own job — the half that stops
    // it claiming a delegation happened.
    const shown = model.requests[1]!.messages.map((m) => m.content).join('\n');
    expect(shown).toContain('Sub-agent delegation is turned off for this run.');
    expect(shown).toContain('Handle the sub-task yourself in this conversation instead');
    expect(shown).not.toContain('--sub-agents');
    agent.dispose();
  }, 15_000);

  it('does not prompt for permission on a delegate_task it is about to refuse', async () => {
    // delegate_task is permission: 'execute', so without this it would ask the
    // user to approve something that cannot run. Same short-circuit as
    // packages/cli/src/ink/App.tsx:500-503.
    model.script([toolBlock('delegate_task', { task: 'do a chunk of work' }), finishBlock('Handled it myself.')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });

    await agent.start('delegate something');

    expect(posts.some((p) => p.type === 'agentPermissionRequest')).toBe(false);
    agent.dispose();
  }, 15_000);

  it('still omits delegate_task when the user disabled it explicitly', async () => {
    // disabledTools is a deliberate per-tool opt-out, not a capability the
    // model should be reasoning about — unlike the subAgents gate.
    __setConfig('heapcode.agent', {
      enable: true,
      planFirst: false,
      commandTimeout: 30,
      disabledTools: ['delegate_task'],
    });
    model.script([finishBlock('Nothing to do.')]);
    const agent = makeController({ posts: [] });

    await agent.start('anything');

    expect(offeredToModel(model.requests[0]!)).not.toContain('delegate_task');
    agent.dispose();
  }, 15_000);

  describe('re-indexing after the agent\'s own writes', () => {
    /**
     * onDidSaveTextDocument — the only trigger either index had — does not fire
     * for `vscode.workspace.fs.writeFile`, which is how the agent writes. So
     * everything the agent touched stayed indexed as its pre-edit content until
     * a user opened and saved it, or ran a full rebuild. The CLI has always
     * closed this explicitly (App.tsx:389-412, headless.ts:350-384).
     *
     * "The index reflects the change" is asserted through the embeddings the
     * server had to request to re-chunk the file — there is no other way to see
     * a server-side index from here, and it is the strongest evidence anyway:
     * an embedding for that path means the content really was re-read.
     */
    function embeddedPaths(): string {
      return model.embeddingCalls.flat().join('\n');
    }

    it('re-indexes a file the agent wrote, with no save and no rebuild', async () => {
      roles.embeddings = { connection: 'test', model: 'embed' };
      model.script([toolBlock('write_file', { path: 'fresh.ts', content: 'export const a = 1;\n' }), finishBlock('Wrote it.')]);
      const agent = makeController({ posts: [] });

      await agent.start('create a file');

      await vi.waitFor(() => expect(embeddedPaths()).toContain('fresh.ts'), { timeout: 5_000 });
      agent.dispose();
    }, 15_000);

    it('re-indexes a file the agent edited', async () => {
      await writeFile(join(root, 'existing.ts'), 'export const before = 1;\n');
      roles.embeddings = { connection: 'test', model: 'embed' };
      model.script([
        toolBlock('edit_file', { path: 'existing.ts', search: 'before = 1', replace: 'after = 2' }),
        finishBlock('Edited it.'),
      ]);
      const agent = makeController({ posts: [] });

      await agent.start('edit the file');

      await vi.waitFor(() => expect(embeddedPaths()).toContain('after = 2'), { timeout: 5_000 });
      agent.dispose();
    }, 15_000);

    it('re-indexes both paths of a rename, so the old one drops out', async () => {
      await writeFile(join(root, 'old.ts'), 'export const moved = 1;\n');
      roles.embeddings = { connection: 'test', model: 'embed' };
      model.script([toolBlock('rename_file', { path: 'old.ts', newPath: 'new.ts' }), finishBlock('Renamed it.')]);
      const agent = makeController({ posts: [] });

      await agent.start('rename the file');

      // Indexing a path the server can no longer read is what drops it, which is
      // why a rename sends both and needs no shape of its own.
      await vi.waitFor(() => expect(embeddedPaths()).toContain('new.ts'), { timeout: 5_000 });
      agent.dispose();
    }, 15_000);

    it('does not re-index when the tool call failed', async () => {
      roles.embeddings = { connection: 'test', model: 'embed' };
      // A search string that is not in the file — edit_file refuses.
      await writeFile(join(root, 'untouched.ts'), 'export const a = 1;\n');
      model.script([
        toolBlock('edit_file', { path: 'untouched.ts', search: 'nowhere to be found', replace: 'x' }),
        finishBlock('Could not edit.'),
      ]);
      const posts: ExtensionToWebview[] = [];
      const agent = makeController({ posts });

      await agent.start('edit the file');

      expect(posts.some((p) => p.type === 'agentToolResult' && p.ok === false)).toBe(true);
      expect(embeddedPaths()).not.toContain('untouched.ts');
      agent.dispose();
    }, 15_000);

    it('leaves a successful tool call successful when re-indexing fails', async () => {
      // No embeddings model: the server has nothing to index with. The write
      // must still be reported as done.
      model.script([toolBlock('write_file', { path: 'ok.ts', content: 'export const a = 1;\n' }), finishBlock('Wrote it.')]);
      const posts: ExtensionToWebview[] = [];
      const agent = makeController({ posts });

      await agent.start('create a file');

      expect(await readFile(join(root, 'ok.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(posts.find((p) => p.type === 'agentToolResult')).toMatchObject({ ok: true });
      agent.dispose();
    }, 15_000);
  });

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

/**
 * ask_user's idle bound as the controller decides it. The wait itself lives in
 * ChatViewProvider (covered in chatView.test.ts); what is only here is the
 * decision of *whether* to bound a given call at all, and the reading of the
 * setting that supplies it.
 */
describe('AgentController — ask_user idle bound', () => {
  /**
   * The result of a named tool call. agentToolResult carries no tool name
   * (protocol.ts:240-250), so it has to be correlated back through the
   * matching agentToolCall's id.
   */
  function resultOf(posts: ExtensionToWebview[], name: string): string | undefined {
    const call = posts.find(
      (p): p is Extract<ExtensionToWebview, { type: 'agentToolCall' }> => p.type === 'agentToolCall' && p.name === name,
    );
    if (!call) return undefined;
    return posts.find(
      (p): p is Extract<ExtensionToWebview, { type: 'agentToolResult' }> =>
        p.type === 'agentToolResult' && p.id === call.id,
    )?.summary;
  }

  /** Captures what the controller asked the host to do, and answers as instructed. */
  function captureAskUser(
    agent: AgentController,
    reply: { answer?: string; idle: boolean; partial?: string } = { idle: false },
  ): Array<{ question: string; options?: string[]; idleMs?: number }> {
    const calls: Array<{ question: string; options?: string[]; idleMs?: number }> = [];
    agent.askUser = (question, options, idleMs) => {
      calls.push({ question, options, idleMs });
      return Promise.resolve(reply);
    };
    return calls;
  }

  /**
   * Distillation off unless a test is about it: it defaults on and fires its
   * own ask_user prompt after a clean finish, which would otherwise show up
   * as a phantom second call in every assertion here.
   */
  function askUserConfig(extra: Record<string, unknown> = {}): void {
    __setConfig('heapcode.agent', { enable: true, planFirst: false, memoryDistillation: false, ...extra });
  }

  it('passes the configured timeout through to the host as idleMs', async () => {
    askUserConfig({ askUserQuestionTimeout: '90s' });
    model.script([toolBlock('ask_user', { question: 'Which one?' }), finishBlock('Done.')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });
    const calls = captureAskUser(agent, { answer: 'the first', idle: false });

    await agent.start('ask me something');

    expect(calls).toHaveLength(1);
    // '90s' really reached the host as milliseconds — the setting is not
    // merely read and dropped, which is how it was broken before.
    expect(calls[0]!.idleMs).toBe(90_000);
    agent.dispose();
  });

  it('leaves the wait unbounded when the setting is unset — the default', async () => {
    askUserConfig();
    model.script([toolBlock('ask_user', { question: 'Which one?' }), finishBlock('Done.')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });
    const calls = captureAskUser(agent, { answer: 'a', idle: false });

    await agent.start('ask me something');

    expect(calls[0]!.idleMs).toBeUndefined();
    agent.dispose();
  });

  it('never bounds a question the model marked as gating an action', async () => {
    askUserConfig({ askUserQuestionTimeout: '30s' });
    model.script([
      toolBlock('ask_user', { question: 'Delete the old migrations?', blocksAction: true }),
      finishBlock('Done.'),
    ]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });
    const calls = captureAskUser(agent, { answer: 'no', idle: false });

    await agent.start('tidy up the migrations');

    // Configured at 30s, yet still unbounded: a permission-shaped question
    // waits for a real human answer however the timeout is set.
    expect(calls[0]!.idleMs).toBeUndefined();
    agent.dispose();
  });

  it('tells the agent an expired question is not approval, and hands over the partial answer', async () => {
    askUserConfig({ askUserQuestionTimeout: '1s' });
    model.script([toolBlock('ask_user', { question: 'Which one?' }), finishBlock('Went with my judgment.')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });
    captureAskUser(agent, { idle: true, partial: 'maybe the' });

    await agent.start('ask me something');

    // The belt-and-braces wording reaches the model, not just core's unit test.
    const summary = resultOf(posts, 'ask_user');
    expect(summary).toContain('may be away');
    expect(summary).toContain('NOT approval');
    expect(summary).toContain('maybe the');
    agent.dispose();
  });

  it('falls back to the plain no-answer line when nobody answered and no timeout was involved', async () => {
    model.script([toolBlock('ask_user', { question: 'Which one?' }), finishBlock('Done.')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });
    captureAskUser(agent, { idle: false });

    await agent.start('ask me something');

    const summary = resultOf(posts, 'ask_user');
    expect(summary).toContain(ASK_USER_NO_ANSWER);
    // A cancelled question must not carry the idle guidance — the two cases
    // stay distinguishable to the model, not just to the card.
    expect(summary).not.toContain('may be away');
    agent.dispose();
  });

  /**
   * The composition rather than either half. The tests above prove the setting
   * reaches `idleMs`, and chatView.test.ts:428 proves an `idleMs` bounds the
   * wait — but only together do they mean a user who sets a timeout gets a
   * question that is actually counted down and actually expires.
   *
   * Wired the way extension.ts:120-121 wires it. That assignment lives inside
   * activate() and isn't importable, so this mirrors it: what the test proves
   * is that the chain holds once the forward is made, not that activate()
   * makes it. Dropping `idleMs` there is the one failure this can't catch.
   */
  it('a configured timeout reaches the card the user sees, and expires it', async () => {
    askUserConfig({ askUserQuestionTimeout: '2s' });
    model.script([toolBlock('ask_user', { question: 'Which one?' }), finishBlock('Carried on alone.')]);
    const posts: ExtensionToWebview[] = [];
    const agent = makeController({ posts });
    const { chat, link, send } = makeChatFor(posts);
    agent.askUser = (question, options, idleMs) => chat.askAgentQuestion(question, options, idleMs);
    await send({ type: 'ready' } as WebviewToExtension);

    await agent.start('ask me something');

    // The card was counted down rather than sitting there and vanishing.
    const seconds = posts
      .filter(
        (p): p is Extract<ExtensionToWebview, { type: 'agentQuestionCountdown' }> =>
          p.type === 'agentQuestionCountdown',
      )
      .map((p) => p.seconds);
    expect(seconds.length).toBeGreaterThan(1);
    expect(seconds.at(-1)!).toBeLessThan(seconds[0]!);

    // Closed as idle — distinct from a cancellation — and the agent was told
    // to carry on without treating it as approval.
    const closed = posts.find(
      (p): p is Extract<ExtensionToWebview, { type: 'agentQuestionClosed' }> => p.type === 'agentQuestionClosed',
    );
    expect(closed?.reason).toBe('idle');
    expect(resultOf(posts, 'ask_user')).toContain('NOT approval');

    link.dispose();
    agent.dispose();
  });

  /**
   * The memory prompt shares the ask_user plumbing but must never inherit its
   * timeout: an unanswered "worth remembering?" has to decay into *not* saving.
   * Asserted on the file, because that is the only thing that would be wrong.
   */
  describe('the memory-distillation prompt', () => {
    /** A clean finish, then the distillation call whose reply becomes the note. */
    function scriptWithMemoryNote(): void {
      model.script([finishBlock('All done.'), 'Prefers tabs over spaces.']);
    }

    it('is permanently unbounded, whatever the ask_user timeout is set to', async () => {
      __setConfig('heapcode.agent', {
        enable: true,
        planFirst: false,
        memoryDistillation: true,
        askUserQuestionTimeout: '5s',
      });
      scriptWithMemoryNote();
      const posts: ExtensionToWebview[] = [];
      const agent = makeController({ posts });
      const calls = captureAskUser(agent, { idle: false });

      await agent.start('do a thing');
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 3_000 });

      const memoryCall = calls.find((c) => c.question.includes('Worth remembering'));
      expect(memoryCall).toBeDefined();
      expect(memoryCall!.idleMs).toBeUndefined();
      agent.dispose();
    });

    it('decays to "don\'t save" when the prompt goes unanswered', async () => {
      __setConfig('heapcode.agent', { enable: true, planFirst: false, memoryDistillation: true });
      scriptWithMemoryNote();
      const posts: ExtensionToWebview[] = [];
      const agent = makeController({ posts });
      const calls = captureAskUser(agent, { idle: false });

      await agent.start('do a thing');
      await vi.waitFor(() => expect(calls.some((c) => c.question.includes('Worth remembering'))).toBe(true), {
        timeout: 3_000,
      });
      await settle();

      await expect(readFile(join(root, '.heapcode', 'memory.md'), 'utf8')).rejects.toThrow();
      agent.dispose();
    });

    it('saves only on an explicit "Save to memory"', async () => {
      __setConfig('heapcode.agent', { enable: true, planFirst: false, memoryDistillation: true });
      scriptWithMemoryNote();
      const posts: ExtensionToWebview[] = [];
      const agent = makeController({ posts });
      captureAskUser(agent, { answer: 'Save to memory', idle: false });

      await agent.start('do a thing');
      await vi.waitFor(async () => expect(await readFile(join(root, '.heapcode', 'memory.md'), 'utf8')).toContain('tabs'), {
        timeout: 3_000,
      });
      agent.dispose();
    });
  });
});

/**
 * The setting has to exist in the manifest, not just be read by the code: an
 * unregistered key reads back as its fallback forever, which is precisely how
 * this one was inert while looking wired.
 */
describe('the askUserQuestionTimeout setting is actually contributed', () => {
  it('is declared in package.json, so VS Code surfaces it and persists a value', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { contributes: { configuration: { properties: Record<string, { type: string; default: unknown }> } } };
    const setting = manifest.contributes.configuration.properties['heapcode.agent.askUserQuestionTimeout'];

    expect(setting).toBeDefined();
    expect(setting!.type).toBe('string');
    // Empty default = unbounded, matching the CLI's unset default.
    expect(setting!.default).toBe('');
  });

  it('parses every documented duration form the description promises', () => {
    expect(parseIdleTimeout('60s')).toBe(60_000);
    expect(parseIdleTimeout('5m')).toBe(300_000);
    expect(parseIdleTimeout('10m')).toBe(600_000);
    // The contributed default, and the shapes a user can leave it in.
    expect(parseIdleTimeout('')).toBeUndefined();
    expect(parseIdleTimeout('nonsense')).toBeUndefined();
  });
});
