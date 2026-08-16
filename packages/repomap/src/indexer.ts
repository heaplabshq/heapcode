import { fnv1a } from './hash.js';
import { extractImportTargets } from './importGraph.js';
import { extractSymbols, formatRepoMap, type RepoSymbol } from './symbols.js';
import { rankByCentrality, type ImportEdge, type RankBoost } from './rank.js';
import type { ParserResolver } from './syntax.js';

/** Conventional filename for a persisted map — hosts pick where it lives, see RepoMapStore. */
export const REPO_MAP_FILE = 'repo-map.json';

/**
 * Which files are worth indexing at all. Exported alongside MAX_FILE_BYTES
 * and MAX_INDEXED_FILES because the semantic index applies exactly the same
 * three limits to exactly the same walk — they were duplicated verbatim in
 * both hosts' RAG indexers before that moved into core.
 */
export const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|scala|sh|sql|vue|svelte|md|yaml|yml|json|toml|html|htm|css|scss|sass|less|xml|astro|graphql|gql|proto|prisma|lua|dart|ex|exs|zig|tf|ini|conf)$/i;
/** Files larger than this are skipped: too big to chunk usefully, and usually generated. */
export const MAX_FILE_BYTES = 200_000;
/** Ceiling on indexed files. Exported so a FileSource whose walk takes its own limit can stop at the same number instead of over-collecting. */
export const MAX_INDEXED_FILES = 3_000;
const MAX_RECENT_FILES = 20;
const PERSIST_DEBOUNCE_MS = 3_000;

/**
 * The whole filesystem this package needs: enumerate candidate files, read
 * one by path. Paths are workspace-relative and POSIX-separated — they are
 * the index's keys, so they must be stable across runs. Everything
 * host-specific about *which* files are candidates (ignore rules, walk
 * limits, workspace layout) lives behind list(), which is why there is no
 * ignore-matcher parameter here: hosts already have their own.
 */
export interface FileSource {
  list(): Promise<string[]>;
  read(rel: string): Promise<Uint8Array>;
}

/** Where the serialized map lives. Reading a map that isn't there yet is a normal cold start, not an error — return undefined. */
export interface RepoMapStore {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

interface Entry {
  hash: string;
  symbols: RepoSymbol[];
  /** Resolved intra-repo import targets — workspace-relative paths, see extractImportTargets. */
  imports: string[];
}

interface SerializedRepoMapV2 {
  version: 2;
  entries: Record<string, Entry>;
}

/** Pre-import-graph shape. Migrated on load by defaulting imports to []. */
interface SerializedRepoMapV1 {
  version: 1;
  entries: Record<string, { hash: string; symbols: RepoSymbol[] }>;
}

export interface RepoMapIndexerOptions {
  files: FileSource;
  store: RepoMapStore;
  /**
   * Parser factory for AST-based extraction. Optional: without it symbols
   * come from the regex fallback and there is no import graph at all, which
   * is a working (if blunter) repo map, not a failure.
   */
  parserFor?: ParserResolver;
  /** Consulted before a full rebuild — for hosts with a user-facing enable setting. Defaults to always-on. */
  enabled?: () => boolean;
  /** Files open in the host's editor right now, workspace-relative — the strongest "this matters" ranking signal. Hosts without an editor omit it. */
  openFiles?: () => string[];
  onLog?: (line: string) => void;
}

/**
 * Persisted, incrementally-updated symbol outline + import graph of a
 * codebase — a "table of contents" a coding agent can read instead of
 * listing directories one at a time. Needs no embeddings model and no LLM
 * calls (pure parser/regex extraction), so hosts can run it unconditionally
 * in the background.
 *
 * All host coupling is in the two seams: a FileSource for enumeration and
 * reads, and a RepoMapStore for persistence. There is no filesystem watcher
 * here — hosts call indexOne/removeFile/renameFile when they know something
 * changed (an editor save, an agent's write tool succeeding), which is both
 * cheaper and more accurate than watching.
 */
export class RepoMapIndexer {
  private entries = new Map<string, Entry>();
  private indexing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** MRU of recently-touched files — a cheap "recently edited" signal for ranking (see rankByCentrality). */
  private recentFiles: string[] = [];

  constructor(private readonly opts: RepoMapIndexerOptions) {}

  /** Loads any persisted map. Safe to call once at startup; nothing else depends on it having finished. */
  async init(): Promise<void> {
    await this.load();
  }

  /** No embeddings-model gate needed — ready as soon as anything has been parsed. */
  get ready(): boolean {
    return this.entries.size > 0;
  }

  noteRecent(rel: string): void {
    this.recentFiles = [rel, ...this.recentFiles.filter((p) => p !== rel)].slice(0, MAX_RECENT_FILES);
  }

  private async load(): Promise<void> {
    try {
      const text = await this.opts.store.read();
      if (text === undefined) return;
      const data = JSON.parse(text) as SerializedRepoMapV1 | SerializedRepoMapV2;
      if (data.version === 2) {
        this.entries = new Map(Object.entries(data.entries));
      } else if (data.version === 1) {
        this.entries = new Map(Object.entries(data.entries).map(([path, e]) => [path, { ...e, imports: [] }]));
      }
    } catch {
      // no map yet, or an unreadable one — a cold rebuild is the recovery
    }
  }

