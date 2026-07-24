import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse, Conversation, Provider, ProviderProfileConfig, ToolDefinition } from '@heapcode/core';
import { ConfigStore } from '../src/config/store.js';
import { JsonConversationStore } from '../src/history/store.js';
import { WorkspaceToolExecutor } from '../src/agent/workspaceTools.js';
import { SessionCheckpoint } from '../src/agent/checkpoint.js';
import { PermissionEngine } from '../src/agent/permissions.js';
import type { ShadowGit } from '../src/agent/shadowGit.js';
import { App } from '../src/ink/App.js';
import type { RagIndexer } from '../src/rag/indexer.js';
import type { RepoMapIndexer } from '../src/rag/repoMapIndexer.js';
import type { McpManager } from '../src/agent/mcp.js';

/** App mounts an effect that always calls init()/buildIndex() on both indexers — every duck-typed mock needs them, even when a test only cares about one other method. */
function stubRag(overrides: Record<string, unknown> = {}): RagIndexer {
  return {
    ready: false,
    init: vi.fn().mockResolvedValue(undefined),
    buildIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RagIndexer;
}
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

function fakeProvider(reply: string): Provider {
  return {
    chat: () => Promise.resolve({ content: reply }),
    streamChat: async function* () {
      yield { content: reply };
    },
    chatStreamed: async (_req, onDelta) => {
      onDelta?.(reply);
      return { content: reply };
    },
    completion: () => Promise.reject(new Error('not used')),
    embeddings: () => Promise.reject(new Error('not used')),
    listModels: () => Promise.resolve([]),
  };
}

/** Returns responses[0], then responses[1], etc — same scripted-provider shape core's own agent.test.ts uses. */
function scriptedProvider(responses: ChatResponse[]): Provider {
  let call = 0;
  return {
    chat: () => Promise.resolve(responses[Math.min(call++, responses.length - 1)]!),
    streamChat: async function* () {
      yield { content: responses[0]!.content };
    },
    chatStreamed: async (_req, onDelta) => {
      const res = responses[Math.min(call++, responses.length - 1)]!;
      onDelta?.(res.content);
      return res;
    },
    completion: () => Promise.reject(new Error('not used')),
    embeddings: () => Promise.reject(new Error('not used')),
    listModels: () => Promise.resolve([]),
  };
}

const WRITE_FILE_TOOL: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  permission: 'write',
};

const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  permission: 'read',
};

const profile: ProviderProfileConfig = { name: 'test', preset: 'custom', baseUrl: 'http://x', model: 'mock' };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-app-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A tool-call-free reply with the fallback (nativeToolCalls: false) protocol
 * ends the agent loop in exactly one round trip via `events.onText` — no
 * tool blocks to parse, no finish-reminder dance. That determinism is why
 * these tests all run with nativeToolCalls: false rather than true.
 */
/** Records every chatStreamed request's messages while replying with a fixed text. */
function recordingProvider(reply: string): Provider & { requests: Array<Array<{ role: string; content: string }>> } {
  const requests: Array<Array<{ role: string; content: string }>> = [];
  return {
    ...fakeProvider(reply),
    requests,
    chatStreamed: async (req, onDelta) => {
      requests.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
      onDelta?.(reply);
      return { content: reply };
    },
  };
}

