import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { __setWorkspaceRoot } from './vscodeStub.js';
import { conversationsUri, createConversationStore, migrateConversations } from '../src/historyStore.js';

/**
 * The extension kept conversations in its own storage while the terminal,
 * `heapcode web` and Heap Chat all shared one file per project. So a chat
 * started in a terminal was not there when the editor opened, and configuring
 * anything twice was the normal experience.
 *
 * What matters in these tests is the fallbacks. The extension has to keep
 * working with no CLI ever installed, and in a workspace that has no
 * filesystem behind it at all.
 */

const MARKER = 'heapcode.historyMigrated';

/** Just the parts of ExtensionContext this module touches. */
function fakeContext(storage: string): vscode.ExtensionContext {
  const state = new Map<string, unknown>();
  return {
    storageUri: vscode.Uri.file(storage),
    globalStorageUri: vscode.Uri.file(join(storage, 'global')),
    workspaceState: {
      get: (key: string) => state.get(key),
      update: (key: string, value: unknown) => {
        state.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as vscode.ExtensionContext;
}

let home: string;
let storage: string;
let project: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'vsc-history-'));
  home = join(base, 'home');
  storage = join(base, 'storage');
  project = join(base, 'project');
  // Keeps every one of these off the real ~/.heapcode.
  process.env.HEAPCODE_HOME = home;
});

afterEach(() => {
  delete process.env.HEAPCODE_HOME;
  __setWorkspaceRoot(undefined);
});

describe('where the extension keeps conversations', () => {
  it('uses the project file every other host uses, for a local folder', () => {
    __setWorkspaceRoot(project, 'file');
    const uri = conversationsUri(fakeContext(storage));
    expect(uri.fsPath.startsWith(join(home, 'projects'))).toBe(true);
    expect(uri.fsPath.endsWith('conversations.json')).toBe(true);
  });

  it('falls back to extension storage when no folder is open', () => {
    __setWorkspaceRoot(undefined);
    expect(conversationsUri(fakeContext(storage)).fsPath).toBe(join(storage, 'conversations.json'));
  });

  it('falls back for a workspace with no filesystem behind it', () => {
    // github.dev and friends: there is no ~/.heapcode to resolve there, and
    // the extension still has to work.
    __setWorkspaceRoot(project, 'vscode-vfs');
    expect(conversationsUri(fakeContext(storage)).fsPath).toBe(join(storage, 'conversations.json'));
  });

  it('needs nothing to already exist, so a machine with no CLI still works', async () => {
    __setWorkspaceRoot(project, 'file');
    const store = createConversationStore(fakeContext(storage));
    await store.save({ id: 'a', title: 'first', updatedAt: 1, messages: [] });
    expect((await store.list()).map((c) => c.id)).toEqual(['a']);
  });
});

describe('conversations written before the move', () => {
  it('are carried into the shared file rather than looking deleted', async () => {
    const context = fakeContext(storage);
    __setWorkspaceRoot(undefined);
    const legacy = createConversationStore(context); // extension storage
    await legacy.save({ id: 'old', title: 'from the editor', updatedAt: 1, messages: [] });

    __setWorkspaceRoot(project, 'file');
    const shared = createConversationStore(context);
    await shared.save({ id: 'new', title: 'from the terminal', updatedAt: 2, messages: [] });
    await migrateConversations(context, shared);

    expect((await shared.list()).map((c) => c.id).sort()).toEqual(['new', 'old']);
  });

  it('runs once, so deleting a carried conversation makes it stay deleted', async () => {
    const context = fakeContext(storage);
    __setWorkspaceRoot(undefined);
    await createConversationStore(context).save({ id: 'old', title: 'old', updatedAt: 1, messages: [] });

    __setWorkspaceRoot(project, 'file');
    const shared = createConversationStore(context);
    await migrateConversations(context, shared);
    expect(context.workspaceState.get(MARKER)).toBe(true);

    await shared.delete('old');
    await migrateConversations(context, shared);
    expect(await shared.list()).toEqual([]);
  });

  it('does nothing when the two are the same file', async () => {
    const context = fakeContext(storage);
    __setWorkspaceRoot(undefined);
    const store = createConversationStore(context);
    await store.save({ id: 'a', title: 'a', updatedAt: 1, messages: [] });

    await migrateConversations(context, store);
    expect((await store.list()).map((c) => c.id)).toEqual(['a']);
  });
});
