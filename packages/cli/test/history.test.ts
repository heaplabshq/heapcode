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

  describe('findByIdOrPrefix', () => {
    it('resolves an exact id', async () => {
      const store = new JsonConversationStore(join(dir, 'conversations.json'));
      await store.save(conversation('abc12345-full-id', 1));
      expect((await store.findByIdOrPrefix('abc12345-full-id'))?.id).toBe('abc12345-full-id');
    });

    it('resolves an unambiguous short prefix — same convenience as a git short hash', async () => {
      const store = new JsonConversationStore(join(dir, 'conversations.json'));
      await store.save(conversation('abc12345-full-id', 1));
      await store.save(conversation('def67890-other-id', 2));
      expect((await store.findByIdOrPrefix('abc123'))?.id).toBe('abc12345-full-id');
    });

    it('returns undefined for an ambiguous prefix rather than guessing', async () => {
      const store = new JsonConversationStore(join(dir, 'conversations.json'));
      await store.save(conversation('abc111', 1));
      await store.save(conversation('abc222', 2));
      expect(await store.findByIdOrPrefix('abc')).toBeUndefined();
    });

    it('returns undefined for no match', async () => {
      const store = new JsonConversationStore(join(dir, 'conversations.json'));
      await store.save(conversation('abc12345', 1));
      expect(await store.findByIdOrPrefix('zzz')).toBeUndefined();
    });
  });
});
