import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { matchesAnyGlob, parseInstructionFile } from '@heapcode/core';

const MAX_CHARS = 4_000;
const INSTRUCTIONS_DIR = '.heapcode/instructions';

export const MEMORY_TEMPLATE = `# Heap Code Memory

Notes Heap Code should remember about this project. Loaded into every chat and
agent session. Keep it short — it costs context tokens.

## Coding style

-

## Architecture

-

## Preferences

-
`;

async function read(root: string, rel: string): Promise<string> {
  try {
    return (await readFile(join(root, rel), 'utf8')).slice(0, MAX_CHARS).trim();
  } catch {
    return '';
  }
}

/**
 * Node-native port of packages/vscode/src/memory.ts's loadProjectInstructions:
 * .heapcode/HEAPCODE.md (project instructions, workspace-root fallback for
 * older projects) or AGENTS.md (cross-tool convention, only when no Heap
 * Code-specific file exists) + .heapcode/memory.md (accumulated notes) + any
 * path-scoped files under .heapcode/instructions/ that apply. The CLI has no
 * "active file", so only globally-scoped (`**`) instruction files apply.
 */
export async function loadProjectInstructions(root: string, activeFilePath?: string): Promise<string> {
  const parts: string[] = [];

  const heapcodeMd = (await read(root, '.heapcode/HEAPCODE.md')) || (await read(root, 'HEAPCODE.md'));
  const agentsMd = heapcodeMd ? '' : await read(root, 'AGENTS.md');
  if (heapcodeMd) parts.push(`Project instructions (HEAPCODE.md):\n${heapcodeMd}`);
  else if (agentsMd) parts.push(`Project instructions (AGENTS.md):\n${agentsMd}`);
  const memory = await read(root, '.heapcode/memory.md');
  if (memory) parts.push(`Project memory (.heapcode/memory.md):\n${memory}`);

  const scoped = await loadScopedInstructions(root, activeFilePath);
  if (scoped) parts.push(scoped);

  return parts.join('\n\n');
}

/** Reads .heapcode/instructions/*.md and returns the ones applicable to `activeFilePath`, formatted. */
async function loadScopedInstructions(root: string, activeFilePath?: string): Promise<string> {
  let names: string[];
  try {
    names = await readdir(join(root, INSTRUCTIONS_DIR));
  } catch {
    return '';
  }

  const blocks: string[] = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    let content: string;
    try {
      content = await readFile(join(root, INSTRUCTIONS_DIR, name), 'utf8');
    } catch {
      continue;
    }
    const { applyTo, body } = parseInstructionFile(content);
    if (!body) continue;
    // With no active file to check against, only globally-scoped (`**`) files apply.
    const applies = activeFilePath ? matchesAnyGlob(applyTo, activeFilePath) : applyTo.includes('**');
    if (!applies) continue;
    blocks.push(`Instructions (${INSTRUCTIONS_DIR}/${name}, applyTo: ${applyTo.join(', ')}):\n${body.slice(0, MAX_CHARS)}`);
  }
  return blocks.join('\n\n');
}

/** Appends a dated note to .heapcode/memory.md, creating it from the template if absent. */
export async function appendMemoryNote(root: string, note: string): Promise<void> {
  const path = join(root, '.heapcode', 'memory.md');
  let existing: string;
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    existing = MEMORY_TEMPLATE;
  }
  await mkdir(join(root, '.heapcode'), { recursive: true });
  await writeFile(path, `${existing}\n- ${new Date().toISOString().slice(0, 10)}: ${note}\n`, 'utf8');
}
