import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalize } from '@heapcode/host';
import type { UiFolderEntry, UiRecentWorkspace } from './protocol.js';

/** Enough to get back to anything you are actually working on; not a history. */
const MAX_RECENT = 20;

/**
 * The folders this machine has opened in the web UI, most recent first.
 *
 * Cross-project state, so it lives beside config.json rather than under any
 * one project's state dir — the entire purpose of the list is to get you from
 * one project to another. Kept deliberately thin: a path and when it was last
 * opened. Anything richer (a title, a git remote) would be a second, staler
 * copy of something the folder itself already knows.
 */
export class WorkspaceStore {
  constructor(private readonly file: string) {}

  /**
   * Recent folders, newest first, with the ones that no longer exist dropped.
   *
   * Filtered on read rather than pruned on write: a folder on an unmounted
   * volume is missing today and back tomorrow, and quietly forgetting it the
   * first time you looked at the list while it was detached would be the
   * wrong answer to a temporary condition.
   */
  async list(): Promise<UiRecentWorkspace[]> {
    const entries = await this.load();
    const checked = await Promise.all(
      entries.map(async (e) => ((await isDirectory(e.path)) ? e : undefined)),
    );
    return checked.filter((e): e is UiRecentWorkspace => Boolean(e));
  }

  /** Upserts `root` at the top of the list. */
  async record(root: string): Promise<void> {
    const path = canonicalize(root);
    const rest = (await this.load()).filter((e) => e.path !== path);
    const next: UiRecentWorkspace[] = [
      { path, name: basename(path) || path, lastOpened: Date.now() },
      ...rest,
    ].slice(0, MAX_RECENT);
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch {
      // A recent-folders list is a convenience. Failing to write it must never
      // be the reason a workspace fails to open.
    }
  }

  private async load(): Promise<UiRecentWorkspace[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (e): e is UiRecentWorkspace =>
            typeof e === 'object' && e !== null && typeof (e as UiRecentWorkspace).path === 'string',
        )
        .map((e) => ({
          path: e.path,
          name: e.name || basename(e.path) || e.path,
          lastOpened: typeof e.lastOpened === 'number' ? e.lastOpened : 0,
        }))
        .sort((a, b) => b.lastOpened - a.lastOpened);
    } catch {
      return []; // absent or corrupt — an empty list is the honest answer
    }
  }
}

/**
 * Directory listing for the folder picker.
 *
 * This one deliberately does NOT go through `resolveInRoot` — the whole point
 * is to look outside the current workspace, so the jail that protects
 * `ui/readFile` would defeat it. What keeps that honest is the shape of what
 * it returns: directory *names* only, never a file's contents and never even
 * a file's name. Combined with the host's auth (a token-gated loopback socket
 * belonging to a session that already runs shell commands as this user), it
 * adds no capability the caller did not already have — it just makes picking
 * a folder possible without retyping an absolute path.
 */
export async function listFolders(
  path?: string,
): Promise<{ path: string; parent?: string; entries: UiFolderEntry[] }> {
  const dir = resolveStart(path);
  const dirents = await readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    throw new Error(err.code === 'EACCES' ? `No permission to read ${dir}` : `Cannot read ${dir}`);
  });

  const entries: UiFolderEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    // Dot-directories and node_modules are never what someone is picking, and
    // they bury the handful of entries that are.
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    entries.push({ name: d.name, path: join(dir, d.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(dir);
  return { path: dir, parent: parent === dir ? undefined : parent, entries };
}

/** `~`, a relative path, or nothing at all → an absolute directory to list. */
function resolveStart(path?: string): string {
  const raw = path?.trim();
  if (!raw) return homedir();
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(homedir(), raw);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
