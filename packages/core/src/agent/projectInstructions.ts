import type { FileTree } from '../fs.js';
import { matchesAnyGlob, parseInstructionFile } from '../instructions.js';

const MAX_CHARS = 4_000;
const CONFIG_DIR = '.heapcode';
const INSTRUCTIONS_DIR = `${CONFIG_DIR}/instructions`;
const MEMORY_FILE = `${CONFIG_DIR}/memory.md`;

export const MEMORY_TEMPLATE = `# Heap Code Memory

Notes Heap Code should remember about this project. Loaded into every chat and
agent session. Keep it short — it costs context tokens.

## Conventions

-

## Gotchas

-

## Decisions

-
`;

/**
 * Project instructions injected into chat/agent system context:
 * .heapcode/HEAPCODE.md (project instructions, with a workspace-root
 * fallback for projects predating the move into .heapcode/) or AGENTS.md
 * (the cross-tool convention, used only when no Heap Code-specific file
 * exists) + .heapcode/memory.md (accumulated notes) + any path-scoped files
 * under .heapcode/instructions/ that apply.
 *
 * `activeFilePath` is the editor's current file, which scoped instructions
 * match their `applyTo` globs against. The CLI has no such concept and
 * passes nothing, in which case only globally-scoped (`**`) files apply.
 */
export async function loadProjectInstructions(tree: FileTree, activeFilePath?: string): Promise<string> {
  const parts: string[] = [];

  const read = async (rel: string): Promise<string> => (await tree.readFile(rel))?.slice(0, MAX_CHARS).trim() ?? '';

  const heapcodeMd = (await read(`${CONFIG_DIR}/HEAPCODE.md`)) || (await read('HEAPCODE.md'));
  const agentsMd = heapcodeMd ? '' : await read('AGENTS.md');
  if (heapcodeMd) parts.push(`Project instructions (HEAPCODE.md):\n${heapcodeMd}`);
  else if (agentsMd) parts.push(`Project instructions (AGENTS.md):\n${agentsMd}`);

  const memory = await read(MEMORY_FILE);
  if (memory) parts.push(`Project memory (${MEMORY_FILE}):\n${memory}`);

  const scoped = await loadScopedInstructions(tree, activeFilePath);
  if (scoped) parts.push(scoped);

  return parts.join('\n\n');
}

/** Reads .heapcode/instructions/*.md and returns the ones applicable to `activeFilePath`, formatted. */
async function loadScopedInstructions(tree: FileTree, activeFilePath?: string): Promise<string> {
  // Sorted by filename. The two hosts disagreed here — the CLI sorted, the
  // extension took whatever order the filesystem returned — and these blocks
  // are concatenated into the prompt, so the unsorted side could feed the
  // model the same instructions in a different order on a different machine.
  // Sorting is the deterministic choice, and it lets users control precedence
  // by naming (10-*.md before 20-*.md).
  const names = (await tree.readDirectory(INSTRUCTIONS_DIR))
    .filter((e) => !e.isDirectory && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();

  const blocks: string[] = [];
  for (const name of names) {
    const content = await tree.readFile(`${INSTRUCTIONS_DIR}/${name}`);
    if (content === undefined) continue;
    const { applyTo, body } = parseInstructionFile(content);
    // With no active file to check against, only globally-scoped (`**`) files apply.
    const applies = activeFilePath ? matchesAnyGlob(applyTo, activeFilePath) : applyTo.includes('**');
    if (!applies) continue;
    blocks.push(`Instructions (${INSTRUCTIONS_DIR}/${name}, applyTo: ${applyTo.join(', ')}):\n${body.slice(0, MAX_CHARS)}`);
  }
  return blocks.join('\n\n');
}

/**
 * Appends a dated note to .heapcode/memory.md, creating it from the template
 * if absent.
 *
 * Session-to-memory distillation: the note is one the agent proposed as
 * worth remembering (see loop.ts's onMemoryCandidate), and is only ever
 * written after the user has explicitly confirmed it.
 */
export async function appendMemoryNote(tree: FileTree, note: string): Promise<void> {
  const existing = (await tree.readFile(MEMORY_FILE)) ?? MEMORY_TEMPLATE;
  await tree.writeFile(MEMORY_FILE, `${existing}\n- ${new Date().toISOString().slice(0, 10)}: ${note}\n`);
}
