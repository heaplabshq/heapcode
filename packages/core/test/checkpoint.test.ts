import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionCheckpoint, nodeFileHandles } from '../src/index.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-checkpoint-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SessionCheckpoint', () => {
  it('reverts a modified file to its pre-agent content', async () => {
    const file = join(root, 'a.txt');
    await writeFile(file, 'original');
    const cp = new SessionCheckpoint(nodeFileHandles(root));

    await cp.recordBeforeChange(file);
    await writeFile(file, 'changed by agent');

    expect(await cp.revertFile('a.txt')).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('reverting a file the agent created deletes it (original was null)', async () => {
    const file = join(root, 'new.txt');
    const cp = new SessionCheckpoint(nodeFileHandles(root));

    await cp.recordBeforeChange(file); // file doesn't exist yet
    await writeFile(file, 'agent-created content');

    expect(await cp.revertFile('new.txt')).toBe(true);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('reapply restores the agent version after a revert', async () => {
    const file = join(root, 'a.txt');
    await writeFile(file, 'original');
    const cp = new SessionCheckpoint(nodeFileHandles(root));
    await cp.recordBeforeChange(file);
    await writeFile(file, 'agent version');

    await cp.revertFile('a.txt');
    expect(await readFile(file, 'utf8')).toBe('original');

    await cp.reapplyFile('a.txt');
    expect(await readFile(file, 'utf8')).toBe('agent version');
  });

  it('keepFile stops tracking without touching the file', async () => {
    const file = join(root, 'a.txt');
    await writeFile(file, 'original');
    const cp = new SessionCheckpoint(nodeFileHandles(root));
    await cp.recordBeforeChange(file);
    await writeFile(file, 'agent version');

    cp.keepFile('a.txt');
    expect(cp.size).toBe(0);
    expect(await readFile(file, 'utf8')).toBe('agent version');
  });

  it('revertAll restores every tracked file and reports the reverted paths', async () => {
    const fileA = join(root, 'a.txt');
    const fileB = join(root, 'b.txt');
    await writeFile(fileA, 'a-original');
    await writeFile(fileB, 'b-original');
    const cp = new SessionCheckpoint(nodeFileHandles(root));
    await cp.recordBeforeChange(fileA);
    await cp.recordBeforeChange(fileB);
    await writeFile(fileA, 'a-changed');
    await writeFile(fileB, 'b-changed');

    const reverted = await cp.revertAll();

    expect(reverted.sort()).toEqual(['a.txt', 'b.txt']);
    expect(await readFile(fileA, 'utf8')).toBe('a-original');
    expect(await readFile(fileB, 'utf8')).toBe('b-original');
  });

  it('recordBeforeChange is a no-op on a second call for the same file (keeps the first snapshot)', async () => {
    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    const cp = new SessionCheckpoint(nodeFileHandles(root));
    await cp.recordBeforeChange(file);
    await writeFile(file, 'v2');
    await cp.recordBeforeChange(file); // should NOT re-snapshot v2 as "original"
    await writeFile(file, 'v3');

    await cp.revertFile('a.txt');
    expect(await readFile(file, 'utf8')).toBe('v1');
  });

  it('captureFinals snapshots the agent version up front, so a later revert/reapply round-trips', async () => {
    // Only the extension called this before the two copies merged, and it had
    // no test for it; the CLI's lazy capture inside revertFile is the path its
    // own tests covered.
    const file = join(root, 'a.txt');
    const deleted = join(root, 'gone.txt');
    await writeFile(file, 'original');
    await writeFile(deleted, 'doomed');
    const cp = new SessionCheckpoint(nodeFileHandles(root));
    await cp.recordBeforeChange(file);
    await cp.recordBeforeChange(deleted);

    await writeFile(file, 'agent version');
    await rm(deleted);
    await cp.captureFinals();

    await cp.revertAll();
    expect(await readFile(file, 'utf8')).toBe('original');
    expect(await readFile(deleted, 'utf8')).toBe('doomed');

    await cp.reapplyFile('a.txt');
    expect(await readFile(file, 'utf8')).toBe('agent version');
    // The agent's "final" for a file it deleted is deletion — reapply redoes it.
    await cp.reapplyFile('gone.txt');
    await expect(readFile(deleted, 'utf8')).rejects.toThrow();
  });

  it('changedFiles reports workspace-relative paths and revert state', async () => {
    // recordBeforeChange doesn't require the file to exist yet (it snapshots
    // "didn't exist" as the original state) — no write needed for this check.
    const file = join(root, 'sub', 'a.txt');
    const cp = new SessionCheckpoint(nodeFileHandles(root));
    await cp.recordBeforeChange(file);

    expect(cp.changedFiles()).toEqual([{ path: 'sub/a.txt', reverted: false }]);
  });
});
