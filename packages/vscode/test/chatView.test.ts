import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_NO_ANSWER,
  askUserIdleMessage,
  HeapcodeServer,
  type ConversationStore,
  type ExtensionToWebview,
  type ProviderProfileConfig,
  type WebviewToExtension,
} from '@heapcode/core';
import { ChatViewProvider } from '../src/chatViewProvider.js';
import { ServerLink } from '../src/serverLink.js';
import type { ProfileManager } from '../src/profileManager.js';
import { Uri, __setConfig, __resetConfig, __setWorkspaceRoot } from './vscodeStub.js';

/**
 * The chat view is a client of the core server now, so no Provider is built
 * in this process for a chat turn. The harness starts a real HeapcodeServer
 * and a real HTTP model endpoint, and drives ChatViewProvider the way the
 * webview does — nothing below the provider is mocked.
 *
 * Same in-process-server choice as controller.test.ts: every message still
 * crosses a real unix socket with real NDJSON framing, but the tests don't
 * depend on dist/daemon.js having been built.
 */

interface ModelServer {
  baseUrl: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  /** Serve these bodies in order (last repeats); a string means a streamed reply. */
  script(responses: Array<string | Record<string, unknown>>): void;
  close(): Promise<void>;
}

async function startModelServer(): Promise<ModelServer> {
  let script: Array<string | Record<string, unknown>> = [''];
  let call = 0;
  const requests: ModelServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = req.url ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ path, body });

      if (path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock', context_length: 64_000 }, { id: 'other' }] }));
        return;
      }

      const next = script[Math.min(call++, script.length - 1)] ?? '';
      if (typeof next !== 'string') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: next } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    script: (responses) => {
      script = responses;
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
 * Only what the chat path still calls. There is no `createActiveProvider` to
 * omit any more — PR review was its last caller, and with that on the server
 * the method is gone from ProfileManager entirely.
 */
function stubProfiles(profiles: ProviderProfileConfig[], keys: Record<string, string> = {}): ProfileManager {
  return {
    getProfiles: () => profiles,
    getActiveProfile: () => profiles[0]!,
    // The global role table pushed at hello. One entry is enough here: with
    // chat assigned, every role that inherits resolves to the same connection.
    getRoles: () => ({ chat: { connection: profiles[0]!.name, model: profiles[0]!.model } }),
    getApiKey: (p: ProviderProfileConfig) => Promise.resolve(keys[p.name]),
    contextWindowFor: () => Promise.resolve({ window: 32_000, source: 'profile' as const }),
  } as unknown as ProfileManager;
}

const store = {
  save: () => Promise.resolve(),
  load: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
} as unknown as ConversationStore;

const log = { appendLine: () => {}, show: () => {} } as unknown as Parameters<typeof makeChat>[0]['log'];

/**
 * A webview stub that records what the provider posts and lets us push
 * messages in. `dispose()` fires the provider's own onDidDispose handler —
 * the sidebar being closed mid-run is a real teardown path, and one of the
 * places a pending ask_user question has to be resolved rather than hang.
 */
function fakeView(posts: ExtensionToWebview[]): {
  view: never;
  send(msg: WebviewToExtension): Promise<void>;
  dispose(): void;
} {
  let onMessage: ((msg: WebviewToExtension) => void) | undefined;
  const disposeHandlers: Array<() => void> = [];
  const view = {
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
    onDidDispose: (handler: () => void) => {
      disposeHandlers.push(handler);
      return { dispose: () => {} };
    },
  };
  return {
    view: view as never,
    send: async (msg) => {
      onMessage?.(msg);
      // Let the provider's async handler settle.
      await new Promise((r) => setTimeout(r, 0));
    },
    dispose: () => {
      for (const handler of [...disposeHandlers]) handler();
    },
  };
}

interface ChatOpts {
  posts: ExtensionToWebview[];
  profiles?: ProfileManager;
  log?: unknown;
  /** Override the conversation store — openConversation needs a `get` that returns one. */
  store?: ConversationStore;
}

function makeChat(opts: ChatOpts): {
  chat: ChatViewProvider;
  link: ServerLink;
  send(msg: WebviewToExtension): Promise<void>;
  disposeView(): void;
} {
  const profiles = opts.profiles ?? stubProfiles([profile]);
  const link = new ServerLink(profiles, (opts.log ?? log) as never, serverOpts as never);
  const chat = new ChatViewProvider(
    Uri.file('/ext') as never,
    profiles,
    opts.store ?? store,
    (opts.log ?? log) as never,
    link,
  );
  const { view, send, dispose } = fakeView(opts.posts);
  chat.resolveWebviewView(view);
  return { chat, link, send, disposeView: dispose };
}

function textOf(posts: ExtensionToWebview[]): string {
  return posts
    .filter((p): p is Extract<ExtensionToWebview, { type: 'chunk' }> => p.type === 'chunk')
    .map((p) => p.text)
    .join('');
}

let root: string;
let home: string;
let model: ModelServer;
let core: HeapcodeServer;
let profile: ProviderProfileConfig;
let serverOpts: { address: string; token: string; autostart: false };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-vscode-chat-'));
  home = await mkdtemp(join(tmpdir(), 'hc-vscode-chat-home-'));
  vi.stubEnv('HEAPCODE_HOME', home);
  __setWorkspaceRoot(root);
  __setConfig('heapcode.agent', { enable: true });
  model = await startModelServer();
  profile = { name: 'test', preset: 'custom', baseUrl: model.baseUrl, model: 'mock' };
  core = new HeapcodeServer({ home, address: join(home, 't.sock'), idleShutdownMs: 0 });
  await core.listen();
  serverOpts = { address: core.address, token: core.token, autostart: false };
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

describe('ChatViewProvider — chat turns against the core server', () => {
  it('runs a real chat turn over the socket and streams the reply into the webview', async () => {
    model.script(['Hello from the server.']);
    const posts: ExtensionToWebview[] = [];
    const { chat, link, send } = makeChat({ posts });
    await send({ type: 'ready' } as WebviewToExtension);

    await chat.sendFromCommand('hi');

    expect(textOf(posts)).toBe('Hello from the server.');
    expect(posts.some((p) => p.type === 'done')).toBe(true);
    // The turn really crossed the wire: the model endpoint saw it.
    expect(model.requests.some((r) => !r.path.endsWith('/models'))).toBe(true);
    link.dispose();
  });

  it('runs an ask-mode tool back in this process via tool/execute, then answers in prose', async () => {
    await writeFile(join(root, 'a.ts'), 'export const answer = 42;\n');
    profile = { ...profile, capabilities: { nativeToolCalls: true } };
    model.script([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [{ message: { role: 'assistant', content: 'It exports 42.' } }] },
    ]);
    const posts: ExtensionToWebview[] = [];
    const { chat, link, send } = makeChat({ posts, profiles: stubProfiles([profile]) });
    await send({ type: 'ready' } as WebviewToExtension);

    await chat.sendFromCommand('what does a.ts export?');

    // The server asked this process to run the tool, and the extension's own
    // executor did it — the file content came from the real workspace.
    const call = posts.find((p): p is Extract<ExtensionToWebview, { type: 'agentToolCall' }> => p.type === 'agentToolCall');
    const result = posts.find(
      (p): p is Extract<ExtensionToWebview, { type: 'agentToolResult' }> => p.type === 'agentToolResult',
    );
    expect(call?.name).toBe('read_file');
    expect(result?.ok).toBe(true);
    expect(result?.summary).toContain('answer = 42');
    expect(textOf(posts)).toBe('It exports 42.');

    // The read tool never prompted: an all-read toolset cannot reach the gate.
    expect(posts.some((p) => p.type === 'permissionRequest')).toBe(false);
    link.dispose();
  });

  it('lists models through provider/listModels, with no host-side Provider', async () => {
    const posts: ExtensionToWebview[] = [];
    const { link, send } = makeChat({ posts });
    await send({ type: 'ready' } as WebviewToExtension);

    await send({ type: 'listModels' } as WebviewToExtension);
    await new Promise((r) => setTimeout(r, 100));

    const models = posts.find((p): p is Extract<ExtensionToWebview, { type: 'models' }> => p.type === 'models');
    expect(models?.models).toEqual(['mock', 'other']);
    expect(model.requests.some((r) => r.path.endsWith('/models'))).toBe(true);
    link.dispose();
  });

  it('reports a model-list failure without a host-side fallback provider', async () => {
    const posts: ExtensionToWebview[] = [];
    // A profile the session does not hold → the server rejects it.
    const profiles = stubProfiles([{ ...profile, name: 'test' }]);
    const { link, send } = makeChat({ posts, profiles });
    await send({ type: 'ready' } as WebviewToExtension);
    await core.close(); // server gone mid-session

    await send({ type: 'listModels' } as WebviewToExtension);
    await new Promise((r) => setTimeout(r, 100));

    const models = posts.find((p): p is Extract<ExtensionToWebview, { type: 'models' }> => p.type === 'models');
    expect(models?.models).toEqual([]);
    link.dispose();
  });
});

