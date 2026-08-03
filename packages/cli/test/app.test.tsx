import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatResponse, Conversation, McpManager, Provider, ProviderProfileConfig, ToolDefinition } from '@heapcode/core';
import { HeapcodeServer } from '@heapcode/core';
import { SecretsStore } from '../src/config/secrets.js';
import { ConfigStore } from '../src/config/store.js';
import { JsonConversationStore } from '../src/history/store.js';
import { WorkspaceToolExecutor } from '../src/agent/workspaceTools.js';
import { SessionCheckpoint } from '../src/agent/checkpoint.js';
import { PermissionEngine } from '../src/agent/permissions.js';
import type { ShadowGit } from '../src/agent/shadowGit.js';
import { App } from '../src/ink/App.js';
import type { RepoMapIndexer } from '../src/rag/repoMapIndexer.js';

function stubRepoMap(overrides: Record<string, unknown> = {}): RepoMapIndexer {
  return {
    ready: false,
    init: vi.fn().mockResolvedValue(undefined),
    buildIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RepoMapIndexer;
}
function stubMcp(overrides: Record<string, unknown> = {}): McpManager {
  return {
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getToolDefinitions: vi.fn().mockReturnValue([]),
    connectedServerNames: vi.fn().mockReturnValue([]),
    isMcpTool: (name: string) => name.startsWith('mcp__'),
    call: vi.fn(),
    ...overrides,
  } as unknown as McpManager;
}

/**
 * A mutable OpenAI-compatible fake. core/test/mockServer.ts takes its
 * behavior at construction; these tests set the reply per test, after the
 * server is already up, so this is the same idea with a settable script.
 */
interface ModelServer {
  baseUrl: string;
  /** Message arrays from each chat request, in order — the shape recordingProvider.requests used to expose. */
  requests: Array<Array<{ role: string; content: string }>>;
  /** Input batches from each /embeddings request — proof the server indexed something. */
  embeddingCalls: string[][];
  /** Non-streaming chat bodies: contextual retrieval, rerank and PR review all land here. */
  nonStreamedChats: Array<Array<{ role: string; content: string }>>;
  /**
   * Script the tool calls the next non-streamed replies carry. PR review's loop
   * terminates by calling a report tool, and it uses `chat` (non-streamed),
   * unlike an agent turn.
   */
  toolReply(calls: Array<{ name: string; args: unknown }>): void;
  reply(text: string): void;
  script(texts: string[]): void;
  close(): Promise<void>;
}

async function startModelServer(): Promise<ModelServer> {
  let script: string[] = [''];
  let call = 0;
  const requests: ModelServer['requests'] = [];
  const embeddingCalls: string[][] = [];
  const nonStreamedChats: ModelServer['nonStreamedChats'] = [];
  let nonStreamedToolCalls: Array<{ name: string; args: unknown }> = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw
        ? (JSON.parse(raw) as { messages?: Array<{ role: string; content: string }>; input?: string[]; stream?: boolean })
        : {};

      // Embeddings, contextual retrieval and rerank all reach this same
      // endpoint now that RAG runs in the server. Only *streamed* chat is an
      // agent turn, so only that advances the script and is recorded — the
      // rest would otherwise desync every scripted test.
      if (req.url?.includes('/embeddings')) {
        embeddingCalls.push(body.input ?? []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: (body.input ?? []).map((_, i) => ({ embedding: [1, 0, 0], index: i })) }));
        return;
      }
      if (body.stream !== true) {
        nonStreamedChats.push((body.messages ?? []).map((m) => ({ role: m.role, content: m.content })));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls:
                    nonStreamedToolCalls.length > 0
                      ? nonStreamedToolCalls.map((c, i) => ({
                          id: `nsc-${i}`,
                          type: 'function',
                          function: { name: c.name, arguments: JSON.stringify(c.args) },
                        }))
                      : undefined,
                },
              },
            ],
          }),
        );
        return;
      }

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
    embeddingCalls,
    nonStreamedChats,
    toolReply: (calls) => {
      nonStreamedToolCalls = calls;
    },
    reply: (text) => {
      script = [text];
      call = 0;
    },
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
 * The agent loop runs in the core server now, so it reaches the model over
 * HTTP rather than through an injected Provider object. These three keep
 * their old names and call signatures — they script `model` instead of
 * returning a working client — so every existing test body is unchanged.
 *
 * The returned stub is still passed as App's `provider` prop, which is now
 * used only by /model's listModels and /pr-review; neither is part of the
 * agent path this migration moved.
 */
function providerStub(): Provider {
  return {
    chat: () => Promise.reject(new Error('the agent loop runs server-side')),
    streamChat: async function* () {
      yield { content: '' };
    },
    chatStreamed: () => Promise.reject(new Error('the agent loop runs server-side')),
    completion: () => Promise.reject(new Error('not used')),
    embeddings: () => Promise.reject(new Error('not used')),
    listModels: () => Promise.resolve([]),
  };
}

function fakeProvider(reply: string): Provider {
  model.reply(reply);
  return providerStub();
}

/** Returns responses[0], then responses[1], etc — same scripted shape as before, now driven over HTTP. */
function scriptedProvider(responses: ChatResponse[]): Provider {
  model.script(responses.map((r) => r.content));
  return providerStub();
}

const WRITE_FILE_TOOL: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  permission: 'write',
};

const ASK_USER_TOOL: ToolDefinition = {
  name: 'ask_user',
  description: 'Ask the user a clarifying question',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, blocksAction: { type: 'boolean' } },
    required: ['question'],
  },
  permission: 'read',
};

const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  permission: 'read',
};

/**
 * App is a client of the core server now, so the agent loop no longer runs in
 * this process. The harness starts a real HeapcodeServer and a real HTTP
 * model endpoint, and App reaches both the same way it does in production —
 * over a unix socket for the protocol, over HTTP for the model.
 *
 * The server runs in *this* process rather than being spawned, exactly as the
 * headless.ts migration's harness does: every message still crosses a real
 * socket with real NDJSON framing and real bidirectional RPC, but the tests
 * don't depend on `pnpm build` having produced dist/daemon.js. Autostart's
 * spawning path is covered separately.
 *
 * No assertion in this file changed — only how the model reply is scripted
 * (`model`, above) and how App is pointed at a server.
 */
