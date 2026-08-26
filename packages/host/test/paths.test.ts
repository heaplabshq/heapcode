import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectStateDir as coreProjectStateDir } from '../../core/src/server/address.js';
import { canonicalize, globalDir, projectConfigDir, projectStateDir } from '../src/paths.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-paths-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('projectStateDir', () => {
  it('lives under the global dir, outside the project entirely — never inside <root>', () => {
    const dir = projectStateDir(root);
    expect(dir.startsWith(globalDir())).toBe(true);
    expect(dir.startsWith(root)).toBe(false);
  });

  it('is stable for the same root across repeated calls', () => {
    expect(projectStateDir(root)).toBe(projectStateDir(root));
  });

  it('resolves the same directory whether or not the caller pre-canonicalized root (a real symlinked-tmpdir bug risk)', async () => {
    const real = join(root, 'real');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(real);
    const link = join(root, 'link');
    await symlink(real, link);

    expect(projectStateDir(link)).toBe(projectStateDir(canonicalize(link)));
  });

  it('different projects get different state directories', () => {
    expect(projectStateDir(join(root, 'a'))).not.toBe(projectStateDir(join(root, 'b')));
  });

  it('embeds a readable fragment of the path, not just an opaque hash', () => {
    const dir = projectStateDir(join(root, 'my-project'));
    expect(dir).toContain('my-project');
  });
});

describe('projectStateKey, via projectStateDir', () => {
  // A Windows root reaches this code verbatim: canonicalize() falls back to the
  // raw string when realpath fails, so this case is identical on every platform.
  const winRoot = 'C:\\computer\\job-search';

  it('never puts a character Windows forbids in the directory name (a real ENOENT on every mkdir)', () => {
    const name = projectStateDir(winRoot).slice(globalDir().length);
    expect(name).not.toMatch(/[<>:"|?*\u0000-\u001f]/);
  });

  it('still keeps the drive-lettered path readable and collision-safe', () => {
    const dir = projectStateDir(winRoot);
    expect(dir).toContain('computer-job-search');
    expect(projectStateDir('D:\\computer\\job-search')).not.toBe(dir);
  });

  it("agrees with core's copy of the derivation, or the CLI and the daemon split one project's state in two", () => {
    const home = join(root, 'home');
    const prev = process.env.HEAPCODE_HOME;
    process.env.HEAPCODE_HOME = home;
    try {
      expect(projectStateDir(winRoot)).toBe(coreProjectStateDir(winRoot, home));
      expect(projectStateDir(root)).toBe(coreProjectStateDir(root, home));
    } finally {
      if (prev === undefined) delete process.env.HEAPCODE_HOME;
      else process.env.HEAPCODE_HOME = prev;
    }
  });
});

describe('projectConfigDir', () => {
  it('stays inside the project itself, unlike projectStateDir', () => {
    expect(projectConfigDir(root)).toBe(join(root, '.heapcode'));
  });
});
