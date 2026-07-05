import * as vscode from 'vscode';

const MAX_CHARS = 4_000;

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
 * HEAPCODE.md (project instructions) + .heapcode/memory.md (accumulated notes).
 */
export async function loadProjectInstructions(): Promise<string> {
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

  const heapcodeMd = await read('HEAPCODE.md');
  if (heapcodeMd) parts.push(`Project instructions (HEAPCODE.md):\n${heapcodeMd}`);
  const memory = await read('.heapcode/memory.md');
  if (memory) parts.push(`Project memory (.heapcode/memory.md):\n${memory}`);

  return parts.join('\n\n');
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
