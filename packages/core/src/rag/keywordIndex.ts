import {
  CODE_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_INDEXED_FILES,
  type FileSource,
} from '@heapcode/repomap';
import { bm25Scores, tokenize } from './bm25.js';
import { chunkFile, fnv1a } from './chunker.js';
import type { RagStore } from './indexer.js';
import type { SearchHit } from './store.js';

/** Conventional filename for a persisted keyword index — hosts pick where it lives. */
export const KEYWORD_INDEX_FILE = 'keyword-index.json';

/**
 * A retrieval hit stripped to what every consumer of RAG actually reads.
 *
 * No `vector`: not one caller of semantic search ever looked at an embedding
 * (docs/phase3-rag-design.md §1.2), and on the measured index the vectors were
 * 87% of a payload nobody read. This is the shape that crosses the wire and
 * the shape a host-side keyword index produces, so the two are
 * interchangeable at the call site.
 */
export interface HitMeta {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

export function toHitMeta(hit: SearchHit): HitMeta {
  return {
    path: hit.record.path,
    startLine: hit.record.startLine,
    endLine: hit.record.endLine,
    text: hit.record.text,
    score: hit.score,
  };
}

interface KeywordRecord {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

interface SerializedKeywordIndex {
  version: 1;
  fileHashes: Record<string, string>;
  records: KeywordRecord[];
}

export interface KeywordIndexOptions {
  files: FileSource;
  store: RagStore;
  onLog?: (line: string) => void;
}

/**
 * A vector-free, model-free BM25 index over the same chunks the semantic
 * index builds from.
 *
 * This exists for exactly one caller: ghost text's automatic (typing)
 * trigger, which retrieves repo context inside the debounce window. Protocol
 * §4 kept that path host-side on latency grounds, and the RAG migration moved
 * the vector store into the server — so rather than mirror the server's store
 * or put a socket round-trip on a keystroke deadline, the host builds its own
 * much smaller index (docs/phase3-rag-design.md open question 1, resolved).
 *
 * It is not a copy of anything, which is the point: there is no freshness
 * problem to solve because there is nothing upstream to be stale against. It
 * is built from the same file-change triggers that drive the semantic index,
 * costs no model calls at all, and holds roughly a tenth of what the vector
 * index does (~1.8 MB against ~15.6 MB on this repo).
 *
 * Chunk boundaries come from the same `chunkFile`, so a hit here names the
 * same line range the semantic index would.
 */
export class KeywordIndex {
  private records: KeywordRecord[] = [];
  private fileHashes = new Map<string, string>();
  private building = false;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: KeywordIndexOptions) {}

  async init(): Promise<void> {
    try {
      const text = await this.opts.store.read();
      if (text === undefined) return;
      const data = JSON.parse(text) as SerializedKeywordIndex;
      if (data.version !== 1) return;
      this.fileHashes = new Map(Object.entries(data.fileHashes));
      this.records = data.records;
    } catch {
      // no index yet, or an unreadable one — a cold rebuild is the recovery
    }
  }

  get ready(): boolean {
    return this.records.length > 0;
  }

  get fileCount(): number {
    return this.fileHashes.size;
  }

  get chunkCount(): number {
    return this.records.length;
  }

  /**
   * BM25 over every chunk. Synchronous and allocation-bound, never I/O-bound:
   * that is the property the keystroke path depends on.
   */
  search(queryText: string, k = 6): HitMeta[] {
    if (this.records.length === 0) return [];
    const scores = bm25Scores(this.records, tokenize(queryText));
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([record, score]) => ({
        path: record.path,
        startLine: record.startLine,
        endLine: record.endLine,
        text: record.text,
        score,
      }));
  }

  /** Full (re)build: only changed files are re-chunked. */
  async buildIndex(): Promise<{ files: number; chunks: number } | undefined> {
    if (this.building) return undefined;
    this.building = true;
    const started = Date.now();
    try {
      const found = await this.opts.files.list();
      const files = found.filter((f) => CODE_EXTENSIONS.test(f)).slice(0, MAX_INDEXED_FILES);

      const existing = new Set<string>();
      for (const rel of files) {
        existing.add(rel);
        await this.indexOne(rel);
      }
      this.records = this.records.filter((r) => existing.has(r.path));
      for (const path of [...this.fileHashes.keys()]) {
        if (!existing.has(path)) this.fileHashes.delete(path);
      }
      await this.persist();
      this.opts.onLog?.(
        `keyword index: ${this.fileHashes.size} files / ${this.records.length} chunks in ` +
          `${Math.round((Date.now() - started) / 1000)}s`,
      );
      return { files: this.fileHashes.size, chunks: this.records.length };
    } catch (err) {
      this.opts.onLog?.(`keyword index failed: ${err instanceof Error ? err.message : String(err)}`);
      return { files: this.fileHashes.size, chunks: this.records.length };
    } finally {
      this.building = false;
    }
  }

  /** Index (or re-index) one file by workspace-relative path. */
  async indexOne(rel: string): Promise<void> {
    if (!CODE_EXTENSIONS.test(rel)) return;
    let content: string;
    try {
      const bytes = await this.opts.files.read(rel);
      if (bytes.byteLength > MAX_FILE_BYTES) return;
      content = new TextDecoder().decode(bytes);
      if (content.includes('\0')) return; // binary
    } catch {
      this.removeFile(rel);
      return;
    }

    const fileHash = fnv1a(content);
    if (this.fileHashes.get(rel) === fileHash) return;

    const chunks = await chunkFile(rel, content);
    this.records = this.records.filter((r) => r.path !== rel);
    for (const chunk of chunks) {
      this.records.push({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        hash: chunk.hash,
      });
    }
    this.fileHashes.set(rel, fileHash);
    this.persistSoon();
  }

  removeFile(rel: string): void {
    this.records = this.records.filter((r) => r.path !== rel);
    this.fileHashes.delete(rel);
    this.persistSoon();
  }

  async renameFile(oldRel: string, newRel: string): Promise<void> {
    this.removeFile(oldRel);
    await this.indexOne(newRel);
  }

  async clear(): Promise<void> {
    this.records = [];
    this.fileHashes.clear();
    await this.persist();
  }

  private persistSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 3_000);
  }

  private async persist(): Promise<void> {
    clearTimeout(this.saveTimer);
    const data: SerializedKeywordIndex = {
      version: 1,
      fileHashes: Object.fromEntries(this.fileHashes),
      records: this.records,
    };
    await this.opts.store.write(JSON.stringify(data));
  }
}
