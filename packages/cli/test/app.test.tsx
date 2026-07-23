import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Provider, ProviderProfileConfig } from '@heapcode/core';
import { JsonConversationStore } from '../src/history/store.js';
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

const profile: ProviderProfileConfig = { name: 'test', preset: 'custom', baseUrl: 'http://x', model: 'mock' };

describe('App', () => {
  it('renders the composer and status line without crashing', () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const historyStore = { save: vi.fn() } as unknown as JsonConversationStore;

    const { lastFrame } = render(
      <App provider={fakeProvider('hi')} profile={profile} conversation={conversation} historyStore={historyStore} />,
    );

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

    const { lastFrame } = render(
      <App provider={fakeProvider('hi')} profile={profile} conversation={conversation} historyStore={historyStore} />,
    );

    expect(lastFrame()).toContain('earlier question');
  });

  it('sends a message on submit and streams the reply into the transcript', async () => {
    const conversation: Conversation = { id: 'c1', title: 't', updatedAt: 0, messages: [] };
    const save = vi.fn();
    const historyStore = { save } as unknown as JsonConversationStore;

    const { stdin, lastFrame } = render(
      <App provider={fakeProvider('Hello there')} profile={profile} conversation={conversation} historyStore={historyStore} />,
    );

    // Ink enables raw-mode stdin listening in a useEffect, which runs after
    // this first tick — writing to stdin before it settles is dropped.
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('hi');
    stdin.write('\r');
    // Let the async sendMessage()/state updates flush.
    await new Promise((r) => setTimeout(r, 20));

    expect(lastFrame()).toContain('Hello there');
    expect(save).toHaveBeenCalled();
  });
});
