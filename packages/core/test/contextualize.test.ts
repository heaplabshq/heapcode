import { describe, expect, it } from 'vitest';
import { contextualizeChunks, type Chunk, type Provider } from '../src/index.js';

function chunk(startLine: number, endLine: number, text: string): Chunk {
  return { path: 'a.ts', startLine, endLine, text, hash: `${startLine}-${endLine}` };
}

function providerReplying(handler: (messages: unknown) => string | Error): Provider {
  return {
    chat: async (req: { messages: unknown }) => {
      const content = handler(req.messages);
      if (content instanceof Error) throw content;
      return { content };
    },
  } as unknown as Provider;
}

describe('contextualizeChunks', () => {
  it('parses one blurb per numbered snippet, in order', async () => {
    const provider = providerReplying(() => '1: Defines the retry helper.\n2: Defines the backoff constant.');
    const chunks = [chunk(1, 3, 'function retry() {}'), chunk(4, 4, 'const BACKOFF = 1000;')];
    const results = await contextualizeChunks(provider, 'm', 'a.ts', 'whole file', chunks);
    expect(results).toEqual(['Defines the retry helper.', 'Defines the backoff constant.']);
  });

  it('batches more than 10 chunks into multiple calls', async () => {
    let calls = 0;
    const provider = providerReplying((messages) => {
      calls++;
      const userMsg = (messages as Array<{ content: string }>)[1]!.content;
      const count = (userMsg.match(/^\[\d+\]/gm) ?? []).length;
      return Array.from({ length: count }, (_, i) => `${i + 1}: blurb ${i}`).join('\n');
    });
    const chunks = Array.from({ length: 23 }, (_, i) => chunk(i, i, `line ${i}`));
    const results = await contextualizeChunks(provider, 'm', 'a.ts', 'whole file', chunks);
    expect(calls).toBe(3); // 10 + 10 + 3
    expect(results).toHaveLength(23);
    expect(results.every((r) => r.startsWith('blurb'))).toBe(true);
  });

  it('leaves blurbs empty for a batch whose reply is unparseable, without throwing', async () => {
    const provider = providerReplying(() => 'no idea, sorry');
    const chunks = [chunk(1, 1, 'a'), chunk(2, 2, 'b')];
    const results = await contextualizeChunks(provider, 'm', 'a.ts', 'whole file', chunks);
    expect(results).toEqual(['', '']);
  });

  it('leaves blurbs empty when the provider fails, without throwing', async () => {
    const provider = providerReplying(() => new Error('boom'));
    const chunks = [chunk(1, 1, 'a')];
    const results = await contextualizeChunks(provider, 'm', 'a.ts', 'whole file', chunks);
    expect(results).toEqual(['']);
  });

  it('returns an empty array for no chunks without calling the provider', async () => {
    const provider = providerReplying(() => new Error('must not be called'));
    const results = await contextualizeChunks(provider, 'm', 'a.ts', 'whole file', []);
    expect(results).toEqual([]);
  });
});
