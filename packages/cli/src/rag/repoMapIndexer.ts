import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import {
  centralityStats,
  extractImportTargets,
  extractSymbols,
  fnv1a,
  formatRepoMap,
  rankByCentrality,
  type ImportEdge,
  type RepoSymbol,
} from '@heapcode/core';
import { loadIgnoreMatcher } from '../agent/ignoreFiles.js';

const INDEX_FILE = 'repo-map.json';
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|scala|sh|sql|vue|svelte|md|yaml|yml|json|toml|html|htm|css|scss|sass|less|xml|astro|graphql|gql|proto|prisma|lua|dart|ex|exs|zig|tf|ini|conf)$/i;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 3_000;
const MAX_RECENT_FILES = 20;

interface Entry {
  hash: string;
  symbols: RepoSymbol[];
  /** Resolved intra-repo import targets — workspace-relative paths, see core's extractImportTargets. */
  imports: string[];
}

interface SerializedRepoMap {
  version: 2;
  entries: Record<string, Entry>;
}

/**
 * Node-native port of packages/vscode/src/rag/repoMapIndexer.ts: fs/promises
 * + fast-glob instead of vscode.workspace.fs/findFiles. Needs no embeddings
 * model and no LLM calls (pure tree-sitter/regex parsing), so it's always
 * on. No filesystem watcher, same reasoning as RagIndexer — cli.tsx calls
 * indexOne/removeFile/renameFile right after the agent's own write tools
 * succeed.
 *
 * The extension's "recently edited" ranking boost came from
 * onDidSaveTextDocument; the CLI has no editor, so noteRecent() is driven by
 * the agent's own successful writes instead — the closest available signal
 * for "what matters right now" in a terminal session. The extension's
 * "open editor tabs" boost has no CLI equivalent and is simply omitted
 * (rankBoost always passes an empty openFiles list).
 */
export class RepoMapIndexer {
  private entries = new Map<string, Entry>();
  private indexing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private recentFiles: string[] = [];

  constructor(
    private readonly root: string,
    private readonly storageDir: string,
    private readonly onLog?: (line: string) => void,
  ) {}

  async init(): Promise<void> {
    await this.load();
  }

  get ready(): boolean {
    return this.entries.size > 0;
  }

  private get indexPath(): string {
    return join(this.storageDir, INDEX_FILE);
  }

  noteRecent(rel: string): void {
    this.recentFiles = [rel, ...this.recentFiles.filter((p) => p !== rel)].slice(0, MAX_RECENT_FILES);
  }

  private async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.indexPath, 'utf8')) as SerializedRepoMap;
      if (data.version === 2) this.entries = new Map(Object.entries(data.entries));
    } catch {
      // no map yet
    }
  }

  private persistSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 3_000);
  }

  private async persist(): Promise<void> {
    const data: SerializedRepoMap = { version: 2, entries: Object.fromEntries(this.entries) };
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(data), 'utf8');
  }

  async clear(): Promise<void> {
    this.entries.clear();
    await this.persist();
  }

  /** Full (re)build: only changed files are re-parsed. */
  async buildIndex(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
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

      const existing = new Set(files);
      for (const rel of files) await this.indexOne(rel, existing);
      for (const path of [...this.entries.keys()]) {
        if (!existing.has(path)) this.entries.delete(path);
      }
      await this.persist();
      this.onLog?.(`indexed ${this.entries.size} files in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      this.onLog?.(`repo-map index failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.indexing = false;
    }
  }

  /** Index (or re-index) one file by workspace-relative path. */
  async indexOne(rel: string, knownPaths: ReadonlySet<string> = new Set(this.entries.keys())): Promise<void> {
    if (!CODE_EXTENSIONS.test(rel)) return;
    let content: string;
    try {
      const buf = await readFile(join(this.root, rel));
      if (buf.byteLength > MAX_FILE_BYTES) return;
      content = buf.toString('utf8');
      if (content.includes('\0')) return; // binary
    } catch {
      this.entries.delete(rel);
      this.persistSoon();
      return;
    }

    const hash = fnv1a(content);
    if (this.entries.get(rel)?.hash === hash) return;

    const [symbols, imports] = await Promise.all([
      extractSymbols(rel, content),
      extractImportTargets(rel, content, knownPaths),
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

  private importEdges(): ImportEdge[] {
    const edges: ImportEdge[] = [];
    for (const [from, entry] of this.entries) {
      for (const to of entry.imports) edges.push({ from, to });
    }
    return edges;
  }

  /**
   * Formatted outline for the repo_map tool, optionally scoped to a path
   * prefix. Files are ordered by import-graph centrality (most
   * depended-upon first), personalized toward recently-written files — see
   * core's rankByCentrality — rather than alphabetically.
   */
  format(pathPrefix?: string): string {
    const entries = [...this.entries.entries()].map(([path, e]) => ({ path, symbols: e.symbols }));
    const rank = rankByCentrality([...this.entries.keys()], this.importEdges(), { recentFiles: this.recentFiles });
    return formatRepoMap(entries, { pathPrefix, rank });
  }

  /** Plain-text ranking breakdown — not used by the agent itself; format() is what it sees. */
  debugRanking(): string {
    const paths = [...this.entries.keys()];
    const edges = this.importEdges();
    const boost = { recentFiles: this.recentFiles };
    const recent = new Set(boost.recentFiles);
    const stats = centralityStats(paths, edges, boost);
    const ranked = rankByCentrality(paths, edges, boost);

    const lines = [
      `heapcode repo map — ranking debug`,
      `${paths.length} files indexed, ${edges.length} resolved import edges`,
      `Recently written (+20 each): ${recent.size ? [...recent].join(', ') : '(none)'}`,
      '',
      'rank  score  in  out  boost  recent  path',
      '----  -----  --  ---  -----  ------  ----',
    ];
    ranked.forEach((path, i) => {
      const s = stats.get(path)!;
      lines.push(
        [
          String(i + 1).padStart(4),
          String(s.score).padStart(5),
          String(s.inDegree).padStart(2),
          String(s.outDegree).padStart(3),
          String(s.boost).padStart(5),
          (recent.has(path) ? '●' : ' ').padStart(6),
          ' ' + path,
        ].join('  '),
      );
    });
    return lines.join('\n');
  }
}
