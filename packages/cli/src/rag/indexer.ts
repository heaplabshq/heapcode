import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import {
  chunkFile,
  contextualizeChunks,
  fnv1a,
  RERANK_CANDIDATES,
  rerankHits,
  VectorStore,
  type SearchHit,
  type VectorRecord,
} from '@heapcode/core';
import type { RoleResolver } from '../provider/roles.js';
import { loadIgnoreMatcher } from '../agent/ignoreFiles.js';

const INDEX_FILE = 'rag-index.json';
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|scala|sh|sql|vue|svelte|md|yaml|yml|json|toml|html|htm|css|scss|sass|less|xml|astro|graphql|gql|proto|prisma|lua|dart|ex|exs|zig|tf|ini|conf)$/i;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 3_000;
const EMBED_BATCH = 16;

export type IndexState = 'no-embedder' | 'idle' | 'indexing' | 'error';

/**
 * Node-native port of packages/vscode/src/rag/indexer.ts: fs/promises +
 * fast-glob instead of vscode.workspace.fs/findFiles, role resolution via
 * RoleResolver instead of ProfileManager. The indexing algorithm itself
 * (chunkFile, VectorStore, BM25/hybrid fusion, rerank) is unchanged core
 * logic.
 *
 * No filesystem watcher (chokidar/fs.watch): the CLI has no persistent
 * "open editor" the way the extension does, so the only mutations that
 * matter in practice are the agent's own write_file/edit_file/rename_file/
 * delete_file tool calls — cli.tsx calls indexOne/removeFile/renameFile
 * directly right after those succeed, which is both simpler and more
 * precise than watching (no debounce, no missed/duplicate events). A full
 * buildIndex() re-scan (via /index) is the catch-all for changes made
 * outside the session — cheap, since only changed file hashes re-embed.
 */
