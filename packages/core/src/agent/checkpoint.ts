import type { FileHandles } from '../fs.js';
import type { ChangedFile } from '../protocol.js';

interface Entry<P> {
  path: P;
  /** Content before the agent's first touch; null = file didn't exist. */
  original: Uint8Array | null;
  /** Content when the session ended; null = agent deleted the file. */
  final?: Uint8Array | null;
  /** Currently showing the original (user asked to revert). */
  reverted: boolean;
}

/**
 * Snapshot of every file the agent touches in a session, taken before its
 * first modification, plus the agent's final version captured at session end.
 * Powers per-file Keep / Revert / Reapply and "revert all" — reverted entries
 * stay tracked so a revert (or a manual undo) is recoverable via Reapply.
 *
 * Generic over the host's own path type (`P`): a string in the CLI, a
 * `vscode.Uri` in the extension. Callers hand it whatever their filesystem
 * already deals in and the injected FileHandles does the rest, which is what
 * lets both hosts' tool executors call this without translating paths.
 *
 * Note that reverting a file the agent created deletes it *permanently* on
 * both hosts — this is not the delete/trash asymmetry that applies to the
 * agent's own delete_file tool. Undoing an edit the user never accepted is
 * not the same act as the agent deleting a file the user has, and the
 * extension's own copy chose `useTrash: false` here long before this merged.
 */
export class SessionCheckpoint<P> {
  private entries = new Map<string, Entry<P>>();

  constructor(private readonly files: FileHandles<P>) {}

  async recordBeforeChange(path: P): Promise<void> {
    const key = this.files.key(path);
    if (this.entries.has(key)) return;
    const original = (await this.files.read(path)) ?? null; // null = new file
    this.entries.set(key, { path, original, reverted: false });
  }

  /** Capture each touched file's current content as the agent's final version. */
  async captureFinals(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.final = (await this.files.read(entry.path)) ?? null; // null = agent deleted it
    }
  }

  changedFiles(): ChangedFile[] {
    return [...this.entries.values()].map((e) => ({
      path: this.files.relative(e.path),
      reverted: e.reverted,
    }));
  }

  /** Find the checkpoint entry for a workspace-relative path. */
  entryFor(relPath: string): { path: P; original: Uint8Array | null } | undefined {
    return this.find(relPath);
  }

  private find(relPath: string): Entry<P> | undefined {
    for (const entry of this.entries.values()) {
      if (this.files.relative(entry.path) === relPath) return entry;
    }
    return undefined;
  }

  /** Restore a file to its pre-agent state, remembering the agent's version for Reapply. */
  async revertFile(relPath: string): Promise<boolean> {
    const entry = this.find(relPath);
    if (!entry) return false;
    if (entry.final === undefined) {
      entry.final = (await this.files.read(entry.path)) ?? null;
    }
    if (!(await this.writeOrDelete(entry.path, entry.original))) return false;
    entry.reverted = true;
    return true;
  }

  /** Write the agent's version back (after a Revert or a manual undo). */
  async reapplyFile(relPath: string): Promise<boolean> {
    const entry = this.find(relPath);
    if (!entry || entry.final === undefined) return false;
    if (!(await this.writeOrDelete(entry.path, entry.final))) return false;
    entry.reverted = false;
    return true;
  }

  /** Accept a file's changes and stop tracking it. */
  keepFile(relPath: string): void {
    const entry = this.find(relPath);
    if (entry) this.entries.delete(this.files.key(entry.path));
  }

  /** Accept every remaining tracked file at once (already-reverted ones stay revertible). */
  keepAll(): string[] {
    const kept: string[] = [];
    for (const [key, entry] of [...this.entries]) {
      if (entry.reverted) continue;
      kept.push(this.files.relative(entry.path));
      this.entries.delete(key);
    }
    return kept;
  }

  /** How many files are still tracked (i.e. neither kept nor untouched). */
  get size(): number {
    return this.entries.size;
  }

  /** Restore every tracked file to its pre-agent state. */
  async revertAll(): Promise<string[]> {
    const reverted: string[] = [];
    for (const entry of this.entries.values()) {
      const rel = this.files.relative(entry.path);
      if (await this.revertFile(rel)) reverted.push(rel);
    }
    return reverted;
  }

  /** Write bytes, or delete the file when bytes is null (it didn't/shouldn't exist). */
  private async writeOrDelete(path: P, bytes: Uint8Array | null): Promise<boolean> {
    try {
      if (bytes === null) await this.files.delete(path);
      else await this.files.write(path, bytes);
      return true;
    } catch {
      return false;
    }
  }
}
