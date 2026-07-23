import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse, Conversation, Provider, ProviderProfileConfig, ToolDefinition } from '@heapcode/core';
import { JsonConversationStore } from '../src/history/store.js';
import { WorkspaceToolExecutor } from '../src/agent/workspaceTools.js';
import { SessionCheckpoint } from '../src/agent/checkpoint.js';
import { PermissionEngine } from '../src/agent/permissions.js';
import { App } from '../src/ink/App.js';

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
function renderApp(overrides: {
  provider: Provider;
  conversation: Conversation;
  historyStore: JsonConversationStore;
  tools?: ToolDefinition[];
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
      tools={overrides.tools ?? []}
      nativeToolCalls={false}
      workspaceName="test"
      contextWindow={32_768}
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
});
