import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepoMapIndexer } from '../src/rag/repoMapIndexer.js';

let root: string;
let storageDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-repomap-'));
  storageDir = join(root, '.heapcode');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('RepoMapIndexer', () => {
  it('is not ready until something has been indexed', async () => {
    const indexer = new RepoMapIndexer(root, storageDir);
    await indexer.init();
    expect(indexer.ready).toBe(false);
  });

  it('builds a symbol outline from workspace files, no embeddings model needed', async () => {
    await writeFile(join(root, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    const indexer = new RepoMapIndexer(root, storageDir);
    await indexer.init();
    await indexer.buildIndex();

    expect(indexer.ready).toBe(true);
    const outline = indexer.format();
    expect(outline).toContain('math.ts');
    expect(outline).toContain('add');
  });

  it('persists to repo-map.json and reloads on a fresh instance', async () => {
    await writeFile(join(root, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    const first = new RepoMapIndexer(root, storageDir);
    await first.init();
    await first.buildIndex();

    const second = new RepoMapIndexer(root, storageDir);
    await second.init();
    expect(second.ready).toBe(true);
    expect(second.format()).toContain('add');
  });

  it('ranks a file that is imported by others above an unimported leaf file', async () => {
    await writeFile(join(root, 'core.ts'), 'export function shared(): number {\n  return 1;\n}\n');
    await writeFile(join(root, 'user.ts'), "import { shared } from './core.js';\nexport function useShared() {\n  return shared();\n}\n");
    await writeFile(join(root, 'leaf.ts'), 'export function unrelated(): number {\n  return 2;\n}\n');
    const indexer = new RepoMapIndexer(root, storageDir);
    await indexer.init();
    await indexer.buildIndex();

    const outline = indexer.format();
    // core.ts is depended-upon (in-degree 1) and should rank ahead of the never-imported leaf.
    expect(outline.indexOf('core.ts')).toBeLessThan(outline.indexOf('leaf.ts'));

    const debug = indexer.debugRanking();
    expect(debug).toContain('core.ts');
  });

  it('noteRecent boosts a recently-written file in the ranking', async () => {
    await writeFile(join(root, 'a.ts'), 'export function a() { return 1; }\n');
    await writeFile(join(root, 'b.ts'), 'export function b() { return 2; }\n');
    const indexer = new RepoMapIndexer(root, storageDir);
    await indexer.init();
    await indexer.buildIndex();
    indexer.noteRecent('b.ts');

    const outline = indexer.format();
    expect(outline.indexOf('b.ts')).toBeLessThan(outline.indexOf('a.ts'));
  });

  it('indexOne updates a single file; removeFile and renameFile keep the map in sync', async () => {
    await writeFile(join(root, 'a.ts'), 'export function a() { return 1; }\n');
    const indexer = new RepoMapIndexer(root, storageDir);
    await indexer.init();
    await indexer.indexOne('a.ts');
    expect(indexer.format()).toContain('a.ts');

    indexer.removeFile('a.ts');
    expect(indexer.format()).not.toContain('a.ts');

    await writeFile(join(root, 'a.ts'), 'export function a() { return 1; }\n');
    await indexer.indexOne('a.ts');
    await writeFile(join(root, 'renamed.ts'), 'export function a() { return 1; }\n');
    await indexer.renameFile('a.ts', 'renamed.ts');
    const outline = indexer.format();
    expect(outline).toContain('renamed.ts');
    expect(outline).not.toContain('a.ts:');
  });

  it('a pathPrefix scopes the formatted outline to matching files', async () => {
    await writeFile(join(root, 'a.ts'), 'export function a() { return 1; }\n');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'b.ts'), 'export function b() { return 2; }\n');
    const indexer = new RepoMapIndexer(root, storageDir);
    await indexer.init();
    await indexer.buildIndex();

    const scoped = indexer.format('sub');
    expect(scoped).toContain('sub/b.ts');
    expect(scoped).not.toContain('a.ts');
  });

  it('clear() empties the map and persists the empty state', async () => {
    await writeFile(join(root, 'a.ts'), 'export function a() { return 1; }\n');
    const indexer = new RepoMapIndexer(root, storageDir);
    await indexer.init();
    await indexer.buildIndex();
    expect(indexer.ready).toBe(true);

    await indexer.clear();
    expect(indexer.ready).toBe(false);

    const reloaded = new RepoMapIndexer(root, storageDir);
    await reloaded.init();
    expect(reloaded.ready).toBe(false);
  });
});
