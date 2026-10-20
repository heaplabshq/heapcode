import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, bulkAction, mergeNotes } from '../src/index.js';

let root: string;
let vault: Vault;
const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'heapnotes-bulk-'));
  put('A.md', '---\nid: A\n---\n# Alpha\nFirst.\n');
  put('B.md', '---\nid: B\n---\n# Beta\nSecond.\n');
  put('sub/C.md', '---\nid: C\n---\n# Gamma\n![](assets/c.png)\n');
  vault = await Vault.open({ root, indexFile: ':memory:', staleMs: 0 });
});

afterEach(() => {
  vault.close();
  rmSync(root, { recursive: true, force: true });
});

describe('bulk actions', () => {
  it('applies to each note, and reports the ones it could not change', async () => {
    const r = await bulkAction(vault, ['A', 'B', 'GONE'], 'addTag', 'work');
    expect(r.done).toBe(2);
    expect(r.failed.map((f) => f.id)).toEqual(['GONE']);
    expect((await vault.get({ id: 'B' })).tags).toEqual(['work']);
    await bulkAction(vault, ['A', 'B'], 'pin');
    expect((await vault.get({ id: 'A' })).pinned).toBe(true);
    await bulkAction(vault, ['A', 'B'], 'trash');
    expect((await vault.get({ id: 'A' })).location).toBe('trash');
    await expect(bulkAction(vault, ['A'], 'addTag')).rejects.toThrow(/tag/);
  });
});

describe('merge', () => {
  it('joins notes in order under the first title, re-points links, and trashes the originals', async () => {
    const merged = await mergeNotes(vault, ['A', 'B', 'C']);
    const text = (await vault.read({ id: merged.id })).content;
    expect(text).toBe('# Alpha\nFirst.\n\n## Beta\nSecond.\n\n## Gamma\n![](sub/assets/c.png)\n');
    for (const id of ['A', 'B', 'C']) expect((await vault.get({ id })).location).toBe('trash');
    // The first note's file name, not "Alpha 2".
    expect(merged.path).toBe('Alpha.md');
    await expect(mergeNotes(vault, ['A'])).rejects.toThrow(/two or more/);
  });
});
