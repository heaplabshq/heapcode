import { statSync } from 'node:fs';
import { join } from 'node:path';
import { nodeFileSource, nodeTextStore } from '@heapcode/repomap/node';
import { DEFAULT_IGNORE_DIRS } from '../config/ignore.js';
import { formatHits, RagIndexer, RAG_INDEX_FILE, type IndexState } from '../rag/indexer.js';
import { toHitMeta } from '../rag/keywordIndex.js';
import { loadIgnoreMatcher } from '../rag/ignoreFiles.js';
import { projectStateDir } from './address.js';
import type { Session } from './session.js';
import type {
  RagEvent,
  RagIndexParams,
  RagIndexResult,
  RagQueryParams,
  RagQueryResult,
  RagStatusResult,
} from './protocol.js';

/** What the RAG methods need from the host connection. */
export interface RagHost {
  emit(event: RagEvent, runId?: string): void;
  /** Resolve a profile the session doesn't already hold a key for (`key/request`). */
  requestKey(profileName: string): Promise<void>;
  /**
   * The daemon log.
   *
   * Indexing runs in the background and its failures never reach a reply, so
   * without this they went nowhere at all: the indexer wrote them to an
   * `onLog` this service did not pass, and the UI got the bare state 'error'.
   */
  log(line: string): void;
}

/**
 * One workspace's semantic index, server-side.
 *
 * Held per session rather than process-globally, because the indexer resolves
 * providers through this session's key map and a shared instance would be a
 * hole straight through §2's isolation invariant. Two windows on one
 * workspace therefore each hold an index — but they share the same file under
 * the project state dir, so the second one loads what the first wrote. That
 * is the same concurrent-writer situation both hosts already had before this
 * moved; making the *store* shareable while keeping providers per-session is
 * the refinement protocol §2 sketched and is deliberately not attempted here.
 *
 * The server reads the workspace directly (design note §3.2 option (a)):
 * pulling 3,000 files back over tool/execute to index them would be a lot of
 * round-trips for a background job, and §6's colocation rule already puts the
 * server on the same machine as the workspace. `available` is the guard for
 * the one case where that does not hold — a root the server cannot read.
 */
export class SessionRag {
  private indexer?: RagIndexer;
  private loading?: Promise<RagIndexer | undefined>;

  constructor(
    private readonly session: Session,
    private readonly host: RagHost,
  ) {}

  /** False when the server cannot read this workspace for itself. */
  get available(): boolean {
    if (this.session.localRoot === false) return false;
    try {
      return statSync(this.session.root).isDirectory();
    } catch {
      return false;
    }
  }

  private async index(): Promise<RagIndexer | undefined> {
    if (this.indexer) return this.indexer;
    if (!this.available) return undefined;
    // Concurrent first calls must not each build (and each load) an indexer.
    this.loading ??= this.create();
    return this.loading;
  }

  private async create(): Promise<RagIndexer | undefined> {
    const root = this.session.root;
    const indexer = new RagIndexer({
      files: nodeFileSource(root, {
        // The same walk exclusions the repo map uses, from core's one list
        // rather than either host's private copy (decision 4: reuse whatever
        // repomap settled on rather than picking a third answer).
        exclude: DEFAULT_IGNORE_DIRS.map((dir) => `**/${dir}/**`),
        ignore: async () => {
          const matcher = await loadIgnoreMatcher(root);
          return matcher && ((rel: string) => matcher.ignores(rel));
        },
      }),
      // Decision 5: one location keyed by workspace root, the CLI's existing
      // convention. Extension indexes that lived in VS Code workspace storage
      // are not migrated — a clean rebuild is simpler and `fresh` says so.
      store: nodeTextStore(join(projectStateDir(root), RAG_INDEX_FILE)),
      roles: (role) => this.session.providerForRole(role, (name) => this.host.requestKey(name)),
      onLog: (line) => this.host.log(`[rag] ${line}`),
    });
    await indexer.init();
    this.indexer = indexer;
    return indexer;
  }

  async status(): Promise<RagStatusResult> {
    const indexer = await this.index();
    if (!indexer) return { state: 'no-embedder', files: 0, chunks: 0, available: false };
    return { ...(await indexer.status()), available: true };
  }

  async query(params: RagQueryParams): Promise<RagQueryResult> {
    const indexer = await this.index();
    if (!indexer) return { formatted: '', hits: [] };
    const hits = await indexer.query(params.text, params.k ?? 6, {
      hybridSearch: params.hybridSearch,
      rerank: params.rerank,
    });
    return { formatted: formatHits(hits), hits: hits.map(toHitMeta) };
  }

  /**
   * A full rebuild or an incremental update. `paths` covers deletes and
   * renames too: indexOne drops a path it cannot read, so no separate remove
   * method is needed.
   */
  async runIndex(params: RagIndexParams, signal?: AbortSignal): Promise<RagIndexResult> {
    const indexer = await this.index();
    if (!indexer) return { files: 0, chunks: 0, embedded: 0 };
    const opts = { contextualRetrieval: params.contextualRetrieval, signal };

    if (params.clear) {
      await indexer.clear();
      const status = await indexer.status();
      this.host.emit({ kind: 'state', ...status }, params.runId);
      return { files: status.files, chunks: status.chunks, embedded: 0 };
    }

    if (params.full) {
      const fresh = indexer.chunkCount === 0;
      this.emitState(indexer, 'indexing', params.runId);
      const result = await indexer.buildIndex({
        ...opts,
        onProgress: (embedded, total) => this.host.emit({ kind: 'progress', embedded, total }, params.runId),
      });
      const status = await indexer.status();
      this.host.emit({ kind: 'state', ...status }, params.runId);
      return { ...(result ?? { files: status.files, chunks: status.chunks, embedded: 0 }), fresh };
    }

    let embedded = 0;
    for (const path of params.paths ?? []) {
      if (signal?.aborted) break;
      if (await indexer.indexOne(path, opts)) embedded++;
    }
    const status = await indexer.status();
    this.host.emit({ kind: 'state', ...status }, params.runId);
    return { files: status.files, chunks: status.chunks, embedded };
  }

  /**
   * The formatted block for the `semantic_search` tool, or undefined when
   * there is nothing to say — the caller then hands the call back to the
   * host, whose executor degrades to a word-based text search exactly as it
   * did when it owned this path.
   */
  async searchForTool(query: string): Promise<string | undefined> {
    if (!query.trim()) return undefined;
    const { formatted } = await this.query({ text: query });
    return formatted || undefined;
  }

  private emitState(indexer: RagIndexer, state: IndexState, runId?: string): void {
    this.host.emit({ kind: 'state', state, files: indexer.fileCount, chunks: indexer.chunkCount }, runId);
  }
}