let root: string;
let home: string;
let model: ModelServer;
let core: HeapcodeServer;
let profile: ProviderProfileConfig;
let serverOpts: { address: string; token: string; autostart: false };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-app-'));
  home = await mkdtemp(join(tmpdir(), 'hc-app-home-'));
  vi.stubEnv('HEAPCODE_HOME', home);
  model = await startModelServer();
  profile = { name: 'test', preset: 'custom', baseUrl: model.baseUrl, model: 'mock' };
  core = new HeapcodeServer({ home, address: join(home, 't.sock'), idleShutdownMs: 0 });
  await core.listen();
  serverOpts = { address: core.address, token: core.token, autostart: false };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await core?.close();
  await model?.close();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/**
 * A tool-call-free reply with the fallback (nativeToolCalls: false) protocol
 * ends the agent loop in exactly one round trip via `events.onText` — no
 * tool blocks to parse, no finish-reminder dance. That determinism is why
 * these tests all run with nativeToolCalls: false rather than true.
 */
/** Replies with a fixed text; `requests` reads what the model server actually received. */
function recordingProvider(reply: string): Provider & { requests: Array<Array<{ role: string; content: string }>> } {
  model.reply(reply);
  return { ...providerStub(), get requests() { return model.requests; } } as Provider & {
    requests: Array<Array<{ role: string; content: string }>>;
  };
}

/**
 * Turns on semantic indexing for one test. RAG runs in the server now, so
 * there is nothing to stub: the server indexes `root` for real and answers
 * over the socket. `embeddingsModel` is off by default so the rest of the
 * suite sees no embeddings traffic at all.
 */
function withEmbeddings(): void {
  profile.embeddingsModel = 'embed';
}

/**
 * NOTE for the tests below: renderApp defaults `cwd` to undefined, which makes
 * App send process.cwd() as the session root — this repo. Any test that
 * exercises real indexing passes `cwd: root` so the server indexes its own
 * temp workspace instead.
 */

function renderApp(overrides: {
  /**
   * Kept in this signature, deliberately not forwarded: App has no `provider`
   * prop any more. Every call site still passes one because passing it is how
   * the model gets scripted (see the helpers above).
   */
  provider: Provider;
  conversation: Conversation;
  historyStore: JsonConversationStore;
  tools?: ToolDefinition[];
  configStore?: ConfigStore;
  switchProvider?(p: ProviderProfileConfig): Promise<{ contextWindow: number }>;
  cwd?: string;
  listWorkspaceFiles?(): Promise<string[]>;
  repoMapIndexer?: RepoMapIndexer;
  mcpManager?: McpManager;
  shadowGit?: ShadowGit;
  onSessionChange?(id: string): void;
  checkUpdate?(): Promise<{ current: string; latest: string } | undefined>;
  askUserIdleMs?: number;
  /** Overrides the harness's in-process server — used by the autostart test. */
  server?: React.ComponentProps<typeof App>['server'];
}) {
  const checkpoint = new SessionCheckpoint(root);
  const executor = new WorkspaceToolExecutor(root, checkpoint, 5_000);
  const permissions = new PermissionEngine(join(root, 'permissions.json'));
  const secretsStore = new SecretsStore(join(home, 'secrets.json'));
  return render(
    <App
      profile={profile}
      conversation={overrides.conversation}
      historyStore={overrides.historyStore}
      executor={executor}
      checkpoint={checkpoint}
      permissions={permissions}
      shadowGit={overrides.shadowGit}
      onSessionChange={overrides.onSessionChange}
      tools={overrides.tools ?? []}
      nativeToolCalls={false}
      workspaceName="test"
      contextWindow={32_768}
      configStore={overrides.configStore}
      switchProvider={overrides.switchProvider}
      cwd={overrides.cwd}
      listWorkspaceFiles={overrides.listWorkspaceFiles}
      repoMapIndexer={overrides.repoMapIndexer}
      mcpManager={overrides.mcpManager}
      checkUpdate={overrides.checkUpdate}
      secretsStore={secretsStore}
      askUserIdleMs={overrides.askUserIdleMs}
      server={overrides.server ?? serverOpts}
    />,
  );
}

