import * as vscode from 'vscode';
import { JsonConversationStore as CoreJsonConversationStore, type TextFileStore } from '@heapcode/core';

const FILE_NAME = 'conversations.json';

/**
 * The shared JSON conversation store (@heapcode/core) on workspace.fs,
 * writing into extension storage (workspace-scoped when a folder is open,
 * global otherwise). Only the file access is here; the store itself is
 * shared with the CLI.
 */
export class JsonConversationStore extends CoreJsonConversationStore {
  constructor(storageDir: vscode.Uri) {
    super(storageFile(storageDir));
  }
}

function storageFile(storageDir: vscode.Uri): TextFileStore {
  const uri = vscode.Uri.joinPath(storageDir, FILE_NAME);
  return {
    read: async () => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        return undefined; // first run or unreadable
      }
    },
    write: async (text) => {
      await vscode.workspace.fs.createDirectory(storageDir);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    },
  };
}
