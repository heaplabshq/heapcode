import { parserForPath } from '@heapcode/core';
import { RepoMapIndexer } from '@heapcode/repomap';
import { nodeFileSource, nodeRepoMapStore } from '@heapcode/repomap/node';
import { loadIgnoreMatcher } from '../agent/ignoreFiles.js';

export type { RepoMapIndexer } from '@heapcode/repomap';

/**
 * The repo map, wired for a terminal session: Node's filesystem, core's
 * tree-sitter parser, and the workspace's own .gitignore/.heapcodeignore.
 *
 * The extension's "recently edited" ranking boost came from
 * onDidSaveTextDocument; the CLI has no editor, so noteRecent() is driven by
 * the agent's own successful writes instead — the closest available signal
 * for "what matters right now" in a terminal session. The extension's "open
 * editor tabs" boost has no CLI equivalent and is simply omitted (no
 * openFiles source is passed).
 */
export function createRepoMapIndexer(root: string, storageDir: string, onLog?: (line: string) => void): RepoMapIndexer {
  return new RepoMapIndexer({
    files: nodeFileSource(root, {
      exclude: ['**/node_modules/**', '**/.git/**', '**/.heapcode/**'],
      ignore: async () => {
        const matcher = await loadIgnoreMatcher(root);
        return matcher && ((rel: string) => matcher.ignores(rel));
      },
    }),
    store: nodeRepoMapStore(storageDir),
    parserFor: parserForPath,
    onLog,
  });
}
