import { describe, expect, it } from 'vitest';
import { bm25Scores, tokenize } from '../src/rag/bm25.js';
import { VectorStore, type VectorRecord } from '../src/rag/store.js';

function rec(path: string, text: string, vector: number[], context?: string): VectorRecord {
  return { path, startLine: 1, endLine: 1, text, hash: path, vector: Float32Array.from(vector), context };
}

describe('tokenize', () => {
  it('splits camelCase and snake_case into sub-words', () => {
    expect(tokenize('resolveRoleProfile')).toEqual(['resolve', 'role', 'profile']);
    expect(tokenize('embeddings_model_id')).toEqual(['embeddings', 'model', 'id']);
    expect(tokenize('HTTPServer')).toEqual(['http', 'server']);
  });

  it('lowercases and drops single-character tokens', () => {
    expect(tokenize('A dog, and a Cat!')).toEqual(['dog', 'and', 'cat']);
  });
});

describe('bm25Scores', () => {
  it('ranks a doc containing the query term above one that does not', () => {
    const records = [
      rec('a.ts', 'function resolveRoleProfile(role) { return role; }', [0, 0]),
      rec('b.ts', 'function unrelated(x) { return x + 1; }', [0, 0]),
    ];
    const scores = bm25Scores(records, tokenize('role profile'));
    expect(scores.get(records[0]!)).toBeGreaterThan(0);
    expect(scores.has(records[1]!)).toBe(false);
  });

  it('returns no scores for an empty query or empty corpus', () => {
    const records = [rec('a.ts', 'some text', [0, 0])];
    expect(bm25Scores(records, []).size).toBe(0);
    expect(bm25Scores([], tokenize('anything')).size).toBe(0);
  });
});

describe('VectorStore.hybridSearch', () => {
  it('surfaces a keyword-only match that pure vector search would bury', () => {
    const store = new VectorStore();
    store.upsertFile('a.ts', 'fh', [
      // Strong vector match for the query embedding, no keyword overlap.
      rec('a.ts', 'totally unrelated prose about gardening', [1, 0]),
      // Weak vector match, but contains the exact identifier queried for.
      rec('b.ts', 'export function resolveRoleProfile(role: ModelRole) {}', [0, 1]),
    ]);
    const hits = store.hybridSearch([0.9, 0.1], 'resolveRoleProfile', 2);
    expect(hits.map((h) => h.record.path)).toContain('b.ts');
  });

  it('still ranks a strong embedding match highly with no keyword overlap', () => {
    const store = new VectorStore();
    store.upsertFile('a.ts', 'fh', [
      rec('a.ts', 'exact vector match, no keyword overlap at all', [1, 0]),
      rec('b.ts', 'weak vector match, no keyword overlap either', [0, 1]),
    ]);
    const hits = store.hybridSearch([1, 0], 'zzz not present anywhere', 1);
    expect(hits[0]!.record.path).toBe('a.ts');
  });

  it('includes the contextual-retrieval blurb in the keyword index, enough to overcome a weaker vector score', () => {
    const store = new VectorStore();
    store.upsertFile('a.ts', 'fh', [
      // Weak vector match (cosine 0), but its blurb matches the query exactly.
      rec('a.ts', 'const x = 1;', [1, 0], 'Configures the retry backoff constant'),
      // Strong vector match (cosine 1), no keyword overlap anywhere.
      rec('b.ts', 'const y = 2;', [0, 1]),
    ]);
    const hits = store.hybridSearch([0, 1], 'retry backoff', 2);
    expect(hits[0]!.record.path).toBe('a.ts');
  });
});

describe('VectorStore.keywordSearch', () => {
  it('ranks by BM25 alone, with no vector involved', () => {
    const store = new VectorStore();
    store.upsertFile('a.ts', 'fh', [
      rec('a.ts', 'export function resolveRoleProfile(role: ModelRole) {}', [0, 0]),
      rec('b.ts', 'totally unrelated prose about gardening', [0, 0]),
    ]);
    const hits = store.keywordSearch('resolveRoleProfile', 2);
    expect(hits[0]!.record.path).toBe('a.ts');
    expect(hits.map((h) => h.record.path)).not.toContain('b.ts');
  });

  it('returns nothing for an empty store or a query with no matches', () => {
    const empty = new VectorStore();
    expect(empty.keywordSearch('anything', 5)).toEqual([]);

    const store = new VectorStore();
    store.upsertFile('a.ts', 'fh', [rec('a.ts', 'const x = 1;', [0, 0])]);
    expect(store.keywordSearch('zzz not present anywhere', 5)).toEqual([]);
  });
});
