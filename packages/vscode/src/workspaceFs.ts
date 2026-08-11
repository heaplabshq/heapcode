import * as vscode from 'vscode';
import type { DirectoryEntry, FileTree } from '@heapcode/core';

/**
 * `vscode.workspace.fs` behind core's FileTree seam, rooted at `base`.
 *
 * Paths stay relative and joining goes through `Uri.joinPath`, so this keeps
 * working in a remote or virtual workspace where the root has no local path
 * at all — which is why core's shared subsystems never see an absolute path.
 */
export function uriFileTree(base: vscode.Uri): FileTree {
  const uri = (rel: string): vscode.Uri =>
    rel ? vscode.Uri.joinPath(base, ...rel.split('/')) : base;
  return {
    readFile: async (rel) => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(rel)));
      } catch {
        return undefined;
      }
    },
    writeFile: async (rel, text) => {
      const target = uri(rel);
      await vscode.workspace.fs.createDirectory(target.with({ path: dirname(target.path) }));
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    },
    readDirectory: async (rel) => {
      try {
        const entries = await vscode.workspace.fs.readDirectory(uri(rel));
        return entries.map(([name, type]): DirectoryEntry => ({
          name,
          isDirectory: type === vscode.FileType.Directory,
        }));
      } catch {
        return [];
      }
    },
  };
}

/** Uri paths are always '/'-separated, whatever the platform. */
function dirname(uriPath: string): string {
  const cut = uriPath.lastIndexOf('/');
  return cut > 0 ? uriPath.slice(0, cut) : '/';
}
