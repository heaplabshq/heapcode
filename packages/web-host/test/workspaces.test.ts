import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceStore, listFolders } from '../src/workspaces.js';

/**
 * The folder picker's two halves: what you opened before, and what is on disk.
 *
 * `listFolders` is the one place in this host that deliberately reads outside
 * the workspace jail, so what it does and does not return is worth pinning
 * down: directory names, never files, never contents.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hcws-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('WorkspaceStore', () => {
  it('records folders newest-first and de-duplicates', async () => {
    const store = new WorkspaceStore(join(dir, 'workspaces.json'));
    const a = join(dir, 'alpha');
    const b = join(dir, 'beta');
    await mkdir(a);
    await mkdir(b);

    await store.record(a);
    await store.record(b);
    await store.record(a); // back to the first one

    const list = await store.list();
    expect(list.map((w) => w.name)).toEqual(['alpha', 'beta']);
  });

  it('hides folders that are no longer there, without forgetting them', async () => {
    // A folder on an unmounted volume is missing today and back tomorrow.
    // Dropping it from the file the first time you looked would be the wrong
    // answer to a temporary condition.
    const file = join(dir, 'workspaces.json');
    const store = new WorkspaceStore(file);
    const gone = join(dir, 'gone');
    await mkdir(gone);
    await store.record(gone);
    await rm(gone, { recursive: true });

    expect(await store.list()).toEqual([]);
    expect(await import('node:fs/promises').then((fs) => fs.readFile(file, 'utf8'))).toContain('gone');
  });

  it('treats an absent or corrupt file as an empty list', async () => {
    expect(await new WorkspaceStore(join(dir, 'nope.json')).list()).toEqual([]);
    const bad = join(dir, 'bad.json');
    await writeFile(bad, 'not json at all', 'utf8');
    expect(await new WorkspaceStore(bad).list()).toEqual([]);
  });
});

describe('listFolders', () => {
  it('returns sub-directories only — never files', async () => {
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'secrets.env'), 'API_KEY=hunter2', 'utf8');

    const { entries } = await listFolders(dir);
    expect(entries.map((e) => e.name)).toEqual(['docs', 'src']);
    // The point of the picker is folders. A file's *name* leaking is a small
    // thing; making it a habit is not.
    expect(JSON.stringify(entries)).not.toContain('secrets.env');
  });

  it('skips dot-directories and node_modules, which are never what you are picking', async () => {
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, 'node_modules'));
    await mkdir(join(dir, 'app'));
    const { entries } = await listFolders(dir);
    expect(entries.map((e) => e.name)).toEqual(['app']);
  });

  it('offers a parent to walk up to, and stops at the filesystem root', async () => {
    const here = await listFolders(dir);
    expect(here.parent).toBeTruthy();
    const root = await listFolders('/');
    expect(root.parent).toBeUndefined();
  });

  it('defaults to the home directory and expands ~', async () => {
    expect((await listFolders()).path).toBe(homedir());
    expect((await listFolders('~')).path).toBe(homedir());
  });

  it('reports an unreadable path instead of throwing something opaque', async () => {
    await expect(listFolders(join(dir, 'does-not-exist'))).rejects.toThrow(/Cannot read/);
  });
});