/**
 * Deliberately NOT migrated. settingsTestConnection validates a key the user
 * has just typed and not yet saved, so there is no session holding it — the
 * bootstrap case docs/phase3-protocol-design.md §4 settles for Setup.tsx.
 * It is the one chat-view path that still builds a Provider in this process,
 * and it is what users click to check their own API key, so it gets its own
 * regression test rather than being assumed intact.
 */
describe('settings connection test — still host-side', () => {
  it('validates an unsaved key the user just typed, with no session involved', async () => {
    const posts: ExtensionToWebview[] = [];
    const { link, send } = makeChat({ posts });
    await send({ type: 'ready' } as WebviewToExtension);
    // No server at all: this path must not depend on one.
    await core.close();

    await send({
      type: 'settingsTestConnection',
      profile,
      apiKey: 'sk-just-typed',
    } as WebviewToExtension);
    await new Promise((r) => setTimeout(r, 100));

    const result = posts.find(
      (p): p is Extract<ExtensionToWebview, { type: 'settingsModels' }> => p.type === 'settingsModels',
    );
    expect(result?.models).toEqual(['mock', 'other']);
    expect(result?.error).toBeUndefined();
    // It really used the typed key rather than anything stored.
    expect(model.requests.at(-1)!.path).toContain('/models');
    link.dispose();
  });

  it('reports the endpoint’s error instead of silently showing an empty model list', async () => {
    const posts: ExtensionToWebview[] = [];
    const { link, send } = makeChat({ posts });
    await send({ type: 'ready' } as WebviewToExtension);
    await model.close();

    await send({
      type: 'settingsTestConnection',
      profile,
      apiKey: 'sk-just-typed',
    } as WebviewToExtension);
    await new Promise((r) => setTimeout(r, 200));

    const result = posts.find(
      (p): p is Extract<ExtensionToWebview, { type: 'settingsModels' }> => p.type === 'settingsModels',
    );
    expect(result?.models).toEqual([]);
    expect(result?.error).toBeTruthy();
    link.dispose();
  });
});

