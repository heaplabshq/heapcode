import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import { REPO_MAP_FILE, type FileSource, type RepoMapStore } from './indexer.js';

export interface NodeFileSourceOptions {
  /** Glob patterns skipped during the walk itself — cheaper than filtering after the fact. Defaults to nothing: which directories are noise is the host's call. */
  exclude?: string[];
  /**
   * Ignore predicate over workspace-relative paths, re-resolved on every
   * list() so edits to a `.gitignore`-style file between builds take effect
   * without restarting. Undefined means "ignore nothing this time".
   */
  ignore?: () => Promise<((rel: string) => boolean) | undefined>;
}

/** FileSource over a real directory: fast-glob to enumerate, fs.readFile to read. */
export function nodeFileSource(root: string, opts: NodeFileSourceOptions = {}): FileSource {
  return {
    async list() {
      const found = await fg(['**/*'], {
        cwd: root,
        dot: false,
        onlyFiles: true,
        ignore: opts.exclude ?? [],
        suppressErrors: true,
      });
      const ignored = await opts.ignore?.();
      return ignored ? found.filter((f) => !ignored(f)) : found;
    },
    read(rel) {
      return readFile(join(root, rel));
    },
  };
}

/** RepoMapStore backed by `<storageDir>/repo-map.json`, creating the directory on first write. */
export function nodeRepoMapStore(storageDir: string): RepoMapStore {
  const file = join(storageDir, REPO_MAP_FILE);
  return {
    async read() {
      try {
        return await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    async write(text) {
      await mkdir(storageDir, { recursive: true });
      await writeFile(file, text, 'utf8');
    },
  };
}
