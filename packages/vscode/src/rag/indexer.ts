import * as vscode from 'vscode';
import {
  DEFAULT_IGNORE_GLOB,
  RagIndexer as RagIndex,
  RAG_INDEX_FILE,
  type HitMeta,
  type IndexState,
  type QueryOptions,
  type SearchHit,
} from '@heapcode/core';
import { CODE_EXTENSIONS, MAX_INDEXED_FILES, type FileSource, type RepoMapStore } from '@heapcode/repomap';
import { filterIgnored } from '../ignoreFiles.js';
import type { ProfileManager } from '../profileManager.js';

export type { IndexState };

/**
 * The semantic index (@heapcode/core) wired to the workspace: findFiles +
 * workspace.fs instead of a Node filesystem, and role resolution through
 * ProfileManager.
 *
 * Everything here is adapter — enumeration, reads, persistence, and the four
 * `heapcode.rag.*` settings. The index itself, its embedding cache and its
 * retrieval are the package's, shared verbatim with the CLI. This is the same
 * split repoMapIndexer.ts already uses for the repo map.
 */
export class RagIndexer implements vscode.Disposable {
  private readonly index: RagIndex;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onStatusEmitter = new vscode.EventEmitter<void>();
  readonly onStatus = this.onStatusEmitter.event;
  /**
   * Last status, so the status bar can read it synchronously. Resolving the
   * embeddings role is async in core (the CLI reads config off disk), while
   * extension.ts's status-bar updater is not.
   */
  private last: { state: IndexState; files: number; chunks: number } = { state: 'idle', files: 0, chunks: 0 };
  /** Workspace-relative path -> Uri from the last enumeration — asRelativePath is not reliably invertible in a multi-root workspace. */
  private readonly uris = new Map<string, vscode.Uri>();

  constructor(
    private readonly profiles: ProfileManager,
    private readonly storageDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
    private readonly track?: (name: string, meta?: Record<string, unknown>) => void,
  ) {
    this.index = new RagIndex({
      files: this.fileSource(),
      store: this.store(),
      roles: (role) => this.profiles.resolveRole(role),
      // The extension gates `ready` on an embeddings model being configured;
      // the CLI gates only on the index having content. Kept per-host rather
      // than silently unified (docs/phase3-rag-design.md §5.4).
      requireEmbedderForReady: true,
      onLog: (line) => this.log.appendLine(`[rag] ${line}`),
    });
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (CODE_EXTENSIONS.test(doc.uri.path)) {
          const rel = vscode.workspace.asRelativePath(doc.uri, false);
          this.uris.set(rel, doc.uri);
          void this.index.indexOne(rel, this.indexOptions()).then(() => void this.refresh());
        }
      }),
    );
    void this.init();
  }

  private async init(): Promise<void> {
    await this.index.init();
    await this.refresh();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.onStatusEmitter.dispose();
  }

  /** Synchronous by design — extension.ts's status-bar updater runs on every state change. */
  status(): { state: IndexState; files: number; chunks: number } {
    return this.last;
  }

  private async refresh(): Promise<void> {
    this.last = await this.index.status();
    this.onStatusEmitter.fire();
  }

  get ready(): boolean {
    return this.index.ready;
  }

  /** Full (re)index. Warns rather than logging when no embeddings model is configured — a user-facing setup gap, not an event. */
  async buildIndex(): Promise<void> {
    const before = this.index.chunkCount;
    let seen = 0;
    const result = await this.index.buildIndex({
      ...this.indexOptions(),
      onProgress: (embedded) => {
        if (embedded > seen && embedded % 20 === 0) void this.refresh();
        seen = embedded;
      },
    });
    if (!result) {
      void vscode.window.showWarningMessage(
        'Heap Code: no embeddings model configured. Status bar → Select model → Embeddings (e.g. nomic-embed-text on Ollama).',
      );
      return;
    }
    if (before === 0 && result.chunks > 0) {
      // Decision 5 of the RAG migration: the index moved out of this
      // extension's own storage, so the first build after upgrading is a full
      // rebuild rather than an incremental update. Say so rather than leaving
      // the user wondering why indexing took minutes this once.
      this.log.appendLine(
        `[rag] built a fresh index (${result.files} files / ${result.chunks} chunks) — ` +
          'no existing index was found for this workspace, so every file was embedded',
      );
    }
    this.track?.('rag.index.built');
    await this.refresh();
  }

  async clear(): Promise<void> {
    await this.index.clear();
    await this.refresh();
  }

  query(text: string, k = 6): Promise<SearchHit[]> {
    return this.index.query(text, k, this.queryOptions());
  }

  /** Hits without their embeddings — what ghost text's manual trigger renders. */
  queryHits(text: string, k = 6): Promise<HitMeta[]> {
    return this.index.queryHits(text, k, this.queryOptions());
  }

  queryFormatted(text: string, k = 6): Promise<string> {
    return this.index.queryFormatted(text, k, this.queryOptions());
  }

  /** The two `heapcode.rag.*` settings that shape a query, read per call so a change takes effect immediately. */
  private queryOptions(): QueryOptions {
    const config = vscode.workspace.getConfiguration('heapcode');
    return {
      hybridSearch: config.get<boolean>('rag.hybridSearch', true),
      rerank: config.get<boolean>('rag.rerank', true),
    };
  }

  /** Off by default here, unlike the CLI: it runs once per *changed chunk*, so it adds real time to indexing. */
  private indexOptions(): { contextualRetrieval: boolean } {
    return {
      contextualRetrieval: vscode.workspace
        .getConfiguration('heapcode')
        .get<boolean>('rag.contextualRetrieval', false),
    };
  }

  private fileSource(): FileSource {
    return {
      list: async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const found = await vscode.workspace.findFiles('**/*', DEFAULT_IGNORE_GLOB, MAX_INDEXED_FILES);
        const files = root ? await filterIgnored(root, found) : found;
        this.uris.clear();
        const rels: string[] = [];
        for (const file of files) {
          const rel = vscode.workspace.asRelativePath(file, false);
          this.uris.set(rel, file);
          rels.push(rel);
        }
        return rels;
      },
      read: (rel) => Promise.resolve(vscode.workspace.fs.readFile(this.uriFor(rel))),
    };
  }

  private uriFor(rel: string): vscode.Uri {
    const known = this.uris.get(rel);
    if (known) return known;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error(`No workspace folder to resolve ${rel} against`);
    return vscode.Uri.joinPath(root, rel);
  }

  private store(): RepoMapStore {
    const file = vscode.Uri.joinPath(this.storageDir, RAG_INDEX_FILE);
    return {
      read: async () => {
        try {
          return new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
        } catch {
          return undefined;
        }
      },
      write: async (text) => {
        await vscode.workspace.fs.createDirectory(this.storageDir);
        await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
      },
    };
  }
}
