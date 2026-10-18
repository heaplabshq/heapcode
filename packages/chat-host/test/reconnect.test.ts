import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcPeer, ServerConnection } from '@heapcode/core';
import { ConfigStore, SecretsStore } from '@heapcode/host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatSession } from '../src/index.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'chat-reconnect-'));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      activeProfile: 'm',
      profiles: [{ name: 'm', preset: 'custom', baseUrl: 'http://127.0.0.1:9', model: 'x' }],
    }),
  );
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('when the daemon goes away', () => {
  it('reconnects on the next request instead of failing with "connection closed"', async () => {
    const closers: (() => void)[] = [];
    let connects = 0;
    const fakeConnection = (): ServerConnection => {
      connects++;
      const peer = {
        onRequest() {},
        onNotification() {},
        notify() {},
        onClose: (h: () => void) => closers.push(h),
        request: async (method: string) =>
          method === 'rag/query' ? { formatted: `hit ${connects}` } : {},
      } as unknown as RpcPeer;
      return { peer, session: {} as ServerConnection['session'], close() {} };
    };
    const session = new ChatSession({
      root: home,
      config: new ConfigStore(join(home, 'config.json')),
      secrets: new SecretsStore(join(home, 'secrets.json')),
      connect: async () => fakeConnection(),
      memoryFile: join(home, 'memory.json'),
    });

    expect(await session.semanticQuery('deposit')).toBe('hit 1');
    // The daemon retires (an update rebuilt it) and the socket closes.
    for (const close of closers.splice(0)) close();
    expect(await session.semanticQuery('deposit')).toBe('hit 2');
    expect(connects).toBe(2);
    await session.close();
  });
});
