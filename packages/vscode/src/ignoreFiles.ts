import * as vscode from 'vscode';
import ignore, { type Ignore } from 'ignore';

/**
 * Real .gitignore-awareness — the mechanism Claude Code, GitHub Copilot, and
 * Cursor all actually use to skip build/dependency output across every
 * language, rather than hardcoding each ecosystem's directory names (that
 * list never ends: venv, bin/obj, _build, .dart_tool, .gradle, …). Every
 * language community already teaches its users to gitignore that output, so
 * reading the project's own .gitignore gets all of them for free and
 * respects project-specific quirks a hardcoded list never could.
 *
 * .heapcodeignore layers on top for excludes that aren't (or shouldn't be)
 * gitignored — both files use the same gitignore pattern syntax, combined
 * into one matcher so there's a single place implementing it instead of one
 * per caller.
 */
export async function loadIgnoreMatcher(root: vscode.Uri): Promise<Ignore | undefined> {
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

/** Filters a findFiles()-style result against the workspace's .gitignore + .heapcodeignore. */
export async function filterIgnored(root: vscode.Uri, files: vscode.Uri[]): Promise<vscode.Uri[]> {
  const matcher = await loadIgnoreMatcher(root);
  if (!matcher) return files;
  return files.filter((f) => !matcher.ignores(toPosixRelative(f)));
}

/** The `ignore` package requires POSIX-style ("/") relative paths — asRelativePath can return native separators on Windows. */
function toPosixRelative(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

async function readIgnoreFile(root: vscode.Uri, name: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}
