import { bm25Scores, tokenize } from './bm25.js';

export interface VectorRecord {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  /** L2-normalized at insert; cosine similarity = dot product. */
  vector: Float32Array;
  /** Contextual-retrieval blurb (if generated) — embedded alongside the text and indexed for hybrid search too. */
  context?: string;
}

export interface SearchHit {
  record: VectorRecord;
  score: number;
}

interface SerializedStore {
  version: 1;
  fileHashes: Record<string, string>;
  records: Array<Omit<VectorRecord, 'vector'> & { vector: number[] }>;
}

/**
 * Pure-JS vector store: brute-force cosine over normalized Float32Arrays.
 * Comfortable to ~50k chunks — sqlite-vec can swap in behind this interface
 * if projects outgrow it.
 */
export class VectorStore {
  private records: VectorRecord[] = [];
  private fileHashes = new Map<string, string>();

  get chunkCount(): number {
    return this.records.length;
  }

  get fileCount(): number {
    return this.fileHashes.size;
  }

  /** Content hash of a file at last indexing — skip unchanged files. */
  fileHash(path: string): string | undefined {
    return this.fileHashes.get(path);
  }

  /** Embedding cache: existing vectors by chunk hash, to reuse across edits. */
  vectorsByHash(path: string): Map<string, Float32Array> {
    const map = new Map<string, Float32Array>();
    for (const r of this.records) {
      if (r.path === path) map.set(r.hash, r.vector);
    }
    return map;
  }

  upsertFile(path: string, fileHash: string, records: VectorRecord[]): void {
    this.records = this.records.filter((r) => r.path !== path);
    for (const r of records) {
      this.records.push({ ...r, vector: normalize(r.vector) });
    }
    this.fileHashes.set(path, fileHash);
  }

  removeFile(path: string): void {
    this.records = this.records.filter((r) => r.path !== path);
    this.fileHashes.delete(path);
  }

  /** Drop entries for files that no longer exist. */
  retainFiles(existing: Set<string>): void {
    this.records = this.records.filter((r) => existing.has(r.path));
    for (const path of [...this.fileHashes.keys()]) {
      if (!existing.has(path)) this.fileHashes.delete(path);
    }
  }

  clear(): void {
    this.records = [];
    this.fileHashes.clear();
  }

  search(query: Float32Array | number[], k: number): SearchHit[] {
    const q = normalize(query instanceof Float32Array ? query : Float32Array.from(query));
    const hits: SearchHit[] = [];
    for (const record of this.records) {
      let dot = 0;
      const v = record.vector;
      const n = Math.min(v.length, q.length);
      for (let i = 0; i < n; i++) dot += v[i]! * q[i]!;
      hits.push({ record, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /**
   * Fuses the embedding ranking with a BM25 keyword ranking via Reciprocal
   * Rank Fusion (score = Σ 1/(60 + rank) across both rankings — standard
   * RRF constant). Catches exact-identifier queries pure embedding search
   * misses, without losing the semantic matches BM25 misses.
   */
  hybridSearch(query: Float32Array | number[], queryText: string, k: number): SearchHit[] {
    const overfetch = Math.max(k * 3, 50);
    const vectorHits = this.search(query, overfetch);
    const bm25 = bm25Scores(this.records, tokenize(queryText));
    const bm25Ranked = [...bm25.entries()].sort((a, b) => b[1] - a[1]).slice(0, overfetch);

    const RRF_K = 60;
    const fused = new Map<VectorRecord, number>();
    vectorHits.forEach((hit, rank) => {
      fused.set(hit.record, (fused.get(hit.record) ?? 0) + 1 / (RRF_K + rank));
    });
    bm25Ranked.forEach(([record], rank) => {
      fused.set(record, (fused.get(record) ?? 0) + 1 / (RRF_K + rank));
    });

    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([record, score]) => ({ record, score }));
  }

  /**
   * BM25-only ranking, no vector involved — no embedding call, no LLM call,
   * pure in-memory computation. Used where retrieval must stay cheap enough
   * to run inside a typing debounce window (see completionProvider.ts).
   */
  keywordSearch(queryText: string, k: number): SearchHit[] {
    const scores = bm25Scores(this.records, tokenize(queryText));
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([record, score]) => ({ record, score }));
  }

  serialize(): string {
    const out: SerializedStore = {
      version: 1,
      fileHashes: Object.fromEntries(this.fileHashes),
      records: this.records.map((r) => ({ ...r, vector: Array.from(r.vector) })),
    };
    return JSON.stringify(out);
  }

  static deserialize(json: string): VectorStore {
    const store = new VectorStore();
    const data = JSON.parse(json) as SerializedStore;
    if (data.version !== 1) return store;
    store.fileHashes = new Map(Object.entries(data.fileHashes));
    store.records = data.records.map((r) => ({ ...r, vector: Float32Array.from(r.vector) }));
    return store;
  }
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}
