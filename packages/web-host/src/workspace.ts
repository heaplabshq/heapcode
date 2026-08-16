import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadIgnoreMatcher } from '@heapcode/host';
import type { UiTreeEntry } from './protocol.js';

/** Files above this are summarized rather than shipped to the browser. */
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * Resolve a workspace-relative path to an absolute one, or throw.
 *
 * This is the jail for every workspace read the browser can trigger
 * (`ui/readFile`, `ui/diff`, `ui/fileTree`). The browser is untrusted by
 * design — and so is a model that can put a path in front of the user — so a
 * containment check has to happen here rather than being assumed from a
 * `join()`. Absolute paths and `..` are both rejected outright rather than
 * normalized into something that looks safe.
 */
export function resolveInRoot(root: string, relPath: string): string {
  if (relPath.includes('\0')) throw new Error('Invalid path');
  // An absolute path is never a workspace-relative path; accepting one would
  // make the jail depend entirely on where the string happened to point.
  if (isAbsolute(relPath)) throw new Error('Path must be relative to the workspace');
  const full = resolve(root, relPath);
  const rootResolved = resolve(root);
  const inside = full === rootResolved || full.startsWith(rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep);
  if (!inside) throw new Error('Path escapes the workspace');
  return full;
}

/** Directory listing, `.gitignore`-aware, directories first then alphabetical. */
export async function listDirectory(root: string, relPath: string): Promise<UiTreeEntry[]> {
  const dir = resolveInRoot(root, relPath || '.');
  const matcher = await loadIgnoreMatcher(root).catch(() => undefined);

  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: UiTreeEntry[] = [];

  for (const d of dirents) {
    // `.git` is noise in a code panel and enormous; the shadow-git dir lives
    // outside the workspace already (paths.ts), so this is the only one.
    if (d.name === '.git' || d.name === 'node_modules') continue;
    const childRel = relPath ? `${relPath}/${d.name}` : d.name;
    // `ignore` wants a trailing slash to match directory-only patterns
    // (`dist/`), and POSIX separators — which `childRel` already is.
    if (matcher?.ignores(d.isDirectory() ? `${childRel}/` : childRel)) continue;
    entries.push({ name: d.name, path: childRel, directory: d.isDirectory() });
  }

  entries.sort((a, b) =>
    a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1,
  );
  return entries;
}

/**
 * Read a workspace file as text.
 *
 * Returns a `note` instead of content for anything binary or oversized: the
 * browser renders text, and shipping a 40 MB blob (or a PNG rendered as
 * mojibake) helps nobody. Detection is a NUL-byte scan of the head, which is
 * what `file(1)` effectively does and is good enough here.
 */
export async function readWorkspaceFile(
  root: string,
  relPath: string,
): Promise<{ content: string; note?: string }> {
  const full = resolveInRoot(root, relPath);
  const info = await stat(full);
  if (!info.isFile()) return { content: '', note: 'Not a file.' };
  if (info.size > MAX_FILE_BYTES) {
    return { content: '', note: `File is ${Math.round(info.size / 1024)} KB — too large to display.` };
  }
  const buf = await readFile(full);
  if (buf.subarray(0, 8_000).includes(0)) return { content: '', note: 'Binary file.' };
  return { content: buf.toString('utf8') };
}

/** Current text of a file, or null when it no longer exists (the agent deleted it). */
export async function currentText(root: string, relPath: string): Promise<string | null> {
  try {
    const full = resolveInRoot(root, relPath);
    const buf = await readFile(full);
    if (buf.subarray(0, 8_000).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** Workspace-relative form of an absolute path, for display. */
export function toRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}

export function joinRoot(root: string, relPath: string): string {
  return join(root, relPath);
}
