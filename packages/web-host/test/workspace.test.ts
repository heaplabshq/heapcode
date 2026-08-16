import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectory, readWorkspaceFile, resolveInRoot, MAX_FILE_BYTES } from '../src/workspace.js';

/**
 * The workspace jail (WEB_APP_PLAN §6.1 / W3.3).
 *
 * Every read here can be triggered by the browser — and a path can originate
 * from a model, which is not a trusted source either. Containment is therefore
 * the property worth testing directly rather than inferring from a `join()`.
 */

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hcws-'));
  outside = await mkdtemp(join(tmpdir(), 'hcoutside-'));
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n', 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'bundle.js'), 'built', 'utf8');
  await writeFile(join(root, 'debug.log'), 'noise', 'utf8');
  await mkdir(join(root, 'node_modules'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('resolveInRoot', () => {
  it('accepts an ordinary relative path', () => {
    expect(resolveInRoot(root, 'src/b.ts')).toBe(join(root, 'src', 'b.ts'));
  });

  it('rejects traversal out of the workspace', () => {
    for (const p of ['../secret.txt', '../../etc/passwd', 'src/../../escape', './../../x']) {
      expect(() => resolveInRoot(root, p), p).toThrow(/escapes the workspace/);
    }
  });

  it('rejects an absolute path outright', () => {
    // Not normalized into something plausible — an absolute path is simply
    // never a workspace-relative one.
    expect(() => resolveInRoot(root, join(outside, 'secret.txt'))).toThrow(/must be relative/);
    expect(() => resolveInRoot(root, '/etc/passwd')).toThrow(/must be relative/);
  });

  it('rejects a NUL byte', () => {
    expect(() => resolveInRoot(root, 'a\0.ts')).toThrow(/Invalid path/);
  });

  it('allows a path that merely starts with the root name but sits beside it', () => {
    // The classic prefix bug: `/tmp/ws` vs `/tmp/ws-evil`.
    expect(() => resolveInRoot(root, `../${root.split('/').pop()}-evil/x`)).toThrow(/escapes the workspace/);
  });
});

describe('listDirectory', () => {
  it('lists the root, directories first', async () => {
    const entries = await listDirectory(root, '');
    const names = entries.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('a.ts');
    expect(entries[0]!.directory).toBe(true);
  });

  it('honours .gitignore and skips node_modules and .git', async () => {
    const names = (await listDirectory(root, '')).map((e) => e.name);
    expect(names).not.toContain('dist');
    expect(names).not.toContain('debug.log');
    expect(names).not.toContain('node_modules');
  });

  it('refuses to list outside the workspace', async () => {
    await expect(listDirectory(root, '../')).rejects.toThrow(/escapes|relative/);
  });
});

describe('readWorkspaceFile', () => {
  it('reads a text file', async () => {
    const { content } = await readWorkspaceFile(root, 'a.ts');
    expect(content).toBe('export const a = 1;\n');
  });

  it('returns a note instead of bytes for a binary file', async () => {
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const { content, note } = await readWorkspaceFile(root, 'blob.bin');
    expect(content).toBe('');
    expect(note).toMatch(/Binary/);
  });

  it('refuses an oversized file rather than shipping it to the browser', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 10), 'utf8');
    const { note } = await readWorkspaceFile(root, 'big.txt');
    expect(note).toMatch(/too large/);
  });

  it('cannot be pointed outside the workspace', async () => {
    await expect(readWorkspaceFile(root, '../secret.txt')).rejects.toThrow(/escapes the workspace/);
  });
});