function renderApp(overrides: {
  provider: Provider;
  conversation: Conversation;
  historyStore: JsonConversationStore;
  tools?: ToolDefinition[];
  configStore?: ConfigStore;
  switchProvider?(p: ProviderProfileConfig): Promise<{ provider: Provider; contextWindow: number }>;
  cwd?: string;
  listWorkspaceFiles?(): Promise<string[]>;
  ragIndexer?: RagIndexer;
  repoMapIndexer?: RepoMapIndexer;
  mcpManager?: McpManager;
  shadowGit?: ShadowGit;
  onSessionChange?(id: string): void;
  checkUpdate?(): Promise<{ current: string; latest: string } | undefined>;
}) {
  const checkpoint = new SessionCheckpoint(root);
  const executor = new WorkspaceToolExecutor(root, checkpoint, 5_000);
  const permissions = new PermissionEngine(join(root, 'permissions.json'));
  return render(
    <App
      provider={overrides.provider}
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
      ragIndexer={overrides.ragIndexer}
      repoMapIndexer={overrides.repoMapIndexer}
      mcpManager={overrides.mcpManager}
      checkUpdate={overrides.checkUpdate}
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
    // Let the async runAgent()/state updates flush.
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Hello there');
    expect(save).toHaveBeenCalled();
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
      { content: '<tool name="write_file">\n{"path": "greeting.txt", "content": "hello from agent"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Wrote greeting.txt as requested."}\n</tool>' },
    ]);
    const ragIndexer = stubRag({ indexOne: vi.fn().mockResolvedValue(true) });
    const repoMapIndexer = stubRepoMap({ noteRecent: vi.fn(), indexOne: vi.fn().mockResolvedValue(undefined) });

    const { stdin, lastFrame } = renderApp({
      provider,
      conversation,
      historyStore,
      tools: [WRITE_FILE_TOOL],
      ragIndexer,
      repoMapIndexer,
    });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('write a greeting file');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('wants to modify files'), { timeout: 2_000 });
    stdin.write('\r'); // Allow once

    await vi.waitFor(() => expect(lastFrame()).toContain('Wrote greeting.txt'), { timeout: 2_000 });
    expect(ragIndexer.indexOne).toHaveBeenCalledWith('greeting.txt');
    expect(repoMapIndexer.indexOne).toHaveBeenCalledWith('greeting.txt');
    expect(repoMapIndexer.noteRecent).toHaveBeenCalledWith('greeting.txt');
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

  it('/settings shows the current configuration readout', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/settings');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Profile     test (custom)');
    expect(lastFrame()).toContain('Endpoint    http://x');
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
      switchProvider: () => Promise.resolve({ provider: fakeProvider('unused'), contextWindow: 32_768 }),
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
      switchProvider: () => Promise.resolve({ provider: fakeProvider('unused'), contextWindow: 32_768 }),
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
      switchProvider: () => Promise.resolve({ provider: fakeProvider('unused'), contextWindow: 32_768 }),
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
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const provider: Provider = {
      ...fakeProvider('On it.'),
      chatStreamed: async (req, onDelta) => {
        requests.push({ messages: req.messages.map((m) => ({ role: m.role, content: m.content })) });
        onDelta?.('On it.');
        return { content: 'On it.' };
      },
    };

    const { stdin } = renderApp({ provider, conversation, historyStore });

    await new Promise((r) => setTimeout(r, 20));
    stdin.write('ok do the second option');
    stdin.write('\r');
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 2_000 });

    const sent = requests[0]!.messages;
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
    await new Promise((r) => setTimeout(r, 100));

    const metas = await historyStore.list();
    expect(metas[0]?.title).toBe('what does this repo do');
  });

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

    // No ragIndexer at all → falls all the way back to the search tool.
    const noIndex = renderApp({ provider: fakeProvider('unused'), conversation, historyStore });
    await new Promise((r) => setTimeout(r, 20));
    noIndex.stdin.write('/search authenticate');
    noIndex.stdin.write('\r');
    await vi.waitFor(() => expect(noIndex.lastFrame()).toContain('plain text search'), { timeout: 2_000 });
    expect(noIndex.lastFrame()).toContain('auth.ts');
    noIndex.unmount();

    // ragIndexer.ready → uses its query() results instead of the text-search tool.
    const ragIndexer = stubRag({
      ready: true,
      query: vi.fn().mockResolvedValue([{ record: { path: 'auth.ts', startLine: 1, endLine: 3 }, score: 0.9 }]),
    });
    const withIndex = renderApp({ provider: fakeProvider('unused'), conversation, historyStore, ragIndexer });
    await new Promise((r) => setTimeout(r, 20));
    withIndex.stdin.write('/search authenticate');
    withIndex.stdin.write('\r');
    await vi.waitFor(() => expect(withIndex.lastFrame()).toContain('auth.ts:1-3'));
    expect(ragIndexer.query).toHaveBeenCalledWith('authenticate');
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
    const ragIndexer = stubRag({
      ready: true,
      status: vi.fn().mockResolvedValue({ state: 'idle', files: 3, chunks: 12 }),
    });
    const repoMapIndexer = stubRepoMap({ ready: true });

    const { stdin, lastFrame } = renderApp({ provider: fakeProvider('unused'), conversation, historyStore, ragIndexer, repoMapIndexer });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('/index');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('idle — 3 files, 12 chunks'));
    expect(lastFrame()).toContain('Repo map: ready');
  });

  it('@workspace pulls semantic search results into the agent task as context', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;
    const provider = recordingProvider('Done.');
    const ragIndexer = stubRag({
      ready: true,
      queryFormatted: vi.fn().mockResolvedValue('--- auth.ts:1-3 (score 0.90) ---\nfunction authenticate() {}'),
    });

    const { stdin } = renderApp({ provider, conversation, historyStore, ragIndexer });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('@workspace how does auth work');
    stdin.write('\r');
    await vi.waitFor(() => expect(provider.requests.length).toBeGreaterThan(0), { timeout: 2_000 });

    expect(ragIndexer.queryFormatted).toHaveBeenCalled();
    const task = provider.requests[0]!.at(-1)!.content;
    expect(task).toContain('Relevant workspace context');
    expect(task).toContain('auth.ts:1-3');
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
