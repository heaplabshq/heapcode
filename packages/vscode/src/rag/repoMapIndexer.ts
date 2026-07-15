import * as vscode from 'vscode';
import { extractSymbols, fnv1a, formatRepoMap, type RepoSymbol } from '@heapcode/core';

const INDEX_FILE = 'repo-map.json';
const IGNORE_GLOB =
  '**/{node_modules,dist,build,target,.git,coverage,vendor,out,.next,.heapcode}/**';
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|scala|sh|sql|vue|svelte|md|yaml|yml|json|toml|html|htm|css|scss|sass|less|xml|astro|graphql|gql|proto|prisma|lua|dart|ex|exs|zig|tf|ini|conf)$/i;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 3_000;

interface Entry {
  hash: string;
  symbols: RepoSymbol[];
}

interface SerializedRepoMap {
  version: 1;
  entries: Record<string, Entry>;
}

/**
 * Persisted, incrementally-updated symbol outline of the workspace — a
 * "table of contents" for the repo_map agent tool. Unlike RagIndexer, this
 * needs no embeddings model and no LLM calls at all (pure tree-sitter/regex
 * parsing via core's extractSymbols), so it runs unconditionally in the
 * background, gated only by heapcode.repoMap.enable.
 */
export class RepoMapIndexer implements vscode.Disposable {
  private entries = new Map<string, Entry>();
  private indexing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly storageDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.enabled() && CODE_EXTENSIONS.test(doc.uri.path)) {
          void this.indexOne(doc.uri).then(() => this.persistSoon());
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

  private async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.indexUri);
      const data = JSON.parse(new TextDecoder().decode(bytes)) as SerializedRepoMap;
      if (data.version === 1) this.entries = new Map(Object.entries(data.entries));
    } catch {
      // no map yet
    }
  }

  private persistSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 3_000);
  }

  private async persist(): Promise<void> {
    const data: SerializedRepoMap = { version: 1, entries: Object.fromEntries(this.entries) };
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
      const extraIgnores = await this.readHeapCodeIgnore();
      const files = await vscode.workspace.findFiles('**/*', IGNORE_GLOB, MAX_FILES);
      const existing = new Set<string>();
      for (const file of files) {
        const rel = vscode.workspace.asRelativePath(file, false);
        if (!CODE_EXTENSIONS.test(rel)) continue;
        if (extraIgnores.some((p) => rel.startsWith(p))) continue;
        existing.add(rel);
        await this.indexOne(file);
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

  private async indexOne(uri: vscode.Uri): Promise<void> {
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

    const symbols = await extractSymbols(rel, content);
    this.entries.set(rel, { hash, symbols });
  }

  /** Formatted outline for the repo_map tool, optionally scoped to a path prefix. */
  format(pathPrefix?: string): string {
    const entries = [...this.entries.entries()].map(([path, e]) => ({ path, symbols: e.symbols }));
    return formatRepoMap(entries, { pathPrefix });
  }

  private async readHeapCodeIgnore(): Promise<string[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return [];
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.heapcodeignore'));
      return new TextDecoder()
        .decode(bytes)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.replace(/^\/+/, '').replace(/\/+$/, ''));
    } catch {
      return [];
    }
  }
}
