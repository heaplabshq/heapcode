import * as vscode from 'vscode';
import {
  chunkFile,
  contextualizeChunks,
  DEFAULT_IGNORE_GLOB,
  fnv1a,
  RERANK_CANDIDATES,
  rerankHits,
  VectorStore,
  type SearchHit,
  type VectorRecord,
} from '@heapcode/core';
import { filterIgnored } from '../ignoreFiles.js';
import type { ProfileManager } from '../profileManager.js';

const INDEX_FILE = 'rag-index.json';
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|scala|sh|sql|vue|svelte|md|yaml|yml|json|toml|html|htm|css|scss|sass|less|xml|astro|graphql|gql|proto|prisma|lua|dart|ex|exs|zig|tf|ini|conf)$/i;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 3_000;
const EMBED_BATCH = 16;

export type IndexState = 'no-embedder' | 'idle' | 'indexing' | 'error';

export class RagIndexer implements vscode.Disposable {
  private store = new VectorStore();
  private state: IndexState = 'idle';
  private indexing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onStatusEmitter = new vscode.EventEmitter<void>();
  readonly onStatus = this.onStatusEmitter.event;

  constructor(
    private readonly profiles: ProfileManager,
    private readonly storageDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
    private readonly track?: (name: string, meta?: Record<string, unknown>) => void,
  ) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.embeddingsModel() && CODE_EXTENSIONS.test(doc.uri.path)) {
          void this.indexOne(doc.uri).then(() => this.persistSoon());
        }
      }),
    );
    void this.load();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.onStatusEmitter.dispose();
  }

  status(): { state: IndexState; files: number; chunks: number } {
    return {
      state: this.embeddingsModel() ? this.state : 'no-embedder',
      files: this.store.fileCount,
      chunks: this.store.chunkCount,
    };
  }

  get ready(): boolean {
    return !!this.embeddingsModel() && this.store.chunkCount > 0;
  }

  private embeddingsModel(): string | undefined {
    return this.profiles.resolveRoleProfile('embeddingsModel').embeddingsModel || undefined;
  }

  private get indexUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageDir, INDEX_FILE);
  }

  private async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.indexUri);
      this.store = VectorStore.deserialize(new TextDecoder().decode(bytes));
      this.onStatusEmitter.fire();
    } catch {
      // no index yet
    }
  }

  private persistSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 3_000);
  }

  private async persist(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.storageDir);
    await vscode.workspace.fs.writeFile(
      this.indexUri,
      new TextEncoder().encode(this.store.serialize()),
    );
  }

  async clear(): Promise<void> {
    this.store.clear();
    await this.persist();
    this.onStatusEmitter.fire();
  }

  /** Full (re)index: only changed files are re-embedded. */
  async buildIndex(): Promise<void> {
    if (this.indexing) return;
    const model = this.embeddingsModel();
    if (!model) {
      void vscode.window.showWarningMessage(
        'Heap Code: no embeddings model configured. Status bar → Select model → Embeddings (e.g. nomic-embed-text on Ollama).',
      );
      return;
    }
    this.indexing = true;
    this.state = 'indexing';
    this.onStatusEmitter.fire();
    const started = Date.now();

    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const found = await vscode.workspace.findFiles('**/*', DEFAULT_IGNORE_GLOB, MAX_FILES);
      const files = root ? await filterIgnored(root, found) : found;
      const existing = new Set<string>();
      let embedded = 0;

      for (const file of files) {
        const rel = vscode.workspace.asRelativePath(file, false);
        if (!CODE_EXTENSIONS.test(rel)) continue;
        existing.add(rel);
        if (await this.indexOne(file)) embedded++;
        if (embedded > 0 && embedded % 20 === 0) this.onStatusEmitter.fire();
      }
      this.store.retainFiles(existing);
      await this.persist();
      this.state = 'idle';
      this.log.appendLine(
        `[rag] indexed ${this.store.fileCount} files / ${this.store.chunkCount} chunks (${embedded} re-embedded) in ${Math.round((Date.now() - started) / 1000)}s`,
      );
      this.track?.('rag.index.built');
    } catch (err) {
      this.state = 'error';
      this.log.appendLine(`[rag] index failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.indexing = false;
      this.onStatusEmitter.fire();
    }
  }

  /** Index one file; returns true when it needed re-embedding. */
  private async indexOne(uri: vscode.Uri): Promise<boolean> {
    const rel = vscode.workspace.asRelativePath(uri, false);
    let content: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_FILE_BYTES) return false;
      content = new TextDecoder().decode(bytes);
      if (content.includes('\0')) return false; // binary
    } catch {
      this.store.removeFile(rel);
      return false;
    }

    const fileHash = fnv1a(content);
    if (this.store.fileHash(rel) === fileHash) return false;

    const model = this.embeddingsModel();
    if (!model) return false;
    const chunks = await chunkFile(rel, content);
    if (chunks.length === 0) {
      this.store.removeFile(rel);
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

    // Contextual retrieval: a short blurb per chunk, prepended before
    // embedding — only for chunks that need (re-)embedding anyway, so cost
    // scales with what changed, not the whole repo every index run.
    let contexts: string[] = [];
    if (
      toEmbed.length > 0 &&
      vscode.workspace.getConfiguration('heapcode').get<boolean>('rag.contextualRetrieval', false)
    ) {
      const { provider: ctxProvider, profile: ctxProfile } =
        await this.profiles.resolveRole('contextModel');
      const ctxModel = ctxProfile.contextModel || ctxProfile.rerankModel || ctxProfile.editModel || ctxProfile.model;
      if (ctxModel) {
        contexts = await contextualizeChunks(ctxProvider, ctxModel, rel, content, toEmbed);
      }
    }

    const { provider } = await this.profiles.resolveRole('embeddingsModel');
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
    return toEmbed.length > 0;
  }

  /**
   * BM25-only keyword retrieval — no embedding call, no LLM call. Cheap
   * enough to call on every typing-triggered completion (see
   * completionProvider.ts's collectRepoContext).
   */
  keywordSearch(text: string, k = 6): SearchHit[] {
    if (!this.ready) return [];
    return this.store.keywordSearch(text, k);
  }

  /** Semantic retrieval; empty when no embedder/index. */
  async query(text: string, k = 6): Promise<SearchHit[]> {
    const model = this.embeddingsModel();
    if (!model || this.store.chunkCount === 0) return [];
    const { provider } = await this.profiles.resolveRole('embeddingsModel');
    const res = await provider.embeddings({ model, input: [text] });
    const vector = res.embeddings[0];
    if (!vector || vector.length === 0) return [];

    // Hybrid search: fuse the embedding ranking with a BM25 keyword ranking
    // (reciprocal rank fusion) so exact-identifier queries aren't lost to
    // pure semantic search. Free — no extra model calls.
    const hybrid = vscode.workspace.getConfiguration('heapcode').get<boolean>('rag.hybridSearch', true);
    const doSearch = (n: number) =>
      hybrid ? this.store.hybridSearch(vector, text, n) : this.store.search(vector, n);

    // Rerank stage: over-fetch, let an LLM pick the hits that actually
    // answer the query. Falls back to vector/hybrid order. Its own role, so
    // it can run on a different profile than the embeddings did.
    const rerank = vscode.workspace.getConfiguration('heapcode').get<boolean>('rag.rerank', true);
    const { provider: rerankProvider, profile: rerankProfile } =
      await this.profiles.resolveRole('rerankModel');
    const rerankModel = rerankProfile.rerankModel || rerankProfile.editModel || rerankProfile.model;
    if (!rerank || !rerankModel) return doSearch(k);
    const candidates = doSearch(Math.max(RERANK_CANDIDATES, k));
    if (candidates.length <= k) return candidates;
    const started = Date.now();
    const ranked = await rerankHits(rerankProvider, rerankModel, text, candidates, k);
    this.log.appendLine(
      `[rag] reranked ${candidates.length} → ${ranked.length} hits in ${Date.now() - started}ms`,
    );
    return ranked;
  }

  /** Formatted retrieval block for prompts. */
  async queryFormatted(text: string, k = 6): Promise<string> {
    const hits = await this.query(text, k);
    return hits
      .map(
        (h) =>
          `--- ${h.record.path}:${h.record.startLine}-${h.record.endLine} (score ${h.score.toFixed(2)}) ---\n${h.record.text}`,
      )
      .join('\n\n');
  }

}
