import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonConversationStore } from '../src/history/jsonStore.js';
import { nodeTextFile } from '../src/node/fs.js';

/**
 * One project's history is a single file every host on the machine shares —
 * the terminal, `heapcode web`, Heap Chat and the extension all resolve to the
 * same `conversationsFile(root)`.
 *
 * A store cached the file on first read and wrote that cached view back on
 * save, so a second session open on the same project silently deleted the
 * first's conversations: whichever saved last won. Two terminals, or a
 * terminal and a browser tab, was enough.
 */
describe('two hosts, one conversations file', () => {
  it('keeps both hosts’ conversations when both are open', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'hist-')), 'conversations.json');
    // `heapcode` in a terminal and `heapcode web`, same folder — they already
    // share conversationsFile(root) today.
    const cli = new JsonConversationStore(nodeTextFile(file));
    const web = new JsonConversationStore(nodeTextFile(file));

    // Both sessions are open, so both have read the file — which is what
    // showing a conversation list does.
    await cli.list();
    await web.list();

    await cli.save({ id: 'from-cli', title: 'terminal chat', updatedAt: 1, messages: [] });
    await web.save({ id: 'from-web', title: 'browser chat', updatedAt: 2, messages: [] });

    const seen = (await new JsonConversationStore(nodeTextFile(file)).list()).map((c) => c.id);
    expect(seen.sort()).toEqual(['from-cli', 'from-web']);
  });
});

describe('a store that has gone stale', () => {
  it('sees another host’s conversation rather than overwriting it', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'hist-')), 'conversations.json');
    const first = new JsonConversationStore(nodeTextFile(file));
    await first.save({ id: 'a', title: 'first', updatedAt: 1, messages: [] });

    // Another host adds one while this store is holding its own view.
    await new JsonConversationStore(nodeTextFile(file)).save({
      id: 'b',
      title: 'second',
      updatedAt: 2,
      messages: [],
    });

    await first.save({ id: 'a', title: 'first, edited', updatedAt: 3, messages: [] });
    const seen = await new JsonConversationStore(nodeTextFile(file)).list();
    expect(seen.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(seen.find((c) => c.id === 'a')?.title).toBe('first, edited');
  });

  it('does not resurrect what another host deleted', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'hist-')), 'conversations.json');
    const first = new JsonConversationStore(nodeTextFile(file));
    await first.save({ id: 'a', title: 'a', updatedAt: 1, messages: [] });
    await first.save({ id: 'b', title: 'b', updatedAt: 2, messages: [] });

    await new JsonConversationStore(nodeTextFile(file)).delete('a');

    await first.save({ id: 'b', title: 'b, edited', updatedAt: 3, messages: [] });
    const seen = await new JsonConversationStore(nodeTextFile(file)).list();
    expect(seen.map((c) => c.id)).toEqual(['b']);
  });
});
