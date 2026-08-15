import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShadowGit } from '../src/agent/shadowGit.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-shadowgit-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ShadowGit', () => {
  it('snapshots and restores workspace state, independent of the workspace\'s own .git', async () => {
    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    const sg = new ShadowGit(root, join(root, '.shadow-git'));

    const hash1 = await sg.snapshot('v1');
    expect(hash1).toBeTruthy();

    await writeFile(file, 'v2');
    const hash2 = await sg.snapshot('v2');
    expect(hash2).toBeTruthy();
    expect(hash2).not.toBe(hash1);

    const restored = await sg.restore(hash1!);
    expect(restored).toContain('a.txt');
    expect(await readFile(file, 'utf8')).toBe('v1');

    // No real .git was created in the workspace root itself.
    await expect(readFile(join(root, '.git', 'HEAD'))).rejects.toThrow();
  });

  it('restore is itself undoable — restoring forward to the later snapshot works', async () => {
    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    const sg = new ShadowGit(root, join(root, '.shadow-git'));
    const hash1 = await sg.snapshot('v1');
    await writeFile(file, 'v2');
    const hash2 = await sg.snapshot('v2');

    await sg.restore(hash1!);
    expect(await readFile(file, 'utf8')).toBe('v1');

    await sg.restore(hash2!);
    expect(await readFile(file, 'utf8')).toBe('v2');
  });

  it('restoring a file created after the snapshot deletes it', async () => {
    const sg = new ShadowGit(root, join(root, '.shadow-git'));
    const hash1 = await sg.snapshot('empty');

    const newFile = join(root, 'new.txt');
    await writeFile(newFile, 'created after snapshot');
    await sg.snapshot('added new.txt');

    await sg.restore(hash1!);
    await expect(readFile(newFile, 'utf8')).rejects.toThrow();
  });

  it('self-excludes its own git-dir even when a caller places it inside the workspace without nesting it under an already-ignored directory', async () => {
    // Real usage (cli.tsx) always nests gitDir under .heapcode/ (excluded by
    // DEFAULT_EXCLUDES already), so this specifically exercises the
    // self-protecting fallback in excludeList() for a gitDir that isn't.
    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    const sg = new ShadowGit(root, join(root, '.shadow-git')); // NOT under .heapcode/
    const hash1 = await sg.snapshot('v1');
    await writeFile(file, 'v2');
    await sg.snapshot('v2');

    const restored = await sg.restore(hash1!);
    // If the git-dir's own object files had leaked into tracking, this list
    // would be dominated by hundreds of .shadow-git/objects/* entries.
    expect(restored).toEqual(['a.txt']);
    expect(await readFile(file, 'utf8')).toBe('v1');
  });

  it('logs unavailability instead of throwing when git is not on PATH', async () => {
    const messages: string[] = [];
    const sg = new ShadowGit(root, join(root, '.shadow-git'), (m) => messages.push(m));
    const original = process.env.PATH;
    process.env.PATH = '';
    try {
      const hash = await sg.snapshot('should fail quietly');
      expect(hash).toBeUndefined();
    } finally {
      process.env.PATH = original;
    }
  });
});
