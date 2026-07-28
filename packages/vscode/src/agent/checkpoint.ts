import * as vscode from 'vscode';
import { SessionCheckpoint as CoreSessionCheckpoint, type FileHandles } from '@heapcode/core';

/**
 * The shared session checkpoint (@heapcode/core) on workspace.fs, addressed
 * by Uri and reported via asRelativePath. The before/after snapshot and the
 * revert/reapply/keep state machine are shared with the CLI.
 */
export class SessionCheckpoint extends CoreSessionCheckpoint<vscode.Uri> {
  constructor() {
    super(uriFileHandles());
  }
}

function uriFileHandles(): FileHandles<vscode.Uri> {
  return {
    read: async (uri) => {
      try {
        return await vscode.workspace.fs.readFile(uri);
      } catch {
        return undefined;
      }
    },
    write: (uri, bytes) => Promise.resolve(vscode.workspace.fs.writeFile(uri, bytes)),
    delete: async (uri) => {
      try {
        // Permanently, not to trash: this undoes an edit the user never
        // accepted, which is not the same act as the agent deleting a file
        // the user has. Predates the merge with the CLI; unchanged by it.
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch {
        // already gone — the desired state
      }
    },
    key: (uri) => uri.toString(),
    relative: (uri) => vscode.workspace.asRelativePath(uri, false),
  };
}
