import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Conversation } from '@heapcode/core';
import { JsonConversationStore } from '../src/history/store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heapcode-history-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function conversation(id: string, updatedAt: number): Conversation {
  return { id, title: id, updatedAt, messages: [{ role: 'user', content: 'hi' }] };
}

describe('JsonConversationStore', () => {
  it('saves and reloads through a fresh instance (survives process restart)', async () => {
    const path = join(dir, 'conversations.json');
    await new JsonConversationStore(path).save(conversation('a', 1));

    const reloaded = new JsonConversationStore(path);
    expect(await reloaded.get('a')).toMatchObject({ id: 'a' });
  });

  it('lists newest-first and mostRecent() matches list()[0]', async () => {
    const store = new JsonConversationStore(join(dir, 'conversations.json'));
    await store.save(conversation('old', 100));
    await store.save(conversation('new', 200));

    const list = await store.list();
    expect(list.map((c) => c.id)).toEqual(['new', 'old']);
    expect((await store.mostRecent())?.id).toBe('new');
  });

  it('deletes a conversation', async () => {
    const store = new JsonConversationStore(join(dir, 'conversations.json'));
    await store.save(conversation('a', 1));
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
  });
});
