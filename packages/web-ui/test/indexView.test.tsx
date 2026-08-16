// @vitest-environment jsdom
/**
 * The Index tab.
 *
 * Before this, both indexes were invisible: `/index` fired a blind rebuild and
 * said "Index rebuilt", and nothing reported whether either had ever been
 * built. When semantic_search came back empty there was no way to tell an
 * empty index from a bad query — which is the case these tests are really
 * about.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiIndexStatus, UiRepoMapResult } from '@heapcode/web-host/protocol';
import { IndexView } from '../src/components/IndexView.js';

afterEach(cleanup);

const STATUS: UiIndexStatus = {
  semantic: { state: 'ready', files: 42, chunks: 810, available: true },
  repoMap: { ready: true, files: 42, symbols: 517, links: 96 },
};

const MAP: UiRepoMapResult = {
  total: 2,
  files: [
    {
      path: 'src/App.tsx',
      symbols: [{ name: 'App', kind: 'function_declaration', line: 71 }],
      imports: ['src/rpc.ts'],
      importedBy: [],
    },
    { path: 'src/rpc.ts', symbols: [], imports: [], importedBy: ['src/App.tsx'] },
  ],
};

function view(over: Partial<Parameters<typeof IndexView>[0]> = {}) {
  const onOpenPath = vi.fn();
  const props = {
    status: STATUS,
    loadMap: () => Promise.resolve(MAP),
    onRebuild: vi.fn(),
    onClear: vi.fn(),
    busy: false,
    onOpenPath,
    ...over,
  };
  render(<IndexView {...props} />);
  return { ...props, onOpenPath };
}

describe('IndexView', () => {
  it('reports the two indexes separately', async () => {
    view();
    expect(screen.getByText('Semantic index')).toBeTruthy();
    expect(screen.getByText('Repo map')).toBeTruthy();
    expect(screen.getByText('810')).toBeTruthy(); // chunks
    expect(screen.getByText('517')).toBeTruthy(); // symbols
    expect(screen.getByText('96')).toBeTruthy(); // links
  });

  it('calls out a semantic index that is unavailable, without hiding the map', () => {
    // The exact case worth diagnosing: local parsing worked, embeddings did not.
    view({
      status: {
        semantic: { state: 'idle', files: 0, chunks: 0, available: false },
        repoMap: { ready: true, files: 42, symbols: 517, links: 96 },
      },
    });
    expect(screen.getByText('unavailable')).toBeTruthy();
    expect(screen.getByText('ready')).toBeTruthy();
  });

  it('shows live progress while a rebuild runs', () => {
    view({ status: { ...STATUS, progress: { embedded: 30, total: 120 } } });
    expect(screen.getByText(/Embedding 30 of 120/)).toBeTruthy();
  });

  it('lists files with their symbol and link counts, expanding on click', async () => {
    const { onOpenPath } = view();
    await screen.findByText('src/App.tsx');
    // 1 symbol, 1 outgoing edge.
    expect(screen.getByText('1 sym')).toBeTruthy();
    expect(screen.getByText('→1')).toBeTruthy();

    fireEvent.click(screen.getByText('src/App.tsx'));
    expect(screen.getByText('App')).toBeTruthy();
    expect(screen.getByText(':71')).toBeTruthy();

    // The link is clickable and opens the file it points at.
    fireEvent.click(screen.getByText('src/rpc.ts', { selector: '.idx-link' }));
    expect(onOpenPath).toHaveBeenCalledWith('src/rpc.ts');
  });

  it('shows both directions of the import graph', async () => {
    view();
    await screen.findByText('src/rpc.ts', { selector: '.idx-path' });
    // rpc.ts has no symbols and no imports, but something imports it — the
    // question the stored map cannot answer on its own.
    expect(screen.getByText('←1')).toBeTruthy();
    fireEvent.click(screen.getByText('src/rpc.ts', { selector: '.idx-path' }));
    expect(screen.getByText('Imported by')).toBeTruthy();
    expect(screen.getByText('No symbols parsed from this file.')).toBeTruthy();
  });

  it('filters, and says so when nothing matches', async () => {
    const loadMap = vi.fn((q: string) =>
      Promise.resolve(q ? { total: 0, files: [] } : MAP),
    );
    view({ loadMap });
    await screen.findByText('src/App.tsx');

    fireEvent.change(screen.getByLabelText('Filter the repo map'), { target: { value: 'nothing' } });
    // Debounced, so this is not one request per keystroke.
    await waitFor(() => expect(loadMap).toHaveBeenLastCalledWith('nothing'));
    expect(await screen.findByText('No file or symbol matches.')).toBeTruthy();
  });

  it('tells you the map is empty rather than that your filter failed', async () => {
    view({
      status: { ...STATUS, repoMap: { ready: false, files: 0, symbols: 0, links: 0 } },
      loadMap: () => Promise.resolve({ total: 0, files: [] }),
    });
    expect(await screen.findByText(/Nothing indexed yet/)).toBeTruthy();
  });

  it('will not rebuild or clear mid-run', () => {
    const onRebuild = vi.fn();
    view({ busy: true, onRebuild });
    fireEvent.click(screen.getByText('Rebuild index'));
    expect(onRebuild).not.toHaveBeenCalled();
  });
});
