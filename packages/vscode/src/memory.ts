import * as vscode from 'vscode';
import { matchesAnyGlob, parseInstructionFile } from '@heapcode/core';

const MAX_CHARS = 4_000;
const INSTRUCTIONS_DIR = '.heapcode/instructions';

const MEMORY_TEMPLATE = `# Heap Code Memory

Notes Heap Code should remember about this project. Loaded into every chat and
agent session. Keep it short — it costs context tokens.

## Coding style

-

## Architecture

-

## Preferences

-
`;

/**
 * Project instructions injected into chat/agent system context:
 * .heapcode/HEAPCODE.md (project instructions) + .heapcode/memory.md (accumulated notes)
 * + any path-scoped files under .heapcode/instructions/ whose `applyTo` glob
 * matches the active file (or that apply everywhere, if no active file).
 */
export async function loadProjectInstructions(activeFilePath?: string): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return '';
  const parts: string[] = [];

  const read = async (rel: string): Promise<string> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel));
      return new TextDecoder().decode(bytes).slice(0, MAX_CHARS).trim();
    } catch {
      return '';
    }
  };

  // Older projects may still have it at the workspace root, from before this moved into .heapcode/.
  const heapcodeMd = (await read('.heapcode/HEAPCODE.md')) || (await read('HEAPCODE.md'));
  // AGENTS.md is the widely-adopted cross-tool convention — only used when this
  // project has no Heap Code-specific instructions of its own.
  const agentsMd = heapcodeMd ? '' : await read('AGENTS.md');
  if (heapcodeMd) parts.push(`Project instructions (HEAPCODE.md):\n${heapcodeMd}`);
  else if (agentsMd) parts.push(`Project instructions (AGENTS.md):\n${agentsMd}`);
  const memory = await read('.heapcode/memory.md');
  if (memory) parts.push(`Project memory (.heapcode/memory.md):\n${memory}`);

  const scoped = await loadScopedInstructions(root, activeFilePath);
  if (scoped) parts.push(scoped);

  return parts.join('\n\n');
}

/** Reads .heapcode/instructions/*.md and returns the ones applicable to `activeFilePath`, formatted. */
async function loadScopedInstructions(root: vscode.Uri, activeFilePath?: string): Promise<string> {
  const dir = vscode.Uri.joinPath(root, INSTRUCTIONS_DIR);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return '';
  }

  const blocks: string[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith('.md')) continue;
    let content: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
      content = new TextDecoder().decode(bytes);
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

/**
 * Session-to-memory distillation: appends a note the agent proposed as worth
 * remembering (packages/core/src/agent/loop.ts's onMemoryCandidate) — only
 * ever called after the user has explicitly confirmed it in chat.
 */
export async function appendMemoryNote(note: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;
  const dir = vscode.Uri.joinPath(root, '.heapcode');
  const uri = vscode.Uri.joinPath(dir, 'memory.md');
  let existing: string;
  try {
    existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    existing = MEMORY_TEMPLATE;
  }
  const entry = `\n- ${new Date().toISOString().slice(0, 10)}: ${note}\n`;
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(existing + entry));
}

export async function openMemoryFile(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    void vscode.window.showWarningMessage('Heap Code: open a workspace folder first.');
    return;
  }
  const uri = vscode.Uri.joinPath(root, '.heapcode', 'memory.md');
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.heapcode'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(MEMORY_TEMPLATE));
  }
  await vscode.window.showTextDocument(uri);
}
