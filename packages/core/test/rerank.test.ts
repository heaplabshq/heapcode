import { describe, expect, it } from 'vitest';
import { rerankHits, type Provider, type SearchHit } from '../src/index.js';

function hit(path: string, score: number): SearchHit {
  return {
    record: {
      path,
      startLine: 1,
      endLine: 10,
      text: `contents of ${path}`,
      hash: path,
      vector: new Float32Array(),
    },
    score,
  };
}

const hits = [hit('a.ts', 0.9), hit('b.ts', 0.8), hit('c.ts', 0.7), hit('d.ts', 0.6)];

function providerReplying(content: string | Error): Provider {
  return {
    chat: async () => {
      if (content instanceof Error) throw content;
      return { content };
    },
  } as unknown as Provider;
}

describe('rerankHits', () => {
  it('keeps the hits the model picks, in its order', async () => {
    const ranked = await rerankHits(providerReplying('3, 1'), 'm', 'q', hits, 2);
    expect(ranked.map((h) => h.record.path)).toEqual(['c.ts', 'a.ts']);
  });

  it('ignores out-of-range and duplicate numbers', async () => {
    const ranked = await rerankHits(providerReplying('9, 2, 2, 0, 4'), 'm', 'q', hits, 3);
    expect(ranked.map((h) => h.record.path)).toEqual(['b.ts', 'd.ts']);
  });

  it('falls back to vector order on an unparseable reply', async () => {
    const ranked = await rerankHits(providerReplying('no idea, sorry'), 'm', 'q', hits, 2);
    expect(ranked.map((h) => h.record.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back to vector order when the provider fails', async () => {
    const ranked = await rerankHits(providerReplying(new Error('boom')), 'm', 'q', hits, 2);
    expect(ranked.map((h) => h.record.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('skips the LLM call entirely when there is nothing to cut', async () => {
    const provider = providerReplying(new Error('must not be called'));
    const ranked = await rerankHits(provider, 'm', 'q', hits.slice(0, 2), 4);
    expect(ranked.map((h) => h.record.path)).toEqual(['a.ts', 'b.ts']);
  });
});
