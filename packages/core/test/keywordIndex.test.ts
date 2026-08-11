import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFileSource, nodeTextStore } from '@heapcode/repomap/node';
import { chunkFile, KeywordIndex, KEYWORD_INDEX_FILE } from '../src/index.js';

/**
 * Ghost text's typing trigger keeps retrieving in-process after the semantic
 * index moved to the server (docs/phase3-rag-design.md open question 1,
 * resolved as decision 1 of the migration): the host builds its own
 * vector-free BM25 index rather than mirroring the server's store.
 *
 * The properties that matter, and that these tests pin, are that it needs no
 * model and no network at all, and that it carries no embeddings anywhere —
 * not in memory and not on disk.
 */

let root: string;
let statePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-keyword-'));
  statePath = join(root, '.state', KEYWORD_INDEX_FILE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function index(): KeywordIndex {
  return new KeywordIndex({
    files: nodeFileSource(root, { exclude: ['**/node_modules/**', '**/.state/**'] }),
    store: nodeTextStore(statePath),
  });
}

async function writeCorpus(): Promise<void> {
  await writeFile(join(root, 'auth.ts'), 'export function authenticateUser(token: string) {\n  return verifySession(token);\n}\n');
  await writeFile(join(root, 'billing.ts'), 'export function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}\n');
  await writeFile(join(root, 'notes.md'), '# Notes\n\nNothing about payments here.\n');
}

describe('KeywordIndex', () => {
  it('builds and searches with no provider, no key and no network', async () => {
    // Nothing is injected but a filesystem and a store — there is no seam
    // through which a model call could happen.
    await writeCorpus();
    const keywords = index();
    await keywords.init();

    const built = await keywords.buildIndex();

    expect(built).toEqual({ files: 3, chunks: expect.any(Number) });
    expect(keywords.ready).toBe(true);
    expect(keywords.search('chargeCard gateway', 2)[0]!.path).toBe('billing.ts');
  });

  it('splits identifiers the way code search needs — "authenticate user" finds authenticateUser', async () => {
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();

    expect(keywords.search('authenticate user', 1)[0]!.path).toBe('auth.ts');
  });

  it('returns hits with no vector field anywhere on them', async () => {
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();

    const [hit] = keywords.search('chargeCard', 1);

    expect(Object.keys(hit!).sort()).toEqual(['endLine', 'path', 'score', 'startLine', 'text']);
    expect('vector' in hit!).toBe(false);
  });

  it('persists no embeddings to disk either — the whole point of the second index being small', async () => {
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();

    const raw = await readFile(statePath, 'utf8');

    expect(raw).not.toContain('vector');
    expect(JSON.parse(raw).records.every((r: object) => !('vector' in r))).toBe(true);
  });

  it('reloads from disk, so a cold start serves completions without re-chunking', async () => {
    await writeCorpus();
    const first = index();
    await first.init();
    await first.buildIndex();

    const second = index();
    await second.init();

    expect(second.ready).toBe(true);
    expect(second.chunkCount).toBe(first.chunkCount);
    expect(second.search('chargeCard', 1)[0]!.path).toBe('billing.ts');
  });

  it('produces the same chunk boundaries the semantic index would, from the same chunker', async () => {
    // Both indexes call chunkFile, so a hit from either names the same lines.
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();

    const direct = await chunkFile('billing.ts', await readFile(join(root, 'billing.ts'), 'utf8'));
    const hits = keywords.search('chargeCard gateway', 10).filter((h) => h.path === 'billing.ts');

    expect(hits.map((h) => [h.startLine, h.endLine]).sort()).toEqual(
      direct.map((c) => [c.startLine, c.endLine]).sort(),
    );
  });
});

describe('KeywordIndex — incremental updates', () => {
  it('picks up an edit through indexOne, on the same trigger RAG uses', async () => {
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();
    expect(keywords.search('refundPayment', 1)).toEqual([]);

    await writeFile(join(root, 'billing.ts'), 'export function refundPayment(id: string) {\n  return gateway.refund(id);\n}\n');
    await keywords.indexOne('billing.ts');

    expect(keywords.search('refundPayment', 1)[0]!.path).toBe('billing.ts');
    // The old chunk is gone, not shadowed.
    expect(keywords.search('chargeCard', 5).some((h) => h.text.includes('chargeCard'))).toBe(false);
  });

  it('skips a file whose content did not change', async () => {
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();
    const before = keywords.chunkCount;

    await keywords.indexOne('billing.ts');

    expect(keywords.chunkCount).toBe(before);
  });

  it('removeFile drops it; renameFile moves it', async () => {
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();

    keywords.removeFile('billing.ts');
    expect(keywords.search('chargeCard', 1)).toEqual([]);
    expect(keywords.fileCount).toBe(2);

    await writeFile(join(root, 'payments.ts'), 'export function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}\n');
    await keywords.renameFile('billing.ts', 'payments.ts');

    expect(keywords.search('chargeCard', 1)[0]!.path).toBe('payments.ts');
  });

  it('drops files that disappeared, on the next full build', async () => {
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();

    await rm(join(root, 'billing.ts'));
    const after = await keywords.buildIndex();

    expect(after?.files).toBe(2);
    expect(keywords.search('chargeCard', 1)).toEqual([]);
  });

  it('forgets a file it can no longer read', async () => {
    await writeCorpus();
    const keywords = index();
    await keywords.init();
    await keywords.buildIndex();

    await rm(join(root, 'billing.ts'));
    await keywords.indexOne('billing.ts');

    expect(keywords.search('chargeCard', 1)).toEqual([]);
  });

  it('honours the workspace ignore rules its FileSource applies', async () => {
    await writeCorpus();
    await writeFile(join(root, '.gitignore'), 'billing.ts\n');
    const keywords = new KeywordIndex({
      files: nodeFileSource(root, {
        exclude: ['**/.state/**'],
        ignore: async () => (rel: string) => rel === 'billing.ts',
      }),
      store: nodeTextStore(statePath),
    });
    await keywords.init();

    await keywords.buildIndex();

    expect(keywords.search('chargeCard', 1)).toEqual([]);
    expect(keywords.search('authenticate user', 1)[0]!.path).toBe('auth.ts');
  });

  it('is empty, not broken, before anything is indexed', async () => {
    const keywords = index();
    await keywords.init();

    expect(keywords.ready).toBe(false);
    expect(keywords.search('anything')).toEqual([]);
  });
});
