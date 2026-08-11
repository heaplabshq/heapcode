import * as vscode from 'vscode';
import {
  MEMORY_TEMPLATE,
  appendMemoryNote as appendMemoryNoteIn,
  loadProjectInstructions as loadProjectInstructionsIn,
} from '@heapcode/core';
import { uriFileTree } from './workspaceFs.js';

/**
 * Project instructions & memory (@heapcode/core) on workspace.fs, rooted at
 * the open folder. Scoped instruction files match their `applyTo` globs
 * against the editor's active file; the reading, ordering and formatting are
 * shared with the CLI.
 */
export async function loadProjectInstructions(activeFilePath?: string): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return '';
  return loadProjectInstructionsIn(uriFileTree(root), activeFilePath);
}

export async function appendMemoryNote(note: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;
  await appendMemoryNoteIn(uriFileTree(root), note);
}

/** Opens .heapcode/memory.md in an editor, seeding it from the template if it doesn't exist yet. */
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
