import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * Node-native port of packages/vscode/src/ignoreFiles.ts — same real
 * .gitignore-awareness (the `ignore` npm package, real gitignore syntax) via
 * fs/promises instead of vscode.workspace.fs. .heapcodeignore layers on top,
 * same pattern syntax, combined into one matcher.
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
