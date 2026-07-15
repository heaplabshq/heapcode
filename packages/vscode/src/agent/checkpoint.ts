import * as vscode from 'vscode';
import type { ChangedFile } from '@heapcode/core';

interface Entry {
  uri: vscode.Uri;
  /** Content before the agent's first touch; null = file didn't exist. */
  original: Uint8Array | null;
  /** Content when the session ended; null = agent deleted the file. */
  final?: Uint8Array | null;
  /** Currently showing the original (user clicked Revert). */
  reverted: boolean;
}

/**
 * Snapshot of every file the agent touches in a session, taken before its
 * first modification, plus the agent's final version captured at session end.
 * Powers per-file Keep / Revert / Reapply and "revert all" — reverted entries
 * stay tracked so a revert (or a manual undo) is recoverable via Reapply.
 */
export class SessionCheckpoint {
  private entries = new Map<string, Entry>();

  async recordBeforeChange(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (this.entries.has(key)) return;
    let original: Uint8Array | null;
    try {
      original = await vscode.workspace.fs.readFile(uri);
    } catch {
      original = null; // new file
    }
    this.entries.set(key, { uri, original, reverted: false });
  }

  /** Capture each touched file's current content as the agent's final version. */
  async captureFinals(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        entry.final = await vscode.workspace.fs.readFile(entry.uri);
      } catch {
        entry.final = null; // agent deleted it
      }
    }
  }

  changedFiles(): ChangedFile[] {
    return [...this.entries.values()].map((e) => ({
      path: vscode.workspace.asRelativePath(e.uri, false),
      reverted: e.reverted,
    }));
  }

  /** Find the checkpoint entry for a workspace-relative path. */
  entryFor(relPath: string): { uri: vscode.Uri; original: Uint8Array | null } | undefined {
    return this.find(relPath);
  }

  private find(relPath: string): Entry | undefined {
    for (const entry of this.entries.values()) {
      if (vscode.workspace.asRelativePath(entry.uri, false) === relPath) return entry;
    }
    return undefined;
  }

  /** Restore a file's pre-agent content; the entry stays for Reapply. */
  async revertFile(relPath: string): Promise<boolean> {
    const entry = this.find(relPath);
    if (!entry) return false;
    if (entry.final === undefined) {
      try {
        entry.final = await vscode.workspace.fs.readFile(entry.uri);
      } catch {
        entry.final = null;
      }
    }
    if (!(await writeOrDelete(entry.uri, entry.original))) return false;
    entry.reverted = true;
    return true;
  }

  /** Write the agent's version back (after a Revert or a manual undo). */
  async reapplyFile(relPath: string): Promise<boolean> {
    const entry = this.find(relPath);
    if (!entry || entry.final === undefined) return false;
    if (!(await writeOrDelete(entry.uri, entry.final))) return false;
    entry.reverted = false;
    return true;
  }

  /** Accept a file's changes and stop tracking it. */
  keepFile(relPath: string): void {
    const entry = this.find(relPath);
    if (entry) this.entries.delete(entry.uri.toString());
  }

  /** Accept every remaining tracked file at once (already-reverted ones stay revertible). */
  keepAll(): string[] {
    const kept: string[] = [];
    for (const [key, entry] of [...this.entries]) {
      if (entry.reverted) continue;
      kept.push(vscode.workspace.asRelativePath(entry.uri, false));
      this.entries.delete(key);
    }
    return kept;
  }

  get size(): number {
    return this.entries.size;
  }

  async revertAll(): Promise<string[]> {
    const reverted: string[] = [];
    for (const entry of this.entries.values()) {
      const rel = vscode.workspace.asRelativePath(entry.uri, false);
      if (await this.revertFile(rel)) reverted.push(rel);
    }
    return reverted;
  }
}

/** Write bytes, or delete the file when bytes is null (it didn't/shouldn't exist). */
async function writeOrDelete(uri: vscode.Uri, bytes: Uint8Array | null): Promise<boolean> {
  try {
    if (bytes === null) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch {
        // already gone — the desired state
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, bytes);
    }
    return true;
  } catch {
    return false;
  }
}
