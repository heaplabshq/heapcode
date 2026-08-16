import { describe, expect, it } from 'vitest';
import { RepoMapIndexer, type FileSource, type RepoMapStore } from '../src/indexer.js';

/**
 * `snapshot()` is `format()`'s structured twin: the same map, in the same
 * order, without the character budget. It exists so a UI can list symbols and
 * follow import links without reparsing text that was written for a model.
 *
 * Ordering is delegated to `rankByCentrality`, which rank.test.ts covers
 * directly; what matters here is that snapshot and format agree, since a map
 * that lists files in one order and prints them in another would make the two
 * views impossible to reconcile.
 */

function memoryFiles(files: Record<string, string>): FileSource {
  return {
    list: () => Promise.resolve(Object.keys(files)),
    read: (rel) => {
      const content = files[rel];
      if (content === undefined) return Promise.reject(new Error(`ENOENT: ${rel}`));
      return Promise.resolve(new TextEncoder().encode(content));
    },
  };
}

function memoryStore(): RepoMapStore {
  let text: string | undefined;
  return {
    read: () => Promise.resolve(text),
    write: (t) => {
      text = t;
      return Promise.resolve();
    },
  };
}

const SAMPLE = {
  'src/math.ts': 'export function add(a, b) { return a + b; }\n',
  'src/app.ts': 'export class App {}\n',
  // Code, but nothing to extract — distinct from a file that is not code.
  'src/empty.ts': '\n\n',
  'notes.txt': 'export function notCode() {}\n',
};

describe('RepoMapIndexer.snapshot', () => {
  it('carries each indexed file with its symbols', async () => {
    const map = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store: memoryStore() });
    await map.buildIndex();

    const snap = map.snapshot();
    const math = snap.find((e) => e.path === 'src/math.ts');
    expect(math?.symbols.some((s) => s.name.includes('add'))).toBe(true);
    // Not code, so never indexed at all — snapshot cannot invent it.
    expect(snap.map((e) => e.path)).not.toContain('notes.txt');
  });

  it('keeps a code file that parsed to nothing, which format() drops', async () => {
    // The model's copy has no room for a file with no symbols; a reader asking
    // "why is my map thin?" needs to see that it was indexed and came up empty.
    const map = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store: memoryStore() });
    await map.buildIndex();

    expect(map.snapshot().find((e) => e.path === 'src/empty.ts')?.symbols).toEqual([]);
    expect(map.format()).not.toContain('src/empty.ts');
  });

  it('lists files in the order format() prints them', async () => {
    const map = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store: memoryStore() });
    await map.buildIndex();

    const printed = map
      .format()
      .split('\n')
      .filter((l) => l.endsWith('.ts'));
    const listed = map
      .snapshot()
      .map((e) => e.path)
      // format() omits symbol-less files, so compare only what both contain.
      .filter((p) => printed.includes(p));
    expect(listed).toEqual(printed);
  });

  it('reports imports per file, empty when nothing resolved', async () => {
    // Import edges need a real parser (extractImportTargets returns [] with
    // none), so with the regex fallback every file has zero — the point here
    // is that the field is present and typed, not invented.
    const map = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store: memoryStore() });
    await map.buildIndex();
    for (const entry of map.snapshot()) expect(entry.imports).toEqual([]);
  });

  it('is empty before anything is built', async () => {
    const map = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store: memoryStore() });
    await map.init();
    expect(map.snapshot()).toEqual([]);
    expect(map.ready).toBe(false);
  });
});