export class RagIndexer {
  private store = new VectorStore();
  private state: IndexState = 'idle';
  private indexing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly root: string,
    private readonly storageDir: string,
    private readonly roles: RoleResolver,
    private readonly onLog?: (line: string) => void,
  ) {}

  async init(): Promise<void> {
    await this.load();
  }

  async status(): Promise<{ state: IndexState; files: number; chunks: number }> {
    const { profile } = await this.roles.resolveRole('embeddingsModel');
    return {
      state: profile.embeddingsModel ? this.state : 'no-embedder',
      files: this.store.fileCount,
      chunks: this.store.chunkCount,
    };
  }

  get ready(): boolean {
    return this.store.chunkCount > 0;
  }

  private get indexPath(): string {
    return join(this.storageDir, INDEX_FILE);
  }

  private async load(): Promise<void> {
    try {
      this.store = VectorStore.deserialize(await readFile(this.indexPath, 'utf8'));
    } catch {
      // no index yet
    }
  }

  private persistSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 3_000);
  }

  private async persist(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.indexPath, this.store.serialize(), 'utf8');
  }

  async clear(): Promise<void> {
    this.store.clear();
    await this.persist();
  }

  /** Full (re)index: only changed files are re-embedded. */
  async buildIndex(onProgress?: (embedded: number, total: number) => void): Promise<void> {
    if (this.indexing) return;
    const { profile } = await this.roles.resolveRole('embeddingsModel');
    if (!profile.embeddingsModel) {
      this.onLog?.('No embeddings model configured — set one on the active profile (embeddingsModel) to enable semantic search.');
      return;
    }
    this.indexing = true;
    this.state = 'indexing';
    const started = Date.now();

    try {
      const found = await fg(['**/*'], {
        cwd: this.root,
        dot: false,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/.heapcode/**'],
        suppressErrors: true,
      });
      const matcher = await loadIgnoreMatcher(this.root);
      const files = (matcher ? found.filter((f) => !matcher.ignores(f)) : found)
        .filter((f) => CODE_EXTENSIONS.test(f))
        .slice(0, MAX_FILES);

      const existing = new Set<string>();
      let embedded = 0;
      for (const rel of files) {
        existing.add(rel);
        if (await this.indexOne(rel)) embedded++;
        onProgress?.(embedded, files.length);
      }
      this.store.retainFiles(existing);
      await this.persist();
      this.state = 'idle';
      this.onLog?.(
        `indexed ${this.store.fileCount} files / ${this.store.chunkCount} chunks (${embedded} re-embedded) in ${Math.round((Date.now() - started) / 1000)}s`,
      );
    } catch (err) {
      this.state = 'error';
      this.onLog?.(`index failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.indexing = false;
    }
  }

  /** Index (or re-index) one file by workspace-relative path; returns true when it needed re-embedding. */
  async indexOne(rel: string): Promise<boolean> {
    if (!CODE_EXTENSIONS.test(rel)) return false;
    let content: string;
    try {
      const buf = await readFile(join(this.root, rel));
      if (buf.byteLength > MAX_FILE_BYTES) return false;
      content = buf.toString('utf8');
      if (content.includes('\0')) return false; // binary
    } catch {
      this.store.removeFile(rel);
      this.persistSoon();
      return false;
    }

    const fileHash = fnv1a(content);
    if (this.store.fileHash(rel) === fileHash) return false;

    const { provider, profile } = await this.roles.resolveRole('embeddingsModel');
    const model = profile.embeddingsModel;
    if (!model) return false;
    const chunks = await chunkFile(rel, content);
    if (chunks.length === 0) {
      this.store.removeFile(rel);
      this.persistSoon();
      return false;
    }

    // Embedding cache: reuse vectors for chunks whose hash didn't change.
    const cached = this.store.vectorsByHash(rel);
    const records: VectorRecord[] = [];
    const toEmbed: typeof chunks = [];
    for (const chunk of chunks) {
      const vector = cached.get(chunk.hash);
      if (vector) records.push({ ...chunk, vector });
      else toEmbed.push(chunk);
    }

    let contexts: string[] = [];
    if (toEmbed.length > 0) {
      const { provider: ctxProvider, profile: ctxProfile } = await this.roles.resolveRole('contextModel');
      const ctxModel = ctxProfile.contextModel || ctxProfile.rerankModel || ctxProfile.editModel || ctxProfile.model;
      if (ctxModel) {
        try {
          contexts = await contextualizeChunks(ctxProvider, ctxModel, rel, content, toEmbed);
        } catch {
          // Contextual retrieval is an optional quality boost — never block indexing on it.
        }
      }
    }

    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH);
      const res = await provider.embeddings({
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

  removeFile(rel: string): void {
    this.store.removeFile(rel);
    this.persistSoon();
  }

  async renameFile(oldRel: string, newRel: string): Promise<void> {
    this.store.removeFile(oldRel);
    await this.indexOne(newRel);
  }

  /** BM25-only keyword retrieval — no embedding call, no LLM call. */
  keywordSearch(text: string, k = 6): SearchHit[] {
    if (!this.ready) return [];
    return this.store.keywordSearch(text, k);
  }

  /** Semantic retrieval; empty when no embedder/index. */
  async query(text: string, k = 6): Promise<SearchHit[]> {
    if (this.store.chunkCount === 0) return [];
    const { provider, profile } = await this.roles.resolveRole('embeddingsModel');
    const model = profile.embeddingsModel;
    if (!model) return [];
    const res = await provider.embeddings({ model, input: [text] });
    const vector = res.embeddings[0];
    if (!vector || vector.length === 0) return [];

    // Hybrid search: fuse embedding + BM25 keyword ranking (reciprocal rank
    // fusion) so exact-identifier queries aren't lost to pure semantic search.
    const doSearch = (n: number) => this.store.hybridSearch(vector, text, n);

    // Rerank stage: over-fetch, let an LLM pick the hits that actually
    // answer the query. Falls back to hybrid order when no rerank model.
    const { provider: rerankProvider, profile: rerankProfile } = await this.roles.resolveRole('rerankModel');
    const rerankModel = rerankProfile.rerankModel || rerankProfile.editModel || rerankProfile.model;
    if (!rerankModel) return doSearch(k);
    const candidates = doSearch(Math.max(RERANK_CANDIDATES, k));
    if (candidates.length <= k) return candidates;
    const started = Date.now();
    try {
      const ranked = await rerankHits(rerankProvider, rerankModel, text, candidates, k);
      this.onLog?.(`reranked ${candidates.length} → ${ranked.length} hits in ${Date.now() - started}ms`);
      return ranked;
    } catch {
      return candidates.slice(0, k);
    }
  }

  /** Formatted retrieval block for prompts / the semantic_search tool. */
  async queryFormatted(text: string, k = 6): Promise<string> {
    const hits = await this.query(text, k);
    if (hits.length === 0) return '';
    return hits
      .map((h) => `--- ${h.record.path}:${h.record.startLine}-${h.record.endLine} (score ${h.score.toFixed(2)}) ---\n${h.record.text}`)
      .join('\n\n');
  }
}
