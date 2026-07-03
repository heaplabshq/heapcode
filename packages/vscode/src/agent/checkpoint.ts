import * as vscode from 'vscode';

/**
 * Snapshot of every file the agent touches in a session, taken before its
 * first modification. Powers "revert all" — restores content byte-identical,
 * deletes files the agent created.
 */
export class SessionCheckpoint {
  /** uri string → original bytes, or null if the file didn't exist. */
  private originals = new Map<string, Uint8Array | null>();

  async recordBeforeChange(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (this.originals.has(key)) return;
    try {
      this.originals.set(key, await vscode.workspace.fs.readFile(uri));
    } catch {
      this.originals.set(key, null); // new file
    }
  }

  changedFiles(): string[] {
    return [...this.originals.keys()].map((k) =>
      vscode.workspace.asRelativePath(vscode.Uri.parse(k), false),
    );
  }

  get size(): number {
    return this.originals.size;
  }

  async revertAll(): Promise<string[]> {
    const reverted: string[] = [];
    for (const [key, original] of this.originals) {
      const uri = vscode.Uri.parse(key);
      try {
        if (original === null) {
          await vscode.workspace.fs.delete(uri, { useTrash: false });
        } else {
          await vscode.workspace.fs.writeFile(uri, original);
        }
        reverted.push(vscode.workspace.asRelativePath(uri, false));
      } catch {
        // File may already be gone (e.g. reverting a created-then-deleted file).
      }
    }
    this.originals.clear();
    return reverted;
  }
}
