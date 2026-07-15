import { afterEach, describe, expect, it } from 'vitest';
import { chunkFile, fnv1a } from '../src/rag/chunker.js';
import { VectorStore, type VectorRecord } from '../src/rag/store.js';
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { startMockServer, type MockServer } from './mockServer.js';

// No configureAstChunker() call in this file, so chunkFile() always takes
// the line-window path — the regression check that the default (no host
// wired up) behaves exactly as before AST chunking existed.
describe('chunkFile (line-window path, no AST configured)', () => {
  it('covers the whole file with overlapping windows', async () => {
    const content = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = await chunkFile('a.ts', content, { maxLines: 60, overlap: 10 });
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[chunks.length - 1]!.endLine).toBe(150);
    // Consecutive chunks overlap.
    expect(chunks[1]!.startLine).toBeLessThanOrEqual(chunks[0]!.endLine);
  });

  it('prefers symbol boundaries near the window edge', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 55; i++) lines.push(`  body${i};`);
    lines.push('export function next() {');
    for (let i = 0; i < 30; i++) lines.push(`  more${i};`);
    const chunks = await chunkFile('a.ts', lines.join('\n'), { maxLines: 60, overlap: 5 });
    expect(chunks[0]!.endLine).toBe(55); // stopped before the function line
  });

  it('returns nothing for empty content and stable hashes otherwise', async () => {
    expect(await chunkFile('a.ts', '   \n  ')).toEqual([]);
    const [c1] = await chunkFile('a.ts', 'const x = 1;');
    const [c2] = await chunkFile('a.ts', 'const x = 1;');
    expect(c1!.hash).toBe(c2!.hash);
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});

function rec(path: string, hash: string, vector: number[]): VectorRecord {
  return { path, startLine: 1, endLine: 1, text: hash, hash, vector: Float32Array.from(vector) };
}

describe('VectorStore', () => {
  it('ranks by cosine similarity', () => {
    const store = new VectorStore();
    store.upsertFile('a.ts', 'fh', [
      rec('a.ts', 'x-axis', [1, 0]),
      rec('a.ts', 'y-axis', [0, 1]),
      rec('a.ts', 'diag', [1, 1]),
    ]);
    const hits = store.search([1, 0.1], 2);
    expect(hits[0]!.record.hash).toBe('x-axis');
    expect(hits.length).toBe(2);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('upsert replaces a file\'s records; retainFiles drops deleted files', () => {
    const store = new VectorStore();
    store.upsertFile('a.ts', 'h1', [rec('a.ts', 'old', [1, 0])]);
    store.upsertFile('a.ts', 'h2', [rec('a.ts', 'new', [0, 1])]);
    expect(store.chunkCount).toBe(1);
    expect(store.fileHash('a.ts')).toBe('h2');

    store.upsertFile('b.ts', 'h3', [rec('b.ts', 'b', [1, 1])]);
    store.retainFiles(new Set(['b.ts']));
    expect(store.fileHash('a.ts')).toBeUndefined();
    expect(store.chunkCount).toBe(1);
  });

  it('serializes and deserializes round-trip', () => {
    const store = new VectorStore();
    store.upsertFile('a.ts', 'fh', [rec('a.ts', 'c1', [0.6, 0.8])]);
    const restored = VectorStore.deserialize(store.serialize());
    expect(restored.chunkCount).toBe(1);
    expect(restored.fileHash('a.ts')).toBe('fh');
    const hits = restored.search([0.6, 0.8], 1);
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });
});

describe('provider.embeddings', () => {
  let server: MockServer;
  afterEach(async () => {
    await server?.close();
  });

  it('POSTs input array and returns embeddings in index order', async () => {
    server = await startMockServer({
      kind: 'json',
      status: 200,
      body: {
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
      },
    });
    const provider = new OpenAICompatibleProvider({ baseUrl: server.baseUrl });
    const res = await provider.embeddings({ model: 'nomic-embed-text', input: ['a', 'b'] });
    expect(res.embeddings).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(server.requests[0]!.path).toBe('/v1/embeddings');
    expect(server.requests[0]!.body).toMatchObject({ model: 'nomic-embed-text', input: ['a', 'b'] });
  });
});
