import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listDirectory } from '../src/workspace.js';

/**
 * The panel used to drop anything `.gitignore` matched, which made it show
 * less of the folder than the agent could see: `read_file` and `list_dir`
 * never consulted gitignore, so a note someone had deliberately kept out of
 * git was simply missing from the files list with nothing to explain it.
 *
 * Reported against a real repo — `docs/heapkit-tool-roadmap.md`, one
 * explicitly ignored file, invisible in the panel and readable by the agent.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'docs', 'roadmap.md'), '# plans', 'utf8');
  await writeFile(join(root, 'docs', 'public.md'), '# shipped', 'utf8');
  await writeFile(join(root, 'README.md'), '# hi', 'utf8');
  await writeFile(join(root, '.gitignore'), 'docs/roadmap.md\ndist/\n', 'utf8');
});

describe('the workspace file tree', () => {
  it('shows an ignored file, marked', async () => {
    const entries = await listDirectory(root, 'docs');
    const roadmap = entries.find((e) => e.name === 'roadmap.md');
    expect(roadmap, 'the ignored file is missing from the listing').toBeTruthy();
    expect(roadmap?.ignored).toBe(true);
  });

  it('leaves everything else unmarked', async () => {
    const entries = await listDirectory(root, 'docs');
    expect(entries.find((e) => e.name === 'public.md')?.ignored).toBeUndefined();
  });

  it('marks an ignored directory too', async () => {
    const entries = await listDirectory(root, '');
    expect(entries.find((e) => e.name === 'dist')?.ignored).toBe(true);
    expect(entries.find((e) => e.name === 'docs')?.ignored).toBeUndefined();
  });

  it('still drops the two that are only noise', async () => {
    // .git is enormous and node_modules is not yours; neither is a file you
    // were looking for.
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    const names = (await listDirectory(root, '')).map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names).not.toContain('node_modules');
  });
});
