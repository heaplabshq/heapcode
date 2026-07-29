import {
  CODE_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_INDEXED_FILES,
  type FileSource,
} from '@heapcode/repomap';
import type { ModelRole, ProviderProfileConfig } from '../config/profiles.js';
import type { Provider } from '../providers/types.js';
import { chunkFile, fnv1a, type Chunk } from './chunker.js';
import { contextualizeChunks } from './contextualize.js';
import { RERANK_CANDIDATES, rerankHits } from './rerank.js';
import { VectorStore, type SearchHit, type VectorRecord } from './store.js';

/** Conventional filename for a persisted index — hosts pick where it lives, see RagStore. */
export const RAG_INDEX_FILE = 'rag-index.json';

/** How many chunks go into one embeddings request. */
const EMBED_BATCH = 16;

export type IndexState = 'no-embedder' | 'idle' | 'indexing' | 'error';

/**
 * Where the serialized index lives. Reading an index that isn't there yet is
 * a normal cold start, not an error — return undefined. Structurally the same
 * two methods `RepoMapStore` has, and `nodeTextStore` satisfies both.
 */
export interface RagStore {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

export interface ResolvedRole {
  provider: Provider;
  profile: ProviderProfileConfig;
}

/**
 * Which provider/profile serves a role, following any `<role>Profile`
 * redirect. Injected because the three implementations differ in where they
 * read configuration from, not in what they answer: RoleResolver for the CLI,
 * ProfileManager for the extension, Session.providerForRole in the server.
 *
 * Returning undefined means "nothing configured for this role" — the indexer
 * degrades rather than throwing, since a missing rerank or context model is
 * an ordinary state, not a failure.
 */
export type RagRoleResolver = (role: ModelRole) => Promise<ResolvedRole | undefined>;

export interface RagIndexerOptions {
  files: FileSource;
  store: RagStore;
  roles: RagRoleResolver;
  /**
   * Whether `ready` requires an embeddings model to be configured, not just a
   * non-empty index. The two hosts disagreed here and this preserves both:
   * the extension gated on it, the CLI did not. It matters because `ready`
   * also gates `keywordSearch`, which needs no model at all.
   */
  requireEmbedderForReady?: boolean;
  onLog?: (line: string) => void;
}

export interface IndexOptions {
  /**
   * Generate an LLM blurb per changed chunk before embedding it. Host policy,
   * not a server default (docs/phase3-rag-design.md §5.4): the extension ships
   * it off, the CLI runs it always. Defaults to off, the shipped default of
   * the host that has a setting for it.
   */
  contextualRetrieval?: boolean;
}

export interface BuildIndexOptions extends IndexOptions {
  onProgress?: (embedded: number, total: number) => void;
}

export interface QueryOptions {
  /** Fuse the vector ranking with BM25 before reranking. Defaults to on — both hosts' effective default. */
  hybridSearch?: boolean;
  /** Let an LLM re-order the over-fetched candidates. Defaults to on. */
  rerank?: boolean;
}

export interface IndexResult {
  files: number;
  chunks: number;
  /** Files that actually needed re-embedding this run. */
  embedded: number;
}

/**
 * Persisted, incrementally-updated semantic index of a codebase: AST-aware
 * chunks, their embeddings, and hybrid vector+BM25 retrieval over them.
 *
 * All host coupling is in three seams, the same shape `RepoMapIndexer`
 * already uses: a `FileSource` for enumeration and reads, a `RagStore` for
 * persistence, and a `RagRoleResolver` for "which provider serves embeddings".
 * Everything host-specific about *which* files are candidates — ignore rules,
 * walk limits, workspace layout — lives behind `FileSource.list()`, which is
 * why there is no ignore-matcher parameter here.
 *
 * There is no filesystem watcher: hosts call indexOne/removeFile/renameFile
 * when they know something changed (an editor save, an agent's write tool
 * succeeding), which is cheaper and more precise than watching — no debounce,
 * no missed or duplicated events.
 */
export class RagIndexer {
  private store = new VectorStore();
  private state: IndexState = 'idle';
  private indexing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  /**
   * Last-seen embeddings model, refreshed on every role resolution. Cached
   * because `ready` is a synchronous getter on hot paths (the agent's
   * semantic_search gate, ghost text's keyword retrieval) while role
   * resolution is async in all three implementations.
   */
  private embedder: string | undefined;

  constructor(private readonly opts: RagIndexerOptions) {}

  /** Loads any persisted index and the current embeddings model. Safe to call once at startup. */
  async init(): Promise<void> {
    await this.load();
    await this.refreshEmbedder();
  }