describe('App', () => {
  it('renders the composer and status line without crashing', () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { lastFrame } = renderApp({ provider: fakeProvider('hi'), conversation, historyStore });

    expect(lastFrame()).toContain('test · mock');
    expect(lastFrame()).toContain('Type a message');
  });

  it('replays prior conversation messages via the Static transcript', () => {
    const conversation: Conversation = {
      id: 'c1',
      title: 't',
      updatedAt: 0,
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { lastFrame } = renderApp({ provider: fakeProvider('hi'), conversation, historyStore });

    expect(lastFrame()).toContain('earlier question');
  });

  it('sends a message on submit and shows the agent reply in the transcript', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const save = vi.fn();
    const historyStore = { save } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('Hello there'), conversation, historyStore });

    // Ink enables raw-mode stdin listening in a useEffect, which runs after
    // this first tick — writing to stdin before it settles is dropped.
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('hi');
    stdin.write('\r');
    // Poll rather than sleep a fixed amount: runAgent() round-trips a real
    // socket, and the reply had only ~15ms of slack inside the old 50ms sleep
    // (it needs ~35ms), so any load on the machine turned this into a failure.
    // Same pattern as every other assertion in this file.
    await vi.waitFor(() => expect(lastFrame()).toContain('Hello there'), { timeout: 2_000 });
    await vi.waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 2_000 });
  });

  it('a tool call prompts for permission, and approving it (default "Allow once") runs the tool and shows its result', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = scriptedProvider([
      { content: '<tool name="write_file">\n{"path": "greeting.txt", "content": "hello from agent"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Wrote greeting.txt as requested."}\n</tool>' },
    ]);

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore, tools: [WRITE_FILE_TOOL] });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('write a greeting file');
    stdin.write('\r');

    // Permission prompt appears before the tool actually runs.
    await vi.waitFor(() => expect(lastFrame()).toContain('wants to modify files'), { timeout: 2_000 });
    expect(lastFrame()).toContain('greeting.txt');
    await expect(readFile(join(root, 'greeting.txt'), 'utf8')).rejects.toThrow(); // not written yet

    // SelectInput defaults to its first item — "Allow once" — so Enter alone accepts it.
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('Wrote greeting.txt'), { timeout: 2_000 });
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('hello from agent');
    await vi.waitFor(() => expect(historyStore.save).toHaveBeenCalled());
  });

  it('a successful write_file re-indexes that file in both the RAG and repo-map indexes', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = scriptedProvider([
      { content: '<tool name="write_file">\n{"path": "greeting.md", "content": "hello from agent"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Wrote greeting.md as requested."}\n</tool>' },
    ]);
    withEmbeddings();
    const repoMapIndexer = stubRepoMap({ noteRecent: vi.fn(), indexOne: vi.fn().mockResolvedValue(undefined) });

    const { stdin, lastFrame } = renderApp({
      provider,
      conversation,
      historyStore,
      tools: [WRITE_FILE_TOOL],
      repoMapIndexer,
      cwd: root,
    });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('write a greeting file');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('wants to modify files'), { timeout: 2_000 });
    stdin.write('\r'); // Allow once

    await vi.waitFor(() => expect(lastFrame()).toContain('Wrote greeting.md'), { timeout: 2_000 });
    // greeting.md rather than .txt: `.txt` is not in CODE_EXTENSIONS, so the
    // semantic index would correctly skip it and this test would prove nothing
    // about the RAG half.
    //
    // The RAG half of this assertion is end-to-end now rather than a spy on a
    // local indexer: App sends `rag/index { paths: ['greeting.md'] }`, the
    // server chunks the file and embeds it, and the embeddings request lands
    // on this test's model endpoint. Proving the *embedding* happened is
    // strictly stronger than proving a method was called.
    await vi.waitFor(() =>
      expect(model.embeddingCalls.some((batch) => batch.some((input) => input.includes('greeting.md')))).toBe(true),
    );
    expect(repoMapIndexer.indexOne).toHaveBeenCalledWith('greeting.md');
    expect(repoMapIndexer.noteRecent).toHaveBeenCalledWith('greeting.md');
  });

  it('denying a permission prompt ("Deny") does not run the tool and reports the denial to the model', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = scriptedProvider([
      { content: '<tool name="write_file">\n{"path": "greeting.txt", "content": "hello from agent"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Understood, not writing the file."}\n</tool>' },
    ]);

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore, tools: [WRITE_FILE_TOOL] });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('write a greeting file');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('wants to modify files'), { timeout: 2_000 });

    // Down three times from "Allow once" reaches "Deny" (Allow once / Session / Always / Deny for a
    // write tool). A small gap between each keypress, same reasoning as Composer's own tests: Ink
    // processes these outside React's batching, so back-to-back synchronous writes in the same tick
    // can outrun ink-select-input's own state update between keypresses.
    stdin.write('[B');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('[B');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('[B');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('Understood, not writing the file'), { timeout: 2_000 });
    await expect(readFile(join(root, 'greeting.txt'), 'utf8')).rejects.toThrow();
  });

  it('an empty conversation shows getting-started tips; a continued one shows the continuation line', () => {
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const empty: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const fresh = renderApp({ provider: fakeProvider('hi'), conversation: empty, historyStore });
    expect(fresh.lastFrame()).toContain('Tips for getting started');
    expect(fresh.lastFrame()).not.toContain('continuing last conversation');
    fresh.unmount();

    const continued: Conversation = {
      id: 'c2',
      title: 't',
      updatedAt: 0,
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    };
    const resumed = renderApp({ provider: fakeProvider('hi'), conversation: continued, historyStore });
    expect(resumed.lastFrame()).toContain('continuing last conversation (2 messages)');
    expect(resumed.lastFrame()).not.toContain('Tips for getting started');
  });

  it('renders the session banner with model and profile', () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { lastFrame } = renderApp({ provider: fakeProvider('hi'), conversation, historyStore });

    expect(lastFrame()).toContain('heapcode');
    expect(lastFrame()).toContain('model: mock · profile: test');
  });

  it('typing "/" opens the slash-command autocomplete menu', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/');
    await new Promise((r) => setTimeout(r, 20));

    expect(lastFrame()).toContain('/help');
    expect(lastFrame()).toContain('/model');
    expect(lastFrame()).toContain('/settings');

    // Narrowing the filter narrows the menu ("/settings" only ever appears in it).
    stdin.write('mo');
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('/model');
    expect(lastFrame()).not.toContain('/settings');
  });

  it('/help lists the available commands as a system message', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/help');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Commands:');
    expect(lastFrame()).toContain('/profile');
    expect(lastFrame()).toContain('/rewind');
  });

  describe("ask_user's optional idle timeout", () => {
    /**
     * The wait is host-side (see core's askUser.ts) so these drive it through
     * the real UI: the model asks, the prompt appears, and the wait ends one of
     * three ways — an answer, cancellation, or the opt-in idle bound.
     */
    function askThenFinish(args: Record<string, unknown> = { question: 'Which database?' }) {
      return scriptedProvider([
        { content: `<tool name="ask_user">\n${JSON.stringify(args)}\n</tool>` },
        { content: '<tool name="finish">\n{"summary": "Went with my judgment."}\n</tool>' },
      ]);
    }

    /** What the model was told about the question, from the tool message it received next. */
    function toolReplyText(): string {
      return model.requests
        .flat()
        .map((m) => m.content)
        .join('\n');
    }

    it('waits indefinitely when no timeout is configured — the default', async () => {
      // Its own explicit test rather than an absence of failures: unbounded is
      // what almost everyone gets, and it is the behavior that existed before.
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const { stdin, lastFrame } = renderApp({
        provider: askThenFinish(),
        conversation,
        historyStore,
        tools: [ASK_USER_TOOL],
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('pick one');
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('Agent has a question'), { timeout: 3_000 });

      await new Promise((r) => setTimeout(r, 600));

      // Still up, still no countdown, and the agent has not been told anything.
      expect(lastFrame()).toContain('Agent has a question');
      expect(lastFrame()).not.toContain('the agent will carry on');
      expect(toolReplyText()).not.toContain('may be away');
    }, 15_000);

    it('resolves with the proceed-on-your-own-judgment result once the configured window passes', async () => {
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const { stdin, lastFrame } = renderApp({
        provider: askThenFinish(),
        conversation,
        historyStore,
        tools: [ASK_USER_TOOL],
        askUserIdleMs: 250,
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('pick one');
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('Agent has a question'), { timeout: 3_000 });

      // The prompt comes down on its own and the run finishes normally — not
      // aborted, not an error.
      await vi.waitFor(() => expect(lastFrame()).not.toContain('Agent has a question'), { timeout: 3_000 });
      await vi.waitFor(() => expect(toolReplyText()).toContain('may be away'), { timeout: 3_000 });
      expect(toolReplyText()).toContain('Proceed on your own judgment');
      // The belt-and-braces sentence travels with it.
      expect(toolReplyText()).toContain('NOT approval');
      await vi.waitFor(() => expect(lastFrame()).toContain('Went with my judgment'), { timeout: 3_000 });
    }, 15_000);

    it('shows a visible countdown for the last stretch of the wait', async () => {
      // ASK_USER_COUNTDOWN_MS is 20s, so any bound at or under that counts down
      // from the moment the question appears.
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const { stdin, lastFrame } = renderApp({
        provider: askThenFinish(),
        conversation,
        historyStore,
        tools: [ASK_USER_TOOL],
        askUserIdleMs: 5_000,
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('pick one');
      stdin.write('\r');

      await vi.waitFor(() => expect(lastFrame()).toContain('the agent will carry on'), { timeout: 3_000 });
      expect(lastFrame()).toMatch(/no reply in \ds and the agent will carry on/);
    }, 15_000);

    it('carries the partial answer the user had typed', async () => {
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const { stdin, lastFrame } = renderApp({
        provider: askThenFinish(),
        conversation,
        historyStore,
        tools: [ASK_USER_TOOL],
        askUserIdleMs: 400,
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('pick one');
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('Agent has a question'), { timeout: 3_000 });
      stdin.write('postg'); // typed, never submitted

      await vi.waitFor(() => expect(toolReplyText()).toContain('may be away'), { timeout: 3_000 });
      expect(toolReplyText()).toContain('partial answer so far was: "postg"');
    }, 15_000);

    it('a keypress resets the countdown instead of letting it expire on schedule', async () => {
      // The property that protects a present-but-slow person. Typing every
      // ~150ms against a 400ms bound must outlast several windows.
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const { stdin, lastFrame } = renderApp({
        provider: askThenFinish(),
        conversation,
        historyStore,
        tools: [ASK_USER_TOOL],
        askUserIdleMs: 400,
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('pick one');
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('Agent has a question'), { timeout: 3_000 });

      for (let i = 0; i < 8; i++) {
        stdin.write('x');
        await new Promise((r) => setTimeout(r, 150));
      }

      // 1.2s elapsed against a 400ms bound: without the reset this would have
      // expired twice over.
      expect(lastFrame()).toContain('Agent has a question');
      expect(toolReplyText()).not.toContain('may be away');
    }, 15_000);

    it('never times out a question the model marked as gating an action', async () => {
      // blocksAction is the permission-shaped case, which must wait for a real
      // answer however the timeout is configured.
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const { stdin, lastFrame } = renderApp({
        provider: askThenFinish({ question: 'Delete the old migrations?', blocksAction: true }),
        conversation,
        historyStore,
        tools: [ASK_USER_TOOL],
        askUserIdleMs: 200,
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('clean up');
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('Agent has a question'), { timeout: 3_000 });

      await new Promise((r) => setTimeout(r, 900));

      expect(lastFrame()).toContain('Agent has a question');
      expect(lastFrame()).not.toContain('the agent will carry on');
      expect(toolReplyText()).not.toContain('may be away');
    }, 15_000);

    it('cancellation during a pending question still resolves the way it always did', async () => {
      // Unchanged path: Esc takes the prompt down and the agent gets the plain
      // no-answer result, not the idle one.
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const { stdin, lastFrame } = renderApp({
        provider: askThenFinish(),
        conversation,
        historyStore,
        tools: [ASK_USER_TOOL],
        askUserIdleMs: 60_000,
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('pick one');
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('Agent has a question'), { timeout: 3_000 });

      stdin.write('\u001B'); // Esc
      await vi.waitFor(() => expect(lastFrame()).not.toContain('Agent has a question'), { timeout: 3_000 });
      expect(toolReplyText()).not.toContain('may be away');
    }, 15_000);

    it('leaves other tool calls unbounded, with or without the setting', async () => {
      // Nothing about this is a general tool/execute timeout: a command that
      // takes longer than the configured ask_user window still runs to
      // completion.
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const runTool: ToolDefinition = {
        name: 'run_command',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        permission: 'execute',
      };
      const provider = scriptedProvider([
        { content: '<tool name="run_command">\n{"command": "sleep 1 && echo late"}\n</tool>' },
        { content: '<tool name="finish">\n{"summary": "Command finished."}\n</tool>' },
      ]);

      const { stdin, lastFrame } = renderApp({
        provider,
        conversation,
        historyStore,
        tools: [runTool],
        askUserIdleMs: 100,
        cwd: root,
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('run something slow');
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('wants to run'), { timeout: 3_000 });
      stdin.write('\r'); // allow once

      await vi.waitFor(() => expect(lastFrame()).toContain('Command finished'), { timeout: 8_000 });
      expect(toolReplyText()).toContain('late');
    }, 20_000);
  });

  it('/pr-review drives the review in the server and shows its progress and preview', async () => {
    // The review is a tool loop, so it crossed as its own method (review/run)
    // rather than as agent/run. What matters host-side is that the transcript
    // adapter still works: progress lines land, the preview renders, the
    // read-only tool loop reaches this process, and "Don't post" posts nothing.
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const { mkdtemp: mkTmp, writeFile, chmod, access } = await import('node:fs/promises');
    const bin = await mkTmp(join(tmpdir(), 'hc-app-gh-'));
    const postLog = join(bin, 'posts.log');
    await writeFile(
      join(bin, 'gh'),
      `#!/bin/sh
case "$1 $2" in
  "--version ") echo "gh version 2.0.0"; exit 0 ;;
esac
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '{"number":7,"title":"Tiny change","url":"https://github.com/o/r/pull/7","headRefOid":"deadbee"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  printf 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n'
  exit 0
fi
echo "posted" >> "${postLog}"
exit 0
`,
      'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    model.toolReply([
      {
        name: 'report_findings',
        args: {
          summary: 'Adds a constant.',
          findings: [
            {
              file: 'x.ts',
              line: 2,
              severity: 'low',
              category: 'maintainability',
              summary: 'b is unused',
              failure_scenario: 'Nothing reads b, so the constant is dead weight.',
            },
          ],
        },
      },
    ]);

    const { stdin, lastFrame } = renderApp({
      provider: fakeProvider('unused'),
      conversation,
      historyStore,
      cwd: root,
    });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/pr-review');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('PR review: reviewing the diff'), { timeout: 8_000 });
    await vi.waitFor(() => expect(lastFrame()).toContain("Don't post"), { timeout: 8_000 });
    expect(lastFrame()).toContain('PR #7');
    expect(lastFrame()).toContain('b is unused');

    stdin.write('\u001B[B'); // move to "Don't post"
    stdin.write('\r');
    // The transcript is long by now, so the invariant to assert is the one that
    // matters: declining posts nothing. The gh stub only writes postLog when a
    // posting verb runs.
    await vi.waitFor(() => expect(lastFrame()).not.toContain("Don't post"), { timeout: 8_000 });
    await expect(access(postLog)).rejects.toThrow();

    await rm(bin, { recursive: true, force: true });
  }, 25_000);

  it('/pr-review is offered as a command and rejects an unknown mode with usage instead of running a review', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    // A provider that would throw if the review actually started — the usage
    // branch has to bail out before any model call or any `gh` invocation.
    const provider = { chat: vi.fn(() => Promise.reject(new Error('should not run'))) } as unknown as Provider;

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/help');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain('/pr-review');

    stdin.write('/pr-review sideways');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Usage: /pr-review');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('/settings shows the current configuration readout', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/settings');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Profile     test (custom)');
    // The profile's endpoint is the harness's model server now, not a dummy.
    expect(lastFrame()).toContain('Endpoint    ' + model.baseUrl);
    expect(lastFrame()).toContain('Model       mock');
  });

  it('an unknown slash command reports an error instead of going to the agent', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const save = vi.fn();
    const historyStore = { save } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('should not appear'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/nope');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Unknown command /nope');
    expect(lastFrame()).not.toContain('should not appear');
  });

  it('/model <id> switches the session model directly', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/model llama3.1:8b');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Model set to llama3.1:8b');
    expect(lastFrame()).toContain('test · llama3.1:8b');
  });

  it('the slash menu includes the conversation-management commands', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/');
    await new Promise((r) => setTimeout(r, 20));

    expect(lastFrame()).toContain('/clear');
    expect(lastFrame()).toContain('/resume');
    expect(lastFrame()).toContain('/exit');
  });

  it('/profile add opens the in-session provider setup wizard', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const configStore = new ConfigStore(join(root, 'config.json'));

    const { stdin, lastFrame } = renderApp({
      provider: fakeProvider('unused'),
      conversation,
      historyStore,
      configStore,
      switchProvider: () => Promise.resolve({ contextWindow: 32_768 }),
    });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/profile add');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Add a provider profile');
    expect(lastFrame()).toContain('Which provider?');

    // Esc cancels back to the composer.
    stdin.write('');
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('Profile setup cancelled');
    expect(lastFrame()).not.toContain('Which provider?');
  });

  it('/profile with no profiles configured goes straight into the setup wizard', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const configStore = new ConfigStore(join(root, 'config.json'));

    const { stdin, lastFrame } = renderApp({
      provider: fakeProvider('unused'),
      conversation,
      historyStore,
      configStore,
      switchProvider: () => Promise.resolve({ contextWindow: 32_768 }),
    });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/profile');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Which provider?');
  });

  it('/profile list shows configured profiles with the active one marked', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const configStore = new ConfigStore(join(root, 'config.json'));
    await configStore.saveProfile({ name: 'test', preset: 'custom', baseUrl: 'http://x', model: 'mock' });
    await configStore.saveProfile({ name: 'other', preset: 'ollama', baseUrl: 'http://y', model: 'llama' });

    const { stdin, lastFrame } = renderApp({
      provider: fakeProvider('unused'),
      conversation,
      historyStore,
      configStore,
      switchProvider: () => Promise.resolve({ contextWindow: 32_768 }),
    });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/profile list');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('* test');
    expect(lastFrame()).toContain('other  (ollama, llama)');
  });

  it('/resume with no saved conversations reports that', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = new JsonConversationStore(join(root, 'conversations.json'));

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/resume');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('No saved conversations');
  });

  it('/resume lists saved conversations and loads the picked one', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = new JsonConversationStore(join(root, 'conversations.json'));
    await historyStore.save({
      id: 'old1',
      title: 'fix the login bug',
      updatedAt: Date.now() - 1000,
      messages: [
        { role: 'user', content: 'fix the login bug' },
        { role: 'assistant', content: 'Fixed by updating auth.ts' },
      ],
    });

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/resume');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Resume a conversation'), { timeout: 2_000 });
    expect(lastFrame()).toContain('fix the login bug');

    stdin.write('\r'); // pick the first (only) conversation
    await vi.waitFor(() => expect(lastFrame()).toContain('Fixed by updating auth.ts'), { timeout: 2_000 });
  });

  it('a follow-up message carries the prior turns as agent history', async () => {
    const conversation: Conversation = {
      id: 'c1',
      title: 't',
      updatedAt: 0,
      messages: [
        { role: 'user', content: 'what are my options?' },
        { role: 'assistant', content: '1. add tests 2. refactor auth' },
      ],
    };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    // Was a hand-rolled recording provider; the loop is server-side now, so
    // what the model received is read off the model server instead.
    const provider = recordingProvider('On it.');

    const { stdin } = renderApp({ provider, conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('ok do the second option');
    stdin.write('\r');
    await vi.waitFor(() => expect(provider.requests.length).toBeGreaterThan(0), { timeout: 2_000 });

    const sent = provider.requests[0]!;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[1]!.content).toBe('what are my options?');
    expect(sent[3]!.content).toBe('ok do the second option');
  });

  it('conversations get a title from the first user message when persisted', async () => {
    const conversation: Conversation = { id: 'c1', title: 'New conversation', updatedAt: 0, messages: [] };
    const historyStore = new JsonConversationStore(join(root, 'conversations.json'));

    const { stdin } = renderApp({ provider: fakeProvider('Hello there'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('what does this repo do');
    stdin.write('\r');

    // Poll rather than sleep a fixed 100ms: the title is only written once the
    // turn has round-tripped a real socket *and* the store has hit disk, and
    // under parallel load that overran the fixed wait.
    await vi.waitFor(
      async () => expect((await historyStore.list())[0]?.title).toBe('what does this repo do'),
      { timeout: 5_000 },
    );
  }, 15_000);

  it('/persona architect filters write tools out of the offered set and prepends the persona addendum', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = recordingProvider('Here is my plan.');

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore, tools: [WRITE_FILE_TOOL] });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/persona architect');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Persona: Architect'));
    expect(lastFrame()).toContain('· Architect'); // footer

    stdin.write('plan a refactor');
    stdin.write('\r');
    await vi.waitFor(() => expect(provider.requests.length).toBeGreaterThan(0), { timeout: 2_000 });

    const [messages] = [provider.requests[0]!];
    // Fallback protocol embeds the offered tool definitions ("### name" blocks)
    // in the system prompt — the write_file definition must be gone. (The
    // prompt's fixed prose still mentions write_file by name, so match the block.)
    expect(messages[0]!.content).not.toContain('### write_file');
    expect(messages[messages.length - 1]!.content).toContain('Architect persona');
    expect(messages[messages.length - 1]!.content).toContain('Task: plan a refactor');
  });

  it('/explain renders the prompt template into the task while the transcript shows the raw command', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = recordingProvider('It adds numbers.');

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/explain src/utils.ts');
    stdin.write('\r');
    await vi.waitFor(() => expect(provider.requests.length).toBeGreaterThan(0), { timeout: 2_000 });

    const task = provider.requests[0]!.at(-1)!.content;
    expect(task).toContain('Explain the following code');
    expect(task).toContain('src/utils.ts');
    expect(lastFrame()).toContain('/explain src/utils.ts'); // transcript shows what the user typed
  });

  it('/review runs read-only even under the default Agent persona — the template says "point out", not "fix"', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = recordingProvider('Found one bug.');

    // Default persona (Agent) has full write access — without the readOnly
    // scoping, the model would still be offered write_file and could act on
    // its own findings instead of just reporting them (the live bug this
    // guards against: /review found issues, then quietly went and fixed them).
    const { stdin } = renderApp({ provider, conversation, historyStore, tools: [WRITE_FILE_TOOL] });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/review lib/utils.js');
    stdin.write('\r');
    await vi.waitFor(() => expect(provider.requests.length).toBeGreaterThan(0), { timeout: 2_000 });

    const messages = provider.requests[0]!;
    expect(messages[0]!.content).not.toContain('### write_file');
    expect(messages[messages.length - 1]!.content).toContain('Reviewer persona');
  });

  it('a bare prompt command reports usage instead of sending an empty template', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = recordingProvider('unused');

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/explain');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Usage: /explain');
    expect(provider.requests.length).toBe(0);
  });

  it('project instructions (HEAPCODE.md + memory.md) are injected into the agent task', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'HEAPCODE.md'), 'Always use tabs.');
    await writeFile(join(root, '.heapcode', 'memory.md'), 'API retries twice.');
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = recordingProvider('Done.');

    const { stdin } = renderApp({ provider, conversation, historyStore, cwd: root });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('do the thing');
    stdin.write('\r');
    await vi.waitFor(() => expect(provider.requests.length).toBeGreaterThan(0), { timeout: 2_000 });

    const task = provider.requests[0]!.at(-1)!.content;
    expect(task).toContain('Always use tabs.');
    expect(task).toContain('API retries twice.');
    expect(task).toContain('Task: do the thing');
  });

  it('/memory shows the loaded project context; /skills reports when none exist', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'HEAPCODE.md'), 'Always use tabs.');
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore, cwd: root });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/memory');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Always use tabs.'));

    stdin.write('/skills');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('No skills found'));
  });

  it('typing @ opens mention autocomplete from the workspace file list', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({
      provider: fakeProvider('unused'),
      conversation,
      historyStore,
      listWorkspaceFiles: () => Promise.resolve(['src/', 'src/index.ts', 'test/app.test.ts']),
    });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('look at @');
    await new Promise((r) => setTimeout(r, 50)); // candidates lazy-load on trigger
    stdin.write('ind');
    await new Promise((r) => setTimeout(r, 20));

    expect(lastFrame()).toContain('src/index.ts');

    // Tab completes the mention into the buffer.
    stdin.write('\t');
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('look at @src/index.ts');
  });

  it('delegate_task is always visible to the model; calling it with /subagents off returns an informative "disabled" error', async () => {
    // Hiding the tool entirely when disabled left the model with no concept
    // of delegation — a live session answered "delegate investigating X" by
    // fabricating a completed delegation. Visible-but-refused lets it
    // respond honestly (and point the user at /subagents on).
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = scriptedProvider([
      { content: '<tool name="delegate_task">\n{"task": "investigate strings.js"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Delegation is off; investigated it myself."}\n</tool>' },
    ]);

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('delegate investigating strings.js');
    stdin.write('\r');

    // The tool is in the system prompt even with sub-agents off…
    await vi.waitFor(() => expect(lastFrame()).toContain('investigated it myself'), { timeout: 3_000 });
    // …and the call resolved to the disabled notice with NO permission
    // prompt (nothing can run, so there is nothing to approve) and no
    // sub-agent activity (no indented ↳ chips).
    expect(lastFrame()).not.toContain('wants to run a command');
    expect(lastFrame()).not.toContain('↳');
  });

  it('a delegate_task call runs a full sub-agent turn and renders its tool calls indented under the outer chip', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = scriptedProvider([
      { content: '<tool name="delegate_task">\n{"task": "write a scratch file"}\n</tool>' }, // parent
      { content: '<tool name="write_file">\n{"path": "scratch.txt", "content": "hi"}\n</tool>' }, // sub-agent turn 1
      { content: '<tool name="finish">\n{"summary": "Wrote scratch.txt."}\n</tool>' }, // sub-agent turn 2
      { content: '<tool name="finish">\n{"summary": "Delegated and done."}\n</tool>' }, // parent turn 2
    ]);

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore, tools: [WRITE_FILE_TOOL] });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/subagents on');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('delegate the scratch file');
    stdin.write('\r');

    // Two permission prompts in sequence: delegate_task itself (execute), then
    // the sub-agent's own write_file (write) — both need "Allow once" (Enter).
    await vi.waitFor(() => expect(lastFrame()).toContain('wants to run a command'), { timeout: 2_000 });
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('wants to modify files'), { timeout: 2_000 });
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('Delegated and done'), { timeout: 3_000 });
    // The sub-agent's own write_file call rendered indented (↳ marker).
    expect(lastFrame()).toContain('↳');
    expect(await readFile(join(root, 'scratch.txt'), 'utf8')).toBe('hi');
  });

  it('/mcp reports "no servers" when none are connected, and lists connected ones otherwise', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const none = renderApp({ provider: fakeProvider('unused'), conversation, historyStore, mcpManager: stubMcp() });
    await new Promise((r) => setTimeout(r, 20));
    none.stdin.write('/mcp');
    none.stdin.write('\r');
    await vi.waitFor(() => expect(none.lastFrame()).toContain('No MCP servers connected'));
    none.unmount();

    const mcpManager = stubMcp({
      connectedServerNames: vi.fn().mockReturnValue(['filesystem']),
      getToolDefinitions: vi.fn().mockReturnValue([{ name: 'mcp__filesystem__read', description: '', parameters: {}, permission: 'execute' }]),
    });
    const connected = renderApp({ provider: fakeProvider('unused'), conversation, historyStore, mcpManager });
    await new Promise((r) => setTimeout(r, 20));
    connected.stdin.write('/mcp');
    connected.stdin.write('\r');
    await vi.waitFor(() => expect(connected.lastFrame()).toContain('Connected: filesystem'));
    expect(mcpManager.ensureConnected).toHaveBeenCalled();
  });

  it('an MCP tool call is dispatched to McpManager.call, not the workspace executor, and still goes through the permission prompt', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = scriptedProvider([
      { content: '<tool name="mcp__filesystem__read">\n{"path": "notes.txt"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Read the file via MCP."}\n</tool>' },
    ]);
    const mcpManager = stubMcp({
      getToolDefinitions: vi.fn().mockReturnValue([
        { name: 'mcp__filesystem__read', description: 'Read a file', parameters: { type: 'object', properties: {} }, permission: 'execute', untrustedOutput: true },
      ]),
      call: vi.fn().mockResolvedValue('file contents here'),
    });

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore, mcpManager });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('read notes.txt via mcp');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('wants to run a command'), { timeout: 2_000 });
    stdin.write('\r'); // Allow once

    await vi.waitFor(() => expect(lastFrame()).toContain('Read the file via MCP'), { timeout: 2_000 });
    expect(mcpManager.call).toHaveBeenCalledWith('mcp__filesystem__read', { path: 'notes.txt' });
  });

  it('/search uses the semantic index when ready, falling back to plain text search otherwise', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'auth.ts'), 'function authenticate() { return true; }\n');

    // No embeddings model → rag/query comes back empty, which is the same
    // condition the old `ragIndexer.ready` gate stood for, and /search falls
    // all the way back to the text-search tool.
    const noIndex = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });
    await new Promise((r) => setTimeout(r, 20));
    noIndex.stdin.write('/search authenticate');
    noIndex.stdin.write('\r');
    await vi.waitFor(() => expect(noIndex.lastFrame()).toContain('plain text search'), { timeout: 2_000 });
    expect(noIndex.lastFrame()).toContain('auth.ts');
    noIndex.unmount();

    // With one configured, the hits come back over rag/query from an index the
    // server built itself — no stub anywhere in the path.
    withEmbeddings();
    const withIndex = renderApp({ provider: fakeProvider('unused'), conversation, historyStore, cwd: root });
    await vi.waitFor(() => expect(model.embeddingCalls.length).toBeGreaterThan(0), { timeout: 3_000 });
    withIndex.stdin.write('/search authenticate');
    withIndex.stdin.write('\r');
    await vi.waitFor(() => expect(withIndex.lastFrame()).toMatch(/auth\.ts:\d+-\d+/), { timeout: 3_000 });
  });

  it('/search with no query shows usage', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/search');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain('Usage: /search');
  });

  it('/index rebuilds both indexes and reports their status', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    withEmbeddings();
    const repoMapIndexer = stubRepoMap({ ready: true });

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore, repoMapIndexer, cwd: root });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/index');
    stdin.write('\r');
    // Real counts from a real index — the file above plus whatever else the
    // harness left in the workspace, so the assertion is on shape not size.
    await vi.waitFor(() => expect(lastFrame()).toMatch(/Semantic search: idle — \d+ files, \d+ chunks/), { timeout: 3_000 });
    expect(lastFrame()).toContain('Repo map: ready');
  });

  it('always runs contextual retrieval, which is the CLI default and has no setting', async () => {
    // Decision 6 of the RAG migration: the toggles became per-request
    // parameters so each host keeps its own default. The CLI has never had a
    // setting for contextual retrieval and has always run it; the extension
    // ships it off. This pins the CLI half — packages/vscode/test/serverLinkRag.test.ts
    // pins the other.
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    profile.embeddingsModel = 'embed';
    profile.contextModel = 'ctx';

    renderApp({ provider: fakeProvider('unused'), conversation, historyStore, cwd: root });

    // A contextual-retrieval call is a non-streamed chat carrying the file and
    // its numbered snippets — that listing is what distinguishes it from a
    // rerank call.
    await vi.waitFor(
      () => expect(model.nonStreamedChats.some((m) => m.at(-1)!.content.includes('Snippets:'))).toBe(true),
      { timeout: 3_000 },
    );
  });

  it('@workspace pulls semantic search results into the agent task as context', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'auth.ts'), 'export function authenticate(user: string) {\n  return checkCredentials(user);\n}\n');
    withEmbeddings();
    const provider = recordingProvider('Done.');

    const { stdin } = renderApp({ provider, conversation, historyStore, cwd: root });
    await vi.waitFor(() => expect(model.embeddingCalls.length).toBeGreaterThan(0), { timeout: 3_000 });
    stdin.write('@workspace how does auth work');
    stdin.write('\r');
    await vi.waitFor(() => expect(provider.requests.length).toBeGreaterThan(0), { timeout: 3_000 });

    // The block comes back over rag/query as `formatted` — the one string every
    // consumer of RAG wants (docs/phase3-rag-design.md §1.2).
    const task = provider.requests[0]!.at(-1)!.content;
    expect(task).toContain('Relevant workspace context');
    expect(task).toMatch(/auth\.ts:\d+-\d+/);
  });

  it('@workspace falls back to the repo-map structural outline when no semantic index is ready', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = recordingProvider('Done.');
    const repoMapIndexer = stubRepoMap({
      ready: true,
      format: vi.fn().mockReturnValue('src/index.ts\n  function main()'),
    });

    const { stdin } = renderApp({ provider, conversation, historyStore, repoMapIndexer });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('@workspace what does this do');
    stdin.write('\r');
    await vi.waitFor(() => expect(provider.requests.length).toBeGreaterThan(0), { timeout: 2_000 });

    const task = provider.requests[0]!.at(-1)!.content;
    expect(task).toContain('Workspace structure overview');
    expect(task).toContain('src/index.ts');
  });

  it('/checkpoints and /rewind survive /new — they read shadow-git history, not the in-memory transcript', async () => {
    const { ShadowGit } = await import('../src/agent/shadowGit.js');
    const shadowGit = new ShadowGit(root, join(root, '.heapcode', 'shadow-git'));
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = scriptedProvider([
      { content: '<tool name="write_file">\n{"path": "a.txt", "content": "v1"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Wrote a.txt."}\n</tool>' },
    ]);

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore, tools: [WRITE_FILE_TOOL], shadowGit });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('write a.txt');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('wants to modify files'), { timeout: 2_000 });
    stdin.write('\r'); // Allow once
    await vi.waitFor(() => expect(lastFrame()).toContain('Wrote a.txt'), { timeout: 2_000 });

    stdin.write('/new');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('/checkpoints');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('write_file'), { timeout: 2_000 });

    stdin.write('/rewind 1');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Rewound to before'), { timeout: 2_000 });
    await expect(readFile(join(root, 'a.txt'), 'utf8')).rejects.toThrow(); // write_file created it; rewind removed it
  });

  it('a read_file result renders as multi-line, syntax-highlighted code instead of one squashed gray line', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'add.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = scriptedProvider([
      { content: '<tool name="read_file">\n{"path": "add.ts"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Read add.ts."}\n</tool>' },
    ]);

    const { stdin, lastFrame } = renderApp({ provider, conversation, historyStore, tools: [READ_FILE_TOOL] });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('read add.ts');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Read add.ts'), { timeout: 2_000 });

    // Newlines preserved (not squashed to one line via the old .replace(/\n/g, ' ')) — the
    // function signature and its body render as separate rows in the frame.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('function');
    expect(frame).toContain('return a + b');
    const sigLine = frame.split('\n').find((l) => l.includes('function'));
    expect(sigLine).not.toContain('return a + b'); // on its own line, not squashed together
  });

  it('onSessionChange fires with the initial conversation id, and again with a new one on /new', async () => {
    const conversation: Conversation = { id: 'session-abc', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const ids: string[] = [];

    const { stdin } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore, onSessionChange: (id) => ids.push(id) });
    await vi.waitFor(() => expect(ids).toEqual(['session-abc']));

    stdin.write('/new');
    stdin.write('\r');
    await vi.waitFor(() => expect(ids.length).toBe(2));

    expect(ids[1]).not.toBe('session-abc'); // a fresh id, not a repeat
  });

  it('/settings shows the session id and how to resume it later', async () => {
    const conversation: Conversation = { id: 'session-abc12345', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/settings');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('Session'));
    expect(lastFrame()).toContain('session-');
    expect(lastFrame()).toContain('--resume');
  });

  it('/revert with nothing to revert reports that instead of erroring', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/revert');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Nothing to revert');
  });

  it('shows a dim update-available line under the banner once the registry check resolves', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { lastFrame } = renderApp({
      provider: fakeProvider('unused'),
      conversation,
      historyStore,
      checkUpdate: () => Promise.resolve({ current: '0.1.0', latest: '0.2.0' }),
    });

    await vi.waitFor(() => expect(lastFrame()).toContain('Update available'));
    expect(lastFrame()).toContain('v0.1.0');
    expect(lastFrame()).toContain('v0.2.0');
  });

  it('shows nothing when the registry check finds no newer version (or is disabled entirely)', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { lastFrame } = renderApp({
      provider: fakeProvider('unused'),
      conversation,
      historyStore,
      checkUpdate: () => Promise.resolve(undefined),
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).not.toContain('Update available');
  });
});

