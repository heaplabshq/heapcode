import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '../../core/test/mockServer.js';
import { ConfigStore } from '../src/config/store.js';
import { SecretsStore } from '../src/config/secrets.js';
import { RoleResolver } from '../src/provider/roles.js';
import { RagIndexer } from '../src/rag/indexer.js';

/** A fixed embeddings response big enough to cover any batch this suite sends. */
const EMBED_BODY = {
  data: Array.from({ length: 32 }, (_, i) => ({ embedding: [1, 0, 0], index: i })),
};

let root: string;
let storageDir: string;
let server: MockServer;
let roles: RoleResolver;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-rag-'));
  storageDir = join(root, '.heapcode');
  server = await startMockServer({ kind: 'json', status: 200, body: EMBED_BODY });
  const configStore = new ConfigStore(join(root, 'config.json'));
  const secrets = new SecretsStore(join(root, 'secrets.json'));
  const profile = { name: 'test', preset: 'custom' as const, baseUrl: server.baseUrl, model: 'chat', embeddingsModel: 'embed' };
  roles = new RoleResolver(configStore, secrets, profile);
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('RagIndexer', () => {
  it('reports no-embedder when the active profile has no embeddingsModel configured', async () => {
    const configStore = new ConfigStore(join(root, 'config2.json'));
    const secrets = new SecretsStore(join(root, 'secrets2.json'));
    const noEmbedRoles = new RoleResolver(configStore, secrets, { name: 'x', preset: 'custom', baseUrl: server.baseUrl, model: 'chat' });
    const indexer = new RagIndexer(root, storageDir, noEmbedRoles);
    await indexer.init();
    expect((await indexer.status()).state).toBe('no-embedder');
    await indexer.buildIndex();
    expect(indexer.ready).toBe(false);
  });

  it('builds an index from workspace files and reports ready/chunk counts', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    await writeFile(join(root, 'b.ts'), 'export function subtract(a: number, b: number) {\n  return a - b;\n}\n');
    const indexer = new RagIndexer(root, storageDir, roles);
    await indexer.init();
    await indexer.buildIndex();

    expect(indexer.ready).toBe(true);
    const status = await indexer.status();
    expect(status.state).toBe('idle');
    expect(status.files).toBe(2);
    expect(status.chunks).toBeGreaterThan(0);
  });

  it('persists the index to rag-index.json and reloads it on a fresh instance', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const first = new RagIndexer(root, storageDir, roles);
    await first.init();
    await first.buildIndex();
    // buildIndex persists synchronously (not via the debounced persistSoon path).

    const second = new RagIndexer(root, storageDir, roles);
    await second.init();
    expect(second.ready).toBe(true);
    expect((await second.status()).files).toBe(1);
  });

  it('indexOne re-indexes a single file; unchanged content is a no-op (embedding cache)', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const indexer = new RagIndexer(root, storageDir, roles);
    await indexer.init();

    expect(await indexer.indexOne('a.ts')).toBe(true); // needed embedding
    expect(await indexer.indexOne('a.ts')).toBe(false); // hash unchanged — no re-embed

    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b + 1; }\n');
    expect(await indexer.indexOne('a.ts')).toBe(true); // content changed — re-embeds
  });

  it('removeFile drops a file from the index; renameFile moves it', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const indexer = new RagIndexer(root, storageDir, roles);
    await indexer.init();
    await indexer.indexOne('a.ts');
    expect((await indexer.status()).files).toBe(1);

    indexer.removeFile('a.ts');
    expect((await indexer.status()).files).toBe(0);

    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    await indexer.indexOne('a.ts');
    await writeFile(join(root, 'renamed.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    await indexer.renameFile('a.ts', 'renamed.ts');
    const status = await indexer.status();
    expect(status.files).toBe(1); // old path gone, new path indexed
  });

  it('query returns hits once the index is built; queryFormatted renders file:line blocks', async () => {
    await writeFile(join(root, 'auth.ts'), 'export function authenticate(user: string) {\n  return checkCredentials(user);\n}\n');
    const indexer = new RagIndexer(root, storageDir, roles);
    await indexer.init();
    await indexer.buildIndex();

    const hits = await indexer.query('where is authentication handled');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.record.path).toBe('auth.ts');

    const formatted = await indexer.queryFormatted('authentication');
    expect(formatted).toContain('auth.ts:');
  });

  it('respects .gitignore during buildIndex', async () => {
    await writeFile(join(root, '.gitignore'), 'ignored.ts\n');
    await writeFile(join(root, 'kept.ts'), 'export function kept() { return 1; }\n');
    await writeFile(join(root, 'ignored.ts'), 'export function ignored() { return 2; }\n');
    const indexer = new RagIndexer(root, storageDir, roles);
    await indexer.init();
    await indexer.buildIndex();
    expect((await indexer.status()).files).toBe(1);
  });

  it('clear() empties the store and persists the empty state', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const indexer = new RagIndexer(root, storageDir, roles);
    await indexer.init();
    await indexer.buildIndex();
    expect(indexer.ready).toBe(true);

    await indexer.clear();
    expect(indexer.ready).toBe(false);

    const reloaded = new RagIndexer(root, storageDir, roles);
    await reloaded.init();
    expect(reloaded.ready).toBe(false);
  });
});