  async status(): Promise<{ state: IndexState; files: number; chunks: number }> {
    return {
      state: (await this.refreshEmbedder()) ? this.state : 'no-embedder',
      files: this.store.fileCount,
      chunks: this.store.chunkCount,
    };
  }

  get ready(): boolean {
    if (this.store.chunkCount === 0) return false;
    return !this.opts.requireEmbedderForReady || this.embedder !== undefined;
  }

  get fileCount(): number {
    return this.store.fileCount;
  }

  get chunkCount(): number {
    return this.store.chunkCount;
  }

  /** Serialized index, for a caller that wants to hand it somewhere else. */
  serialize(): string {
    return this.store.serialize();
  }

  private async refreshEmbedder(): Promise<string | undefined> {
    const resolved = await this.opts.roles('embeddingsModel');
    this.embedder = resolved?.profile.embeddingsModel || undefined;
    return this.embedder;
  }

  private async load(): Promise<void> {
    try {
      const text = await this.opts.store.read();
      if (text === undefined) return;
      this.store = VectorStore.deserialize(text);
    } catch {
      // no index yet, or an unreadable one — a cold rebuild is the recovery
    }
  }

  private persistSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 3_000);
  }

  private async persist(): Promise<void> {
    clearTimeout(this.saveTimer);
    await this.opts.store.write(this.store.serialize());
  }

  async clear(): Promise<void> {
    this.store.clear();
    await this.persist();
  }

  /**
   * Full (re)index: only changed files are re-embedded, so a rebuild after a
   * few edits costs a few embedding calls rather than the whole repo.
   *
   * Returns undefined when no embeddings model is configured — the caller
   * decides how loudly to say so, since one host logs and the other shows a
   * warning.
   */
  async buildIndex(opts: BuildIndexOptions = {}): Promise<IndexResult | undefined> {
    if (this.indexing) return undefined;
    if (!(await this.refreshEmbedder())) return undefined;

    this.indexing = true;
    this.state = 'indexing';
    const started = Date.now();
    try {
      const found = await this.opts.files.list();
      const files = found.filter((f) => CODE_EXTENSIONS.test(f)).slice(0, MAX_INDEXED_FILES);

      const existing = new Set<string>();
      let embedded = 0;
      for (const rel of files) {
        existing.add(rel);
        if (await this.indexOne(rel, opts)) embedded++;
        opts.onProgress?.(embedded, files.length);
      }
      this.store.retainFiles(existing);
      await this.persist();
      this.state = 'idle';
      this.opts.onLog?.(
        `indexed ${this.store.fileCount} files / ${this.store.chunkCount} chunks ` +
          `(${embedded} re-embedded) in ${Math.round((Date.now() - started) / 1000)}s`,
      );
      return { files: this.store.fileCount, chunks: this.store.chunkCount, embedded };
    } catch (err) {
      this.state = 'error';
      this.opts.onLog?.(`index failed: ${err instanceof Error ? err.message : String(err)}`);
      return { files: this.store.fileCount, chunks: this.store.chunkCount, embedded: 0 };
    } finally {
      this.indexing = false;
    }
  }

  /** Index (or re-index) one file by workspace-relative path; true when it needed re-embedding. */
  async indexOne(rel: string, opts: IndexOptions = {}): Promise<boolean> {
    if (!CODE_EXTENSIONS.test(rel)) return false;
    let content: string;
    try {
      const bytes = await this.opts.files.read(rel);
      if (bytes.byteLength > MAX_FILE_BYTES) return false;
      content = new TextDecoder().decode(bytes);
      if (content.includes('\0')) return false; // binary
    } catch {
      this.store.removeFile(rel);
      this.persistSoon();
      return false;
    }

    const fileHash = fnv1a(content);
    if (this.store.fileHash(rel) === fileHash) return false;

    const embeddings = await this.opts.roles('embeddingsModel');
    this.embedder = embeddings?.profile.embeddingsModel || undefined;
    const model = this.embedder;
    if (!embeddings || !model) return false;

    const chunks = await chunkFile(rel, content);
    if (chunks.length === 0) {
      this.store.removeFile(rel);
      this.persistSoon();
      return false;
    }

    // Embedding cache: reuse vectors for chunks whose hash didn't change.
    const cached = this.store.vectorsByHash(rel);
    const records: VectorRecord[] = [];
    const toEmbed: Chunk[] = [];
    for (const chunk of chunks) {
      const vector = cached.get(chunk.hash);
      if (vector) records.push({ ...chunk, vector });
      else toEmbed.push(chunk);
    }

    // Contextual retrieval: a short blurb per chunk, prepended before
    // embedding — only for chunks that need (re-)embedding anyway, so cost
    // scales with what changed rather than the whole repo every run.
    const contexts = opts.contextualRetrieval ? await this.contextsFor(rel, content, toEmbed) : [];

    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH);
      const res = await embeddings.provider.embeddings({
        model,
        input: batch.map((c, j) => {
          const context = contexts[i + j];
          return context ? `${context}\n${c.path}\n${c.text}` : `${c.path}\n${c.text}`;
        }),
      });
      batch.forEach((chunk, j) => {
        const vector = res.embeddings[j];
        if (vector && vector.length > 0) {
          const context = contexts[i + j] || undefined;
          records.push({ ...chunk, vector: Float32Array.from(vector), context });
        }
      });
    }

    this.store.upsertFile(rel, fileHash, records);
    this.persistSoon();
    return toEmbed.length > 0;
  }

  /** Best-effort — contextual retrieval is a quality boost, never a reason to fail indexing. */
  private async contextsFor(rel: string, content: string, toEmbed: Chunk[]): Promise<string[]> {
    if (toEmbed.length === 0) return [];
    try {
      const ctx = await this.opts.roles('contextModel');
      if (!ctx) return [];
      const model = ctx.profile.contextModel || ctx.profile.rerankModel || ctx.profile.editModel || ctx.profile.model;
      if (!model) return [];
      return await contextualizeChunks(ctx.provider, model, rel, content, toEmbed);
    } catch {
      return [];
    }
  }

  removeFile(rel: string): void {
    this.store.removeFile(rel);
    this.persistSoon();
  }

  async renameFile(oldRel: string, newRel: string, opts: IndexOptions = {}): Promise<void> {
    this.store.removeFile(oldRel);
    await this.indexOne(newRel, opts);
  }

  /**
   * BM25-only keyword retrieval — no embedding call, no LLM call, pure
   * in-memory computation. Cheap enough to run inside a typing debounce
   * window, which is the property ghost text depends on.
   */
  keywordSearch(text: string, k = 6): SearchHit[] {
    if (!this.ready) return [];
    return this.store.keywordSearch(text, k);
  }

  /** Semantic retrieval; empty when there's no embedder or no index. */
  async query(text: string, k = 6, opts: QueryOptions = {}): Promise<SearchHit[]> {
    if (this.store.chunkCount === 0) return [];
    const embeddings = await this.opts.roles('embeddingsModel');
    this.embedder = embeddings?.profile.embeddingsModel || undefined;
    const model = this.embedder;
    if (!embeddings || !model) return [];

    const res = await embeddings.provider.embeddings({ model, input: [text] });
    const vector = res.embeddings[0];
    if (!vector || vector.length === 0) return [];

    // Hybrid search: fuse the embedding ranking with a BM25 keyword ranking
    // (reciprocal rank fusion) so exact-identifier queries aren't lost to
    // pure semantic search. Free — no extra model calls.
    const hybrid = opts.hybridSearch ?? true;
    const doSearch = (n: number): SearchHit[] =>
      hybrid ? this.store.hybridSearch(vector, text, n) : this.store.search(vector, n);

    // Rerank: over-fetch, let an LLM pick the hits that actually answer the
    // query. Its own role, so it can run on a different profile than the
    // embeddings did. Falls back to vector/hybrid order on any failure.
    if (opts.rerank === false) return doSearch(k);
    const rerankRole = await this.opts.roles('rerankModel');
    const rerankModel =
      rerankRole && (rerankRole.profile.rerankModel || rerankRole.profile.editModel || rerankRole.profile.model);
    if (!rerankRole || !rerankModel) return doSearch(k);

    const candidates = doSearch(Math.max(RERANK_CANDIDATES, k));
    if (candidates.length <= k) return candidates;
    const started = Date.now();
    try {
      const ranked = await rerankHits(rerankRole.provider, rerankModel, text, candidates, k);
      this.opts.onLog?.(`reranked ${candidates.length} → ${ranked.length} hits in ${Date.now() - started}ms`);
      return ranked;
    } catch {
      return candidates.slice(0, k);
    }
  }

  /** Formatted retrieval block for prompts / the semantic_search tool. */
  async queryFormatted(text: string, k = 6, opts: QueryOptions = {}): Promise<string> {
    return formatHits(await this.query(text, k, opts));
  }
}

/**
 * The exact block shape every consumer of RAG actually wants — the agent's
 * semantic_search tool, the @workspace preamble, chat @mentions and inline
 * edit's related-code section all render this and nothing else. Exported so
 * the server can produce it without a second copy.
 */
export function formatHits(hits: SearchHit[]): string {
  return hits
    .map(
      (h) =>
        `--- ${h.record.path}:${h.record.startLine}-${h.record.endLine} (score ${h.score.toFixed(2)}) ---\n${h.record.text}`,
    )
    .join('\n\n');
}
