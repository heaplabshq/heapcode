import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { RetentionTracker } from '../src/retentionTracker.js';

/** Bare enough to satisfy vscode.Memento — RetentionTracker only calls get/update. */
function fakeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: ((key: string, fallback?: unknown) => store.get(key) ?? fallback) as vscode.Memento['get'],
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
}

function fakeUri(uri: string): vscode.Uri {
  return { toString: () => uri } as vscode.Uri;
}

function fakeDocument(uri: string, text: string): vscode.TextDocument {
  return { uri: fakeUri(uri), getText: () => text } as unknown as vscode.TextDocument;
}

describe('RetentionTracker', () => {
  it('fires retained after the accepted text survives N saves', () => {
    const track = vi.fn();
    const tracker = new RetentionTracker(fakeMemento(), track);
    tracker.watch('completion', fakeUri('file:///a.ts'), 'const x = 1;');

    tracker.checkOnSave(fakeDocument('file:///a.ts', 'const x = 1;\nconsole.log(x);'));
    tracker.checkOnSave(fakeDocument('file:///a.ts', 'const x = 1;\nconsole.log(x);\n// more'));
    expect(track).not.toHaveBeenCalled();

    tracker.checkOnSave(fakeDocument('file:///a.ts', 'const x = 1;\ndone();'));
    expect(track).toHaveBeenCalledWith('completion.retained', { savesSeen: 3 });
  });

  it('fires reverted the moment the accepted text disappears', () => {
    const track = vi.fn();
    const tracker = new RetentionTracker(fakeMemento(), track);
    tracker.watch('edit', fakeUri('file:///a.ts'), 'const x = 1;');

    tracker.checkOnSave(fakeDocument('file:///a.ts', 'const x = 1;\nconsole.log(x);'));
    expect(track).not.toHaveBeenCalled();

    tracker.checkOnSave(fakeDocument('file:///a.ts', 'const x = 2; // reverted'));
    expect(track).toHaveBeenCalledWith('edit.reverted', { savesSeen: 1 });
  });

  it('ignores saves of a different file', () => {
    const track = vi.fn();
    const tracker = new RetentionTracker(fakeMemento(), track);
    tracker.watch('completion', fakeUri('file:///a.ts'), 'const x = 1;');

    tracker.checkOnSave(fakeDocument('file:///b.ts', 'unrelated content'));
    expect(track).not.toHaveBeenCalled();
  });

  it('ignores an empty accepted text', () => {
    const track = vi.fn();
    const tracker = new RetentionTracker(fakeMemento(), track);
    tracker.watch('completion', fakeUri('file:///a.ts'), '   ');

    tracker.checkOnSave(fakeDocument('file:///a.ts', 'whatever'));
    expect(track).not.toHaveBeenCalled();
  });

  it('persists watches across instances via the same Memento', () => {
    const memento = fakeMemento();
    const track = vi.fn();
    new RetentionTracker(memento, track).watch('edit', fakeUri('file:///a.ts'), 'const x = 1;');

    // A fresh instance (e.g. after a window reload) picks up the pending watch.
    const reloaded = new RetentionTracker(memento, track);
    reloaded.checkOnSave(fakeDocument('file:///a.ts', 'const x = 2; // gone'));
    expect(track).toHaveBeenCalledWith('edit.reverted', { savesSeen: 0 });
  });
});
