import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { DirectoryEntry, FileHandles, FileTree, TextFileStore } from '../fs.js';

/**
 * Node implementations of the seams in `../fs.ts`, for hosts that do have a
 * real filesystem. The extension supplies its own `vscode.workspace.fs`-based
 * versions instead.
 */

/** A single text file at `path`; parent directories are created on write. */
export function nodeTextFile(path: string): TextFileStore {
  return {
    read: async () => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    write: async (text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
  };
}

/** A directory tree rooted at `root`, addressed by '/'-separated relative paths. */
export function nodeFileTree(root: string): FileTree {
  const abs = (rel: string): string => join(root, ...rel.split('/'));
  return {
    readFile: async (rel) => {
      try {
        return await readFile(abs(rel), 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: async (rel, text) => {
      const path = abs(rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
    readDirectory: async (rel) => {
      try {
        const entries = await readdir(abs(rel), { withFileTypes: true });
        return entries.map((e): DirectoryEntry => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch {
        return [];
      }
    },
  };
}

/** Byte access to arbitrary absolute paths, reported relative to `root`. */
export function nodeFileHandles(root: string): FileHandles<string> {
  return {
    read: async (path) => {
      try {
        return await readFile(path);
      } catch {
        return undefined;
      }
    },
    write: (path, bytes) => writeFile(path, bytes),
    delete: async (path) => {
      try {
        await unlink(path);
      } catch {
        // already gone — the desired state
      }
    },
    key: (path) => path,
    relative: (path) => relative(root, path).replace(/\\/g, '/'),
  };
}
