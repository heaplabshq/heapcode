import { join } from 'node:path';
import { RagIndexer as RagIndex, RAG_INDEX_FILE, type SearchHit } from '@heapcode/core';
import { nodeFileSource, nodeTextStore } from '@heapcode/repomap/node';
import type { RoleResolver } from '../provider/roles.js';
import { loadIgnoreMatcher } from '../agent/ignoreFiles.js';

export type { IndexState } from '@heapcode/core';
export type { RagIndexer } from '@heapcode/core';

/**
 * The semantic index (@heapcode/core) wired for a terminal session: Node's
 * filesystem via the same `nodeFileSource` the repo map already uses, and
 * role resolution through RoleResolver.
 *
 * Everything here is adapter. The index itself — chunking, the embedding
 * cache, BM25/hybrid fusion, rerank — is the package's, shared verbatim with
 * the extension.
 *
 * No filesystem watcher (chokidar/fs.watch): the CLI has no persistent "open
 * editor" the way the extension does, so the only mutations that matter in
 * practice are the agent's own write_file/edit_file/rename_file/delete_file
 * tool calls — App.tsx calls indexOne/removeFile/renameFile directly right
 * after those succeed, which is both simpler and more precise than watching
 * (no debounce, no missed/duplicate events). A full buildIndex() re-scan (via
 * /index) is the catch-all for changes made outside the session — cheap,
 * since only changed file hashes re-embed.
 */
export function createRagIndexer(
  root: string,
  storageDir: string,
  roles: RoleResolver,
  onLog?: (line: string) => void,
): RagIndex {
  return new RagIndex({
    files: nodeFileSource(root, {
      exclude: ['**/node_modules/**', '**/.git/**', '**/.heapcode/**'],
      ignore: async () => {
        const matcher = await loadIgnoreMatcher(root);
        return matcher && ((rel: string) => matcher.ignores(rel));
      },
    }),
    store: nodeTextStore(join(storageDir, RAG_INDEX_FILE)),
    roles: (role) => roles.resolveRole(role),
    onLog,
  });
}

/**
 * Contextual retrieval has always been on in the CLI — there is no setting
 * for it here, unlike the extension where it ships off (§5.4 of
 * docs/phase3-rag-design.md keeps both defaults rather than unifying them).
 */
export const CLI_INDEX_OPTIONS = { contextualRetrieval: true } as const;

export type { SearchHit };
