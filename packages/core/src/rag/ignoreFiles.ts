import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * Real .gitignore-awareness — the mechanism Claude Code, GitHub Copilot and
 * Cursor all actually use to skip build/dependency output across every
 * language, rather than hardcoding each ecosystem's directory names (that
 * list never ends: venv, bin/obj, _build, .dart_tool, .gradle, …). Every
 * language community already teaches its users to gitignore that output, so
 * reading the project's own .gitignore gets all of them for free and respects
 * project-specific quirks a hardcoded list never could.
 *
 * `.heapcodeignore` layers on top for excludes that aren't (or shouldn't be)
 * gitignored — both files use the same gitignore pattern syntax, combined
 * into one matcher.
 *
 * This lives in core because the server indexes the workspace for itself now
 * (docs/phase3-rag-design.md §3.2, decision 3) and needed the same rules the
 * hosts apply. It is not a third answer: the CLI's node implementation and
 * the extension's `vscode.workspace.fs` one were already the same algorithm
 * over the same two files, differing only in which filesystem API they
 * called, so this is that algorithm with the node one's reads.
 */
export async function loadIgnoreMatcher(root: string): Promise<Ignore | undefined> {
  const [gitignore, heapcodeignore] = await Promise.all([
    readIgnoreFile(root, '.gitignore'),
    readIgnoreFile(root, '.heapcodeignore'),
  ]);
  if (!gitignore && !heapcodeignore) return undefined;
  const matcher = ignore();
  if (gitignore) matcher.add(gitignore);
  if (heapcodeignore) matcher.add(heapcodeignore);
  return matcher;
}

/** Filters absolute file paths against the workspace's .gitignore + .heapcodeignore. */
export async function filterIgnored(root: string, files: string[]): Promise<string[]> {
  const matcher = await loadIgnoreMatcher(root);
  if (!matcher) return files;
  return files.filter((f) => !matcher.ignores(toPosixRelative(root, f)));
}

/** The `ignore` package requires POSIX-style ("/") relative paths. */
function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).replace(/\\/g, '/');
}

async function readIgnoreFile(root: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, name), 'utf8');
  } catch {
    return undefined;
  }
}
