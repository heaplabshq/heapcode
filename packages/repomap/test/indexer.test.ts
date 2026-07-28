import { describe, expect, it } from 'vitest';
import { RepoMapIndexer, type FileSource, type RepoMapStore } from '../src/indexer.js';
import { formatRankingDebug } from '../src/debugRanking.js';

/** In-memory FileSource — the seam exists precisely so a test needs no filesystem. */
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

function memoryStore(): RepoMapStore & { text?: string } {
  const store: RepoMapStore & { text?: string } = {
    read: () => Promise.resolve(store.text),
    write: (text) => {
      store.text = text;
      return Promise.resolve();
    },
  };
  return store;
}

const SAMPLE = {
  'src/math.ts': 'export function add(a, b) { return a + b; }\n',
  'src/app.ts': 'export class App {}\n',
  'notes.txt': 'export function notCode() {}\n',
};

describe('RepoMapIndexer over an injected FileSource', () => {
  it('indexes listed files, skipping extensions it does not map', async () => {
    const indexer = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store: memoryStore() });
    await indexer.buildIndex();

    const outline = indexer.format();
    expect(outline).toContain('src/math.ts');
    expect(outline).toContain('src/app.ts');
    expect(outline).not.toContain('notes.txt');
  });

  it('extracts symbols with no parser at all, via the regex fallback', async () => {
    const indexer = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store: memoryStore() });
    await indexer.buildIndex();
    expect(indexer.format()).toContain('line export function add(a, b) { return a + b; }');
  });

  it('uses an injected parser when one is supplied', async () => {
    // A stand-in for tree-sitter: one node, shaped the way SyntaxNode says.
    const parserFor = (path: string) =>
      Promise.resolve(
        path.endsWith('.ts')
          ? {
              parse: () => ({
                rootNode: {
                  type: 'program',
                  text: '',
                  startPosition: { row: 0, column: 0 },
                  childForFieldName: () => null,
                  namedChildren: [
                    {
                      type: 'function_declaration',
                      text: '',
                      startPosition: { row: 3, column: 0 },
                      namedChildren: [],
                      childForFieldName: (field: string) =>
                        field === 'name'
                          ? {
                              type: 'identifier',
                              text: 'parsed',
                              startPosition: { row: 3, column: 9 },
                              namedChildren: [],
                              childForFieldName: () => null,
                            }
                          : null,
                    },
                  ],
                },
              }),
            }
          : undefined,
      );

    const indexer = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store: memoryStore(), parserFor });
    await indexer.buildIndex();
    expect(indexer.format()).toContain('function_declaration parsed (line 4)');
  });

  it('persists through the store and reloads on a fresh instance', async () => {
    const store = memoryStore();
    const first = new RepoMapIndexer({ files: memoryFiles(SAMPLE), store });
    await first.buildIndex();
    expect(store.text).toContain('src/math.ts');

    const second = new RepoMapIndexer({ files: memoryFiles({}), store });
    await second.init();
    expect(second.ready).toBe(true);
    expect(second.format()).toContain('src/math.ts');
  });

  it('migrates a v1 map (no import graph) by treating it as having no edges', async () => {
    const store = memoryStore();
    store.text = JSON.stringify({
      version: 1,
      entries: { 'src/old.ts': { hash: 'deadbeef', symbols: [{ name: 'old', kind: 'line', line: 1 }] } },
    });
    const indexer = new RepoMapIndexer({ files: memoryFiles({}), store });
    await indexer.init();

    expect(indexer.format()).toContain('src/old.ts');
    expect(indexer.rankingInputs().edges).toEqual([]);
  });

  it('honours an enabled() gate before a full rebuild', async () => {
    const indexer = new RepoMapIndexer({
      files: memoryFiles(SAMPLE),
      store: memoryStore(),
      enabled: () => false,
    });
    await indexer.buildIndex();
    expect(indexer.ready).toBe(false);
  });

  it('reports open files as the strongest ranking boost when a host supplies them', async () => {
    const indexer = new RepoMapIndexer({
      files: memoryFiles(SAMPLE),
      store: memoryStore(),
      openFiles: () => ['src/app.ts'],
    });
    await indexer.buildIndex();
    indexer.noteRecent('src/math.ts');

    const outline = indexer.format();
    expect(outline.indexOf('src/app.ts')).toBeLessThan(outline.indexOf('src/math.ts'));
  });

  it('drops entries whose file has gone away on the next build', async () => {
    const store = memoryStore();
    await new RepoMapIndexer({ files: memoryFiles(SAMPLE), store }).buildIndex();

    const second = new RepoMapIndexer({ files: memoryFiles({ 'src/app.ts': SAMPLE['src/app.ts'] }), store });
    await second.init();
    await second.buildIndex();
    expect(second.format()).not.toContain('src/math.ts');
  });
});

describe('formatRankingDebug', () => {
  const paths = ['hub.ts', 'leaf.ts'];
  const edges = [
    { from: 'leaf.ts', to: 'hub.ts' },
    { from: 'other.ts', to: 'hub.ts' },
  ];

  it('renders the score components behind each row, no indexer required', () => {
    const text = formatRankingDebug({ title: 'ranking debug', paths, edges });
    const [title, counts, recent, blank, header, rule, first] = text.split('\n');
    expect(title).toBe('ranking debug');
    expect(counts).toBe('2 files indexed, 2 resolved import edges');
    expect(recent).toBe('Recent files (+20 each): (none)');
    expect(blank).toBe('');
    expect(header).toBe('rank  score  in  out  boost  recent  path');
    expect(rule).toBe('----  -----  --  ---  -----  ------  ----');
    // hub.ts: in-degree 2, out-degree 0 -> score 4.
    expect(first).toBe('   1      4   2    0      0           hub.ts');
  });

  it('omits the open-files column for a host with no editor', () => {
    const text = formatRankingDebug({ title: 't', paths, edges, boost: { recentFiles: ['leaf.ts'] } });
    expect(text).not.toContain('open');
    expect(text).toContain('Recent files (+20 each): leaf.ts');
  });

  it('includes it, with the host\'s own labels, when open files are supplied', () => {
    const text = formatRankingDebug({
      title: 't',
      paths,
      edges,
      boost: { openFiles: ['leaf.ts'], recentFiles: [] },
      openLabel: 'Open tabs',
      recentLabel: 'Recently saved',
    });
    expect(text).toContain('Open tabs (+50 each): leaf.ts');
    expect(text).toContain('Recently saved (+20 each): (none)');
    expect(text).toContain('rank  score  in  out  boost  open  recent  path');
    // The +50 boost puts leaf.ts first despite hub.ts having every edge.
    expect(text.indexOf('leaf.ts')).toBeLessThan(text.indexOf(' hub.ts'));
  });
});