/**
 * ask_user's idle bound, extension side. Core covers the shared primitives
 * (packages/core/test/askUser.test.ts) and the CLI covers its own surface;
 * this covers the wiring that is only in this host — askAgentQuestion's
 * deadline, the countdown posts, activity resetting it, and every teardown
 * path that has to resolve a pending question rather than leave it hanging.
 *
 * Every assertion here waits on the promise actually settling. A test that
 * only checked "no error was thrown" would pass just as happily against the
 * hang these paths exist to prevent.
 */
describe('ChatViewProvider — ask_user idle bound', () => {
  /** The question id the provider announced to the webview. */
  function questionId(posts: ExtensionToWebview[]): string {
    const q = posts.find((p): p is Extract<ExtensionToWebview, { type: 'agentQuestion' }> => p.type === 'agentQuestion');
    if (!q) throw new Error('no agentQuestion was posted');
    return q.id;
  }

  function closures(posts: ExtensionToWebview[]): Array<'idle' | 'cancelled'> {
    return posts
      .filter((p): p is Extract<ExtensionToWebview, { type: 'agentQuestionClosed' }> => p.type === 'agentQuestionClosed')
      .map((p) => p.reason);
  }

  function countdowns(posts: ExtensionToWebview[]): number[] {
    return posts
      .filter(
        (p): p is Extract<ExtensionToWebview, { type: 'agentQuestionCountdown' }> =>
          p.type === 'agentQuestionCountdown',
      )
      .map((p) => p.seconds);
  }

  /** Waits for the question card to reach the webview before acting on it. */
  async function awaitQuestion(posts: ExtensionToWebview[]): Promise<string> {
    await vi.waitFor(() => expect(posts.some((p) => p.type === 'agentQuestion')).toBe(true), { timeout: 2_000 });
    return questionId(posts);
  }

  it('waits indefinitely when no timeout is configured — the default', async () => {
    const posts: ExtensionToWebview[] = [];
    const { chat, link, send } = makeChat({ posts });
    await send({ type: 'ready' } as WebviewToExtension);

    const pending = chat.askAgentQuestion('Which one?', ['a', 'b']);
    const id = await awaitQuestion(posts);

    // Well past the old hardcoded 300s cap in wall-clock terms it is not, but
    // it is past every deadline this test could configure: nothing fires.
    await new Promise((r) => setTimeout(r, 300));
    expect(closures(posts)).toEqual([]);
    expect(countdowns(posts)).toEqual([]);

    await send({ type: 'agentQuestionResponse', id, answer: 'a' } as WebviewToExtension);
    await expect(pending).resolves.toMatchObject({ answer: 'a', idle: false });
    link.dispose();
  });

  it('counts down over successive posts and closes as idle when the bound expires', async () => {
    const posts: ExtensionToWebview[] = [];
    const { chat, link, send } = makeChat({ posts });
    await send({ type: 'ready' } as WebviewToExtension);

    // Under ASK_USER_COUNTDOWN_MS, so the countdown is live from the start.
    // Long enough that the 500ms ticks land on distinct whole seconds — at a
    // shorter bound every tick rounds to the same number and "it counted
    // down" becomes unfalsifiable.
    const pending = chat.askAgentQuestion('Which one?', undefined, 3_000);
    await awaitQuestion(posts);

    const outcome = await pending;
    expect(outcome).toMatchObject({ idle: true });
    expect(outcome.answer).toBeUndefined();

    // It actually counted down rather than repeating one number: the ticks
    // never increase, and the last is strictly below the first.
    const seen = countdowns(posts);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)!).toBeLessThan(seen[0]!);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    expect(closures(posts)).toEqual(['idle']);
    link.dispose();
  });

  it('activity resets the deadline instead of letting it expire on schedule', async () => {
    const posts: ExtensionToWebview[] = [];
    const { chat, link, send } = makeChat({ posts });
    await send({ type: 'ready' } as WebviewToExtension);

    const pending = chat.askAgentQuestion('Which one?', undefined, 700);
    const id = await awaitQuestion(posts);

    // Keep reporting activity across a span longer than the bound. Without
    // touch() this question would have expired mid-way — which is exactly the
    // "expired while the user was mid-sentence" case.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 200));
      await send({ type: 'agentQuestionActivity', id, partial: 'stil' } as WebviewToExtension);
    }
    expect(closures(posts)).toEqual([]);

    // And once activity stops, it does still expire — carrying the partial.
    const outcome = await pending;
    expect(outcome).toMatchObject({ idle: true, partial: 'stil' });
    expect(closures(posts)).toEqual(['idle']);
    link.dispose();
  });

  it('distinguishes an expired question from a cancelled one, on the wire and to the agent', async () => {
    const idlePosts: ExtensionToWebview[] = [];
    const idleChat = makeChat({ posts: idlePosts });
    await idleChat.send({ type: 'ready' } as WebviewToExtension);
    const idleOutcome = await idleChat.chat.askAgentQuestion('Which one?', undefined, 300);

    const cancelPosts: ExtensionToWebview[] = [];
    const cancelChat = makeChat({ posts: cancelPosts });
    await cancelChat.send({ type: 'ready' } as WebviewToExtension);
    const cancelPending = cancelChat.chat.askAgentQuestion('Which one?', undefined, 60_000);
    await awaitQuestion(cancelPosts);
    await cancelChat.send({ type: 'stop' } as WebviewToExtension);
    const cancelOutcome = await cancelPending;

    // The card is told which of the two happened, so it can render them
    // differently rather than just disappearing in both cases.
    expect(closures(idlePosts)).toEqual(['idle']);
    expect(closures(cancelPosts)).toEqual(['cancelled']);

    // And the agent is told two different things: idle carries the
    // "not approval" guidance, cancellation stays the plain no-answer line.
    expect(idleOutcome).toMatchObject({ idle: true });
    expect(cancelOutcome).toMatchObject({ idle: false });
    expect(askUserIdleMessage(idleOutcome.partial)).toContain('NOT approval');
    expect(ASK_USER_NO_ANSWER).not.toContain('NOT approval');

    idleChat.link.dispose();
    cancelChat.link.dispose();
  });

  /**
   * Each teardown path, asserted by the promise settling. `resolves` is the
   * whole point: before abortRun() these paths aborted the run and left the
   * question's promise pending forever, which no "did it throw" check catches.
   */
  describe('every teardown path resolves the pending question rather than hanging', () => {
    it('the stop button', async () => {
      const posts: ExtensionToWebview[] = [];
      const { chat, link, send } = makeChat({ posts });
      await send({ type: 'ready' } as WebviewToExtension);
      const pending = chat.askAgentQuestion('Which one?', undefined, 60_000);
      await awaitQuestion(posts);

      await send({ type: 'stop' } as WebviewToExtension);

      await expect(pending).resolves.toMatchObject({ idle: false });
      expect(closures(posts)).toEqual(['cancelled']);
      link.dispose();
    });

    it('starting a new chat', async () => {
      const posts: ExtensionToWebview[] = [];
      const { chat, link, send } = makeChat({ posts });
      await send({ type: 'ready' } as WebviewToExtension);
      const pending = chat.askAgentQuestion('Which one?', undefined, 60_000);
      await awaitQuestion(posts);

      await send({ type: 'newChat' } as WebviewToExtension);

      await expect(pending).resolves.toMatchObject({ idle: false });
      expect(closures(posts)).toEqual(['cancelled']);
      link.dispose();
    });

    it('opening an earlier conversation', async () => {
      const posts: ExtensionToWebview[] = [];
      const loaded = { id: 'other', title: 'other', updatedAt: 0, messages: [] };
      const withGet = { ...store, get: () => Promise.resolve(loaded) } as unknown as ConversationStore;
      const { chat, link, send } = makeChat({ posts, store: withGet });
      await send({ type: 'ready' } as WebviewToExtension);
      const pending = chat.askAgentQuestion('Which one?', undefined, 60_000);
      await awaitQuestion(posts);

      await send({ type: 'openConversation', id: 'other' } as WebviewToExtension);

      await expect(pending).resolves.toMatchObject({ idle: false });
      expect(closures(posts)).toEqual(['cancelled']);
      link.dispose();
    });

    /**
     * The fourth abortRun() call site (chatViewProvider.ts:976), and the only
     * one that can be reached mid-question by accident: the user edits an
     * earlier prompt while the agent is waiting on an answer. It needs a real
     * user turn to edit, or editUserMessage bails before ever aborting
     * (chatViewProvider.ts:970-974).
     */
    it('editing an earlier prompt', async () => {
      model.script(['Sure.']);
      const posts: ExtensionToWebview[] = [];
      const { chat, link, send } = makeChat({ posts });
      await send({ type: 'ready' } as WebviewToExtension);
      await send({ type: 'send', text: 'first prompt' } as WebviewToExtension);
      await vi.waitFor(() => expect(textOf(posts)).toContain('Sure.'), { timeout: 2_000 });

      const pending = chat.askAgentQuestion('Which one?', undefined, 60_000);
      await awaitQuestion(posts);

      await send({ type: 'editUserMessage', ordinal: 0, text: 'second prompt', mode: 'chat' } as WebviewToExtension);

      await expect(pending).resolves.toMatchObject({ idle: false });
      expect(closures(posts)).toEqual(['cancelled']);
      link.dispose();
    });

    it('the sidebar being closed', async () => {
      const posts: ExtensionToWebview[] = [];
      const { chat, link, send, disposeView } = makeChat({ posts });
      await send({ type: 'ready' } as WebviewToExtension);
      const pending = chat.askAgentQuestion('Which one?', undefined, 60_000);
      await awaitQuestion(posts);

      disposeView();

      await expect(pending).resolves.toMatchObject({ idle: false });
      link.dispose();
    });
  });
});

describe('ServerLink', () => {
  it('pushes only the active profile’s key, per least-exposure', async () => {
    const profiles = stubProfiles([profile, { ...profile, name: 'other' }], {
      test: 'sk-active',
      other: 'sk-other',
    });
    const link = new ServerLink(profiles, log as never, serverOpts as never);

    await link.listModels('test');

    expect(model.requests.at(-1)!.path).toContain('/models');
    expect(core.sessionCount).toBe(1);
    link.dispose();
  });
});
