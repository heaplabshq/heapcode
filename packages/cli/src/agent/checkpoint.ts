import { readFile, unlink, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { ChangedFile } from '@heapcode/core';

interface Entry {
  path: string;
  /** Content before the agent's first touch; null = file didn't exist. */
  original: Buffer | null;
  /** Content when the session ended; null = agent deleted the file. */
  final?: Buffer | null;
  /** Currently showing the original (user asked to revert). */
  reverted: boolean;
}

/**
 * Node-native port of packages/vscode/src/agent/checkpoint.ts's
 * SessionCheckpoint — same per-file before/after snapshot + revert/reapply/
 * keep/revert-all state machine, via fs/promises + plain paths instead of
 * vscode.workspace.fs/Uri. No vscode-specific behavior (like trash-delete)
 * was relied on beyond a boolean flag, so this is a straightforward port.
 */
export class SessionCheckpoint {
  private entries = new Map<string, Entry>();

  constructor(private readonly root: string) {}

  async recordBeforeChange(absPath: string): Promise<void> {
    if (this.entries.has(absPath)) return;
    let original: Buffer | null;
    try {
      original = await readFile(absPath);
    } catch {
      original = null; // new file
    }
    this.entries.set(absPath, { path: absPath, original, reverted: false });
  }

  changedFiles(): ChangedFile[] {
    return [...this.entries.values()].map((e) => ({ path: this.relPath(e.path), reverted: e.reverted }));
  }

  entryFor(relPath: string): { path: string; original: Buffer | null } | undefined {
    return this.find(relPath);
  }

  private relPath(absPath: string): string {
    return relative(this.root, absPath).replace(/\\/g, '/');
  }

  private find(relPath: string): Entry | undefined {
    for (const entry of this.entries.values()) {
      if (this.relPath(entry.path) === relPath) return entry;
    }
    return undefined;
  }

  /** Restore a file's pre-agent content; the entry stays for Reapply. */
  async revertFile(relPath: string): Promise<boolean> {
    const entry = this.find(relPath);
    if (!entry) return false;
    if (entry.final === undefined) {
      try {
        entry.final = await readFile(entry.path);
      } catch {
        entry.final = null;
      }
    }
    if (!(await writeOrDelete(entry.path, entry.original))) return false;
    entry.reverted = true;
    return true;
  }

  /** Write the agent's version back (after a Revert). */
  async reapplyFile(relPath: string): Promise<boolean> {
    const entry = this.find(relPath);
    if (!entry || entry.final === undefined) return false;
    if (!(await writeOrDelete(entry.path, entry.final))) return false;
    entry.reverted = false;
    return true;
  }

  /** Accept a file's changes and stop tracking it. */
  keepFile(relPath: string): void {
    const entry = this.find(relPath);
    if (entry) this.entries.delete(entry.path);
  }

  /** Accept every remaining tracked file at once (already-reverted ones stay revertible). */
  keepAll(): string[] {
    const kept: string[] = [];
    for (const [key, entry] of [...this.entries]) {
      if (entry.reverted) continue;
      kept.push(this.relPath(entry.path));
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
      const rel = this.relPath(entry.path);
      if (await this.revertFile(rel)) reverted.push(rel);
    }
    return reverted;
  }
}

/** Write bytes, or delete the file when bytes is null (it didn't/shouldn't exist). */
async function writeOrDelete(path: string, bytes: Buffer | null): Promise<boolean> {
  try {
    if (bytes === null) {
      try {
        await unlink(path);
      } catch {
        // already gone — the desired state
      }
    } else {
      await writeFile(path, bytes);
    }
    return true;
  } catch {
    return false;
  }
}
