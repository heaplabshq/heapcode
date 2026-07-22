import type * as vscode from 'vscode';

const STORAGE_KEY = 'heapcode.retention.watches';
/** How many subsequent saves an accepted suggestion must survive to count as "retained". */
const RETAIN_AFTER_SAVES = 3;
/** Ring-buffer cap — guards against unbounded growth if saves never come for old entries. */
const MAX_WATCHES = 200;
/** Only the first N chars of accepted text are kept, purely as a presence fingerprint. */
const MAX_WATCH_TEXT_CHARS = 500;
/** Watches older than this are dropped silently on the next save sweep — no verdict, just hygiene. */
const MAX_WATCH_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface Watch {
  kind: 'completion' | 'edit';
  uri: string;
  text: string;
  savesSeen: number;
  createdAt: number;
}

/**
 * Accept-rate alone doesn't say whether a suggestion was actually kept or
 * immediately undone/rewritten. This tracks accepted completions/edits in
 * workspaceState and checks, on subsequent saves of the same file, whether
 * the accepted text is still present — firing `<kind>.retained` once it
 * survives a few saves, or `<kind>.reverted` the moment it disappears.
 */
export class RetentionTracker {
  private watches: Watch[];

  constructor(
    private readonly state: vscode.Memento,
    private readonly track?: (name: string, meta?: Record<string, unknown>) => void,
  ) {
    this.watches = this.state.get<Watch[]>(STORAGE_KEY, []);
  }

  /** Register an accepted completion/edit to watch. Call right after it's actually applied to the document. */
  watch(kind: 'completion' | 'edit', uri: vscode.Uri, acceptedText: string): void {
    const text = acceptedText.trim().slice(0, MAX_WATCH_TEXT_CHARS);
    if (!text) return;
    this.watches.push({ kind, uri: uri.toString(), text, savesSeen: 0, createdAt: Date.now() });
    if (this.watches.length > MAX_WATCHES) this.watches.splice(0, this.watches.length - MAX_WATCHES);
    void this.persist();
  }

  /** Call from a workspace-wide onDidSaveTextDocument listener. */
  checkOnSave(document: vscode.TextDocument): void {
    if (this.watches.length === 0) return;
    const uri = document.uri.toString();
    const now = Date.now();
    const content = document.getText();
    const remaining: Watch[] = [];
    for (const w of this.watches) {
      if (now - w.createdAt > MAX_WATCH_AGE_MS) continue; // stale — no verdict, just drop
      if (w.uri !== uri) {
        remaining.push(w);
        continue;
      }
      if (!content.includes(w.text)) {
        this.track?.(`${w.kind}.reverted`, { savesSeen: w.savesSeen });
        continue;
      }
      const savesSeen = w.savesSeen + 1;
      if (savesSeen >= RETAIN_AFTER_SAVES) {
        this.track?.(`${w.kind}.retained`, { savesSeen });
        continue;
      }
      remaining.push({ ...w, savesSeen });
    }
    this.watches = remaining;
    void this.persist();
  }

  private async persist(): Promise<void> {
    await this.state.update(STORAGE_KEY, this.watches);
  }
}
