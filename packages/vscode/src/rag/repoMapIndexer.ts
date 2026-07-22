import * as vscode from 'vscode';
import {
  centralityStats,
  DEFAULT_IGNORE_GLOB,
  extractImportTargets,
  extractSymbols,
  fnv1a,
  formatRepoMap,
  rankByCentrality,
  type ImportEdge,
  type RepoSymbol,
} from '@heapcode/core';
import { filterIgnored } from '../ignoreFiles.js';

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

interface SerializedRepoMapV2 {
  version: 2;
  entries: Record<string, Entry>;
}

/** Pre-M11 shape — no import graph yet. Migrated on load by defaulting imports to []. */
interface SerializedRepoMapV1 {
  version: 1;
  entries: Record<string, { hash: string; symbols: RepoSymbol[] }>;
}

/**
 * Persisted, incrementally-updated symbol outline + import graph of the
 * workspace — a "table of contents" for the repo_map agent tool. Unlike
 * RagIndexer, this needs no embeddings model and no LLM calls at all (pure
 * tree-sitter/regex parsing via core's extractSymbols/extractImportTargets),
 * so it runs unconditionally in the background, gated only by
 * heapcode.repoMap.enable.
 */
export class RepoMapIndexer implements vscode.Disposable {
  private entries = new Map<string, Entry>();
  private indexing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];
  /** MRU of recently-saved files — a cheap "recently edited" signal for repo_map ranking (see rankByCentrality). */
  private recentFiles: string[] = [];

  constructor(
    private readonly storageDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.enabled() && CODE_EXTENSIONS.test(doc.uri.path)) {
          const rel = vscode.workspace.asRelativePath(doc.uri, false);
          this.noteRecent(rel);
          void this.indexOne(doc.uri, new Set(this.entries.keys())).then(() => this.persistSoon());
        }
      }),
    );
    void this.load();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** No embeddings-model gate needed — ready as soon as anything has been parsed. */
  get ready(): boolean {
    return this.entries.size > 0;
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('heapcode').get<boolean>('repoMap.enable', true);
  }

  private get indexUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageDir, INDEX_FILE);
  }

  private noteRecent(rel: string): void {
    this.recentFiles = [rel, ...this.recentFiles.filter((p) => p !== rel)].slice(0, MAX_RECENT_FILES);
  }

  private async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.indexUri);
      const data = JSON.parse(new TextDecoder().decode(bytes)) as SerializedRepoMapV1 | SerializedRepoMapV2;
      if (data.version === 2) {
        this.entries = new Map(Object.entries(data.entries));
      } else if (data.version === 1) {
        this.entries = new Map(
          Object.entries(data.entries).map(([path, e]) => [path, { ...e, imports: [] }]),
        );
      }
    } catch {
      // no map yet
    }
  }

  private persistSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 3_000);
  }

  private async persist(): Promise<void> {
    const data: SerializedRepoMapV2 = { version: 2, entries: Object.fromEntries(this.entries) };
    await vscode.workspace.fs.createDirectory(this.storageDir);
    await vscode.workspace.fs.writeFile(this.indexUri, new TextEncoder().encode(JSON.stringify(data)));
  }

  async clear(): Promise<void> {
    this.entries.clear();
    await this.persist();
  }

  /** Full (re)build: only changed files are re-parsed. */
  async buildIndex(): Promise<void> {
    if (this.indexing || !this.enabled()) return;
    this.indexing = true;
    const started = Date.now();
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const found = await vscode.workspace.findFiles('**/*', DEFAULT_IGNORE_GLOB, MAX_FILES);
      const files = root ? await filterIgnored(root, found) : found;
      const existing = new Set<string>();
      for (const file of files) {
        const rel = vscode.workspace.asRelativePath(file, false);
        if (!CODE_EXTENSIONS.test(rel)) continue;
        existing.add(rel);
      }
      for (const file of files) {
        const rel = vscode.workspace.asRelativePath(file, false);
        if (!existing.has(rel)) continue;
        await this.indexOne(file, existing);
      }
      for (const path of [...this.entries.keys()]) {
        if (!existing.has(path)) this.entries.delete(path);
      }
      await this.persist();
      this.log.appendLine(
        `[repo-map] indexed ${this.entries.size} files in ${Math.round((Date.now() - started) / 1000)}s`,
      );
    } catch (err) {
      this.log.appendLine(`[repo-map] index failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.indexing = false;
    }
  }

  private async indexOne(uri: vscode.Uri, knownPaths: ReadonlySet<string>): Promise<void> {
    const rel = vscode.workspace.asRelativePath(uri, false);
    let content: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_FILE_BYTES) return;
      content = new TextDecoder().decode(bytes);
      if (content.includes('\0')) return; // binary
    } catch {
      this.entries.delete(rel);
      return;
    }

    const hash = fnv1a(content);
    if (this.entries.get(rel)?.hash === hash) return;

    const [symbols, imports] = await Promise.all([
      extractSymbols(rel, content),
      extractImportTargets(rel, content, knownPaths),
    ]);
    this.entries.set(rel, { hash, symbols, imports });
  }

  /** Every resolved import edge currently in the index, for ranking or external inspection. */
  private importEdges(): ImportEdge[] {
    const edges: ImportEdge[] = [];
    for (const [from, entry] of this.entries) {
      for (const to of entry.imports) edges.push({ from, to });
    }
    return edges;
  }

  /** Currently-open editor tabs, workspace-relative — the strongest "this matters right now" signal. */
  private openFiles(): string[] {
    const out: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && (input.uri.scheme === 'file' || input.uri.scheme === 'untitled')) {
          out.push(vscode.workspace.asRelativePath(input.uri, false));
        }
      }
    }
    return out;
  }

  /**
   * Formatted outline for the repo_map tool, optionally scoped to a path
   * prefix. Files are ordered by import-graph centrality (most depended-upon
   * first), personalized toward whatever's open or was recently saved — see
   * core's rankByCentrality — rather than alphabetically, so truncation under
   * the char budget drops the least-connected files first, not just whatever
   * sorts last.
   */
  format(pathPrefix?: string): string {
    const entries = [...this.entries.entries()].map(([path, e]) => ({ path, symbols: e.symbols }));
    const rank = rankByCentrality([...this.entries.keys()], this.importEdges(), this.rankBoost());
    return formatRepoMap(entries, { pathPrefix, rank });
  }

  private rankBoost(): { openFiles: string[]; recentFiles: string[] } {
    return { openFiles: this.openFiles(), recentFiles: this.recentFiles };
  }

  /**
   * Plain-text ranking breakdown for the "Heap Code: Show Repo Map Ranking
   * (Debug)" command — every indexed file with its score components, so you
   * can see *why* it ranked where it did without going through the agent/LLM
   * at all. Not used by the agent itself; format() is what it actually sees.
   */
  debugRanking(): string {
    const paths = [...this.entries.keys()];
    const edges = this.importEdges();
    const boost = this.rankBoost();
    const open = new Set(boost.openFiles);
    const recent = new Set(boost.recentFiles);
    const stats = centralityStats(paths, edges, boost);
    const ranked = rankByCentrality(paths, edges, boost);

    const lines = [
      `Heap Code repo map — ranking debug`,
      `${paths.length} files indexed, ${edges.length} resolved import edges`,
      `Open tabs (+50 each): ${open.size ? [...open].join(', ') : '(none)'}`,
      `Recently saved (+20 each): ${recent.size ? [...recent].join(', ') : '(none)'}`,
      '',
      'rank  score  in  out  boost  open  recent  path',
      '----  -----  --  ---  -----  ----  ------  ----',
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
          (open.has(path) ? '●' : ' ').padStart(4),
          (recent.has(path) ? '●' : ' ').padStart(6),
          ' ' + path,
        ].join('  '),
      );
    });
    return lines.join('\n');
  }
}
