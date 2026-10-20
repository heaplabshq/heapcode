import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Earlier versions of each note, outside the vault (beside its index under
 * ~/.heapcode), so the notes folder stays just notes.
 *
 * Kept the way Obsidian's file recovery keeps them: the text as it was
 * before a write, at most one per note every few minutes while someone types
 * — and always before a change made by anything but the person (Ask, an AI
 * app over MCP, the terminal), and before a restore. Same text twice is
 * kept once; the oldest go past a limit.
 */
export const VERSION_INTERVAL_MS = 5 * 60_000;
export const VERSIONS_KEPT = 100;

export interface NoteVersion {
  /** Opaque: pass it back to read or restore. */
  version: string;
  /** When this text was replaced. */
  at: string;
  /** What replaced it, when that wasn't the person in the app: `ask`, `mcp`, `restore`… */
  by?: string;
  size: number;
}

const NAME = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z)(?:~([a-z]+))?\.md$/;

export class NoteHistory {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private noteDir(id: string): string {
    return join(this.dir, id.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  /** Keep `text` as a version of note `id`, unless a recent one makes it redundant. */
  async keep(id: string, text: string, opts: { by?: string; force?: boolean } = {}): Promise<void> {
    // Nothing worth going back to: a note that was only a title line.
    if (
      text
        .replace(/^---\n[\s\S]*?\n---\n/, '')
        .replace(/^#\s*$/m, '')
        .trim() === ''
    )
      return;
    const dir = this.noteDir(id);
    const names = await this.names(dir);
    const latest = names[names.length - 1];
    if (latest) {
      const last = await readFile(join(dir, latest), 'utf8').catch(() => undefined);
      if (last === text) return;
      const at = Date.parse(stampToIso(NAME.exec(latest)![1]!));
      if (!opts.force && this.now().getTime() - at < VERSION_INTERVAL_MS) return;
    }
    await mkdir(dir, { recursive: true });
    const stamp = this.now().toISOString().replace(/:/g, '-');
    const by = opts.by && /^[a-z]+$/.test(opts.by) ? `~${opts.by}` : '';
    await writeFile(join(dir, `${stamp}${by}.md`), text);
    for (const old of names.slice(0, Math.max(0, names.length + 1 - VERSIONS_KEPT)))
      await unlink(join(dir, old)).catch(() => undefined);
  }

  /** Newest first. */
  async list(id: string): Promise<NoteVersion[]> {
    const dir = this.noteDir(id);
    const out: NoteVersion[] = [];
    for (const name of (await this.names(dir)).reverse()) {
      const m = NAME.exec(name)!;
      const size = (await readFile(join(dir, name)).catch(() => Buffer.alloc(0))).byteLength;
      out.push({ version: name, at: stampToIso(m[1]!), ...(m[2] ? { by: m[2] } : {}), size });
    }
    return out;
  }

  /** The whole file as it was, front matter included; undefined for an unknown version. */
  async read(id: string, version: string): Promise<string | undefined> {
    if (!NAME.test(version)) return undefined;
    return readFile(join(this.noteDir(id), version), 'utf8').catch(() => undefined);
  }

  private async names(dir: string): Promise<string[]> {
    const all = await readdir(dir).catch(() => [] as string[]);
    return all.filter((n) => NAME.test(n)).sort();
  }
}

/** `2026-10-19T10-00-00.000Z` → `2026-10-19T10:00:00.000Z`. */
function stampToIso(stamp: string): string {
  return stamp.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
}