/**
 * Behaviors that only exist because App is a protocol client now. The rest of
 * this file exercises the same socket path incidentally; these assert it.
 */
describe('App — core server integration', () => {
  const RUN_COMMAND_TOOL: ToolDefinition = {
    name: 'run_command',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    permission: 'execute',
  };

  it('opens exactly one session for the app, and reuses it across turns', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('one'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('first');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('one'), { timeout: 2_000 });
    expect(core.sessionCount).toBe(1);

    stdin.write('second');
    stdin.write('\r');
    await vi.waitFor(() => expect(model.requests.length).toBeGreaterThan(1), { timeout: 2_000 });
    // A second turn must not open a second session — the connection is the
    // session (docs/phase3-protocol-design.md §2).
    expect(core.sessionCount).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'Esc cancels the run AND the shell command the host is still running, not just the model call',
    async () => {
      const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
      const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
      const provider = scriptedProvider([{ content: '<tool name="run_command">\n{"command": "sleep 5"}\n</tool>' }]);

      const { stdin, lastFrame } = renderApp({
        provider,
        conversation,
        historyStore,
        tools: [RUN_COMMAND_TOOL],
      });

      await new Promise((r) => setTimeout(r, 20));
      stdin.write('run the slow thing');
      stdin.write('\r');

      await vi.waitFor(() => expect(lastFrame()).toContain('wants to run a command'), { timeout: 2_000 });
      stdin.write('\r'); // Allow once — the command starts
      // executor.describe renders run_command as "Run: <command>".
      await vi.waitFor(() => expect(lastFrame()).toContain('Run: sleep 5'), { timeout: 2_000 });

      const started = Date.now();
      stdin.write('\u001B'); // Esc → agent/cancel

      await vi.waitFor(() => expect(lastFrame()).toContain('Interrupted'), { timeout: 4_000 });
      // Comfortably under the 5s sleep: if only the model call were cancelled
      // the command would still be running and this would wait it out. Same
      // standard the headless migration's cancellation test held itself to.
      expect(Date.now() - started).toBeLessThan(3_000);
    },
    20_000,
  );

  it('autostarts the server when nothing is listening, then runs the turn', async () => {
    // Exercises the full §6 sequence through App's own path: the first
    // connect fails, the host starts a server, and poll-connect picks it up.
    // Here "spawn" starts a real HeapcodeServer rather than a detached
    // process, so the test needs no build — the sequence is the same one
    // headless.ts uses, whose detached spawn was verified end to end
    // separately.
    const address = join(home, 'late.sock');
    await core.close(); // nothing at `address`, and nothing at core's either

    let spawned = 0;
    let late: HeapcodeServer | undefined;
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const { stdin, lastFrame } = renderApp({
      provider: fakeProvider('started on demand'),
      conversation,
      historyStore,
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
      await new Promise((r) => setTimeout(r, 20));
      stdin.write('hello');
      stdin.write('\r');
      await vi.waitFor(() => expect(lastFrame()).toContain('started on demand'), { timeout: 6_000 });
      expect(spawned).toBe(1);
    } finally {
      await late?.close();
    }
  }, 20_000);

  it('reports a clear error when the server cannot be reached, rather than hanging', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    await core.close(); // nothing listening, and autostart is off in tests

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('never'), conversation, historyStore });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('hello');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toMatch(/Could not reach the Heap Code server/), { timeout: 4_000 });
  }, 15_000);
});
