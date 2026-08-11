import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendMemoryNote, loadProjectInstructions, nodeFileTree } from '../src/index.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-memory-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadProjectInstructions', () => {
  it('returns empty when no instruction files exist', async () => {
    expect(await loadProjectInstructions(nodeFileTree(root))).toBe('');
  });

  it('loads .heapcode/HEAPCODE.md and memory.md', async () => {
    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'HEAPCODE.md'), 'Use tabs, not spaces.');
    await writeFile(join(root, '.heapcode', 'memory.md'), 'The API client retries twice.');

    const out = await loadProjectInstructions(nodeFileTree(root));
    expect(out).toContain('Project instructions (HEAPCODE.md):\nUse tabs, not spaces.');
    expect(out).toContain('Project memory (.heapcode/memory.md):\nThe API client retries twice.');
  });

  it('falls back to AGENTS.md only when no HEAPCODE.md exists', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Cross-tool instructions.');
    expect(await loadProjectInstructions(nodeFileTree(root))).toContain('Project instructions (AGENTS.md):\nCross-tool instructions.');

    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'HEAPCODE.md'), 'Heapcode-specific.');
    const out = await loadProjectInstructions(nodeFileTree(root));
    expect(out).toContain('Heapcode-specific.');
    expect(out).not.toContain('Cross-tool instructions.');
  });

  it('honors the workspace-root HEAPCODE.md fallback for older projects', async () => {
    await writeFile(join(root, 'HEAPCODE.md'), 'Root-level instructions.');
    expect(await loadProjectInstructions(nodeFileTree(root))).toContain('Root-level instructions.');
  });

  it('applies scoped instructions by applyTo glob; unscoped-only when there is no active file', async () => {
    await mkdir(join(root, '.heapcode', 'instructions'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'instructions', 'global.md'), 'Applies everywhere.');
    await writeFile(
      join(root, '.heapcode', 'instructions', 'ts.md'),
      '---\napplyTo: "**/*.ts"\n---\nTypeScript-only rules.',
    );

    const noActive = await loadProjectInstructions(nodeFileTree(root));
    expect(noActive).toContain('Applies everywhere.');
    expect(noActive).not.toContain('TypeScript-only rules.');

    const tsActive = await loadProjectInstructions(nodeFileTree(root), 'src/foo.ts');
    expect(tsActive).toContain('TypeScript-only rules.');
  });

  it('emits scoped instruction files in filename order, whatever order the filesystem lists them in', async () => {
    // The two hosts disagreed here before this merged: the CLI sorted, the
    // extension used raw readDirectory order. These blocks are concatenated
    // into the prompt, so unsorted meant the model could see the same
    // instructions in a different order on a different machine. Sorted also
    // gives users a way to control precedence by naming (10-, 20-, …).
    await mkdir(join(root, '.heapcode', 'instructions'), { recursive: true });
    for (const name of ['30-third.md', '10-first.md', '20-second.md']) {
      await writeFile(join(root, '.heapcode', 'instructions', name), `Body of ${name}.`);
    }

    const out = await loadProjectInstructions(nodeFileTree(root));
    expect(out.indexOf('10-first.md')).toBeLessThan(out.indexOf('20-second.md'));
    expect(out.indexOf('20-second.md')).toBeLessThan(out.indexOf('30-third.md'));
  });

  it('ignores non-markdown files and directories under instructions/', async () => {
    await mkdir(join(root, '.heapcode', 'instructions', 'nested.md'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'instructions', 'notes.txt'), 'Not markdown.');
    await writeFile(join(root, '.heapcode', 'instructions', 'real.md'), 'Actual instructions.');

    const out = await loadProjectInstructions(nodeFileTree(root));
    expect(out).toContain('Actual instructions.');
    expect(out).not.toContain('Not markdown.');
    expect(out).not.toContain('nested.md');
  });
});

describe('appendMemoryNote', () => {
  it('creates memory.md from the template and appends a dated note', async () => {
    await appendMemoryNote(nodeFileTree(root), 'The build needs Node 20.');
    const content = await readFile(join(root, '.heapcode', 'memory.md'), 'utf8');
    expect(content).toContain('# Heap Code Memory');
    expect(content).toMatch(/- \d{4}-\d{2}-\d{2}: The build needs Node 20\./);

    await appendMemoryNote(nodeFileTree(root), 'Second note.');
    const updated = await readFile(join(root, '.heapcode', 'memory.md'), 'utf8');
    expect(updated).toContain('The build needs Node 20.');
    expect(updated).toContain('Second note.');
  });
});