  private persistSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    const data: SerializedRepoMapV2 = { version: 2, entries: Object.fromEntries(this.entries) };
    await this.opts.store.write(JSON.stringify(data));
  }

  async clear(): Promise<void> {
    this.entries.clear();
    await this.persist();
  }

  /** Full (re)build: only changed files are re-parsed. */
  async buildIndex(): Promise<void> {
    if (this.indexing || this.opts.enabled?.() === false) return;
    this.indexing = true;
    const started = Date.now();
    try {
      const found = await this.opts.files.list();
      const files = found.filter((f) => CODE_EXTENSIONS.test(f)).slice(0, MAX_INDEXED_FILES);

      const existing = new Set(files);
      for (const rel of files) await this.indexOne(rel, existing);
      for (const path of [...this.entries.keys()]) {
        if (!existing.has(path)) this.entries.delete(path);
      }
      await this.persist();
      this.opts.onLog?.(`indexed ${this.entries.size} files in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      this.opts.onLog?.(`index failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.indexing = false;
    }
  }

  /** Index (or re-index) one file by workspace-relative path. */
  async indexOne(rel: string, knownPaths: ReadonlySet<string> = new Set(this.entries.keys())): Promise<void> {
    if (!CODE_EXTENSIONS.test(rel)) return;
    let content: string;
    try {
      const bytes = await this.opts.files.read(rel);
      if (bytes.byteLength > MAX_FILE_BYTES) return;
      content = new TextDecoder().decode(bytes);
      if (content.includes('\0')) return; // binary
    } catch {
      this.entries.delete(rel);
      this.persistSoon();
      return;
    }

    const hash = fnv1a(content);
    if (this.entries.get(rel)?.hash === hash) return;

    const [symbols, imports] = await Promise.all([
      extractSymbols(rel, content, this.opts.parserFor),
      extractImportTargets(rel, content, knownPaths, this.opts.parserFor),
    ]);
    this.entries.set(rel, { hash, symbols, imports });
    this.persistSoon();
  }

  removeFile(rel: string): void {
    this.entries.delete(rel);
    this.persistSoon();
  }

  async renameFile(oldRel: string, newRel: string): Promise<void> {
    this.entries.delete(oldRel);
    await this.indexOne(newRel);
  }

  /**
   * Formatted outline for the agent, optionally scoped to a path prefix.
   * Files are ordered by import-graph centrality (most depended-upon first),
   * personalized toward whatever's open or was recently touched — see
   * rankByCentrality — rather than alphabetically, so truncation under the
   * char budget drops the least-connected files first, not just whatever
   * sorts last.
   */
  format(pathPrefix?: string): string {
    const entries = [...this.entries.entries()].map(([path, e]) => ({ path, symbols: e.symbols }));
    const { paths, edges, boost } = this.rankingInputs();
    return formatRepoMap(entries, { pathPrefix, rank: rankByCentrality(paths, edges, boost) });
  }

  /**
   * The graph as ranked: every indexed path, every resolved import edge, and
   * the personalization boost. Exposed so a caller can rank or inspect it
   * themselves — formatRankingDebug is exactly that, and needs no privileged
   * access to do it.
   */
  rankingInputs(): { paths: string[]; edges: ImportEdge[]; boost: RankBoost } {
    const edges: ImportEdge[] = [];
    for (const [from, entry] of this.entries) {
      for (const to of entry.imports) edges.push({ from, to });
    }
    const boost: RankBoost = this.opts.openFiles
      ? { openFiles: this.opts.openFiles(), recentFiles: this.recentFiles }
      : { recentFiles: this.recentFiles };
    return { paths: [...this.entries.keys()], edges, boost };
  }

  /**
   * The map as data, in the same centrality order `format()` prints it.
   *
   * `format()` already renders this for the *model*, under a character budget
   * and as flat text. A UI showing a human the same map needs it structured —
   * symbols to list, imports to link, and no budget, because the reader
   * scrolls and filters rather than reading it in one prompt. Reparsing the
   * formatted text to recover that would be inventing a second, lossier
   * representation of something this class already holds.
   *
   * Files with no symbols are kept here, unlike in `format()`: a file that
   * parsed to nothing is a fact worth being able to see when you are asking
   * why the map looks thin.
   */
  snapshot(): Array<{ path: string; symbols: RepoSymbol[]; imports: string[] }> {
    const { paths, edges, boost } = this.rankingInputs();
    const order = new Map(rankByCentrality(paths, edges, boost).map((p, i) => [p, i]));
    return [...this.entries.entries()]
      .map(([path, e]) => ({ path, symbols: e.symbols, imports: e.imports }))
      .sort((a, b) => {
        const ra = order.get(a.path) ?? Number.MAX_SAFE_INTEGER;
        const rb = order.get(b.path) ?? Number.MAX_SAFE_INTEGER;
        return ra === rb ? a.path.localeCompare(b.path) : ra - rb;
      });
  }
}
