import * as vscode from 'vscode';
import { DEFAULT_IGNORE_GLOB, parserForPath } from '@heapcode/core';
import {
  formatRankingDebug,
  MAX_INDEXED_FILES,
  REPO_MAP_FILE,
  RepoMapIndexer as RepoMapIndex,
  type FileSource,
  type RepoMapStore,
} from '@heapcode/repomap';
import { filterIgnored } from '../ignoreFiles.js';

const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|scala|sh|sql|vue|svelte|md|yaml|yml|json|toml|html|htm|css|scss|sass|less|xml|astro|graphql|gql|proto|prisma|lua|dart|ex|exs|zig|tf|ini|conf)$/i;

/**
 * The repo map (@heapcode/repomap) wired to the workspace: findFiles +
 * workspace.fs instead of a Node filesystem, core's tree-sitter parser, and
 * the editor's own signals — saves feed the "recently edited" ranking boost,
 * open tabs feed the stronger "open" one.
 *
 * Everything here is adapter: enumeration, reads, persistence and the
 * enable setting. The index itself, its ranking and its formatting are the
 * package's, shared verbatim with the CLI.
 */
export class RepoMapIndexer implements vscode.Disposable {
  private readonly index: RepoMapIndex;
  private readonly disposables: vscode.Disposable[] = [];
  /** Workspace-relative path -> Uri, from the last enumeration — asRelativePath is not reliably invertible in a multi-root workspace, so remember rather than reconstruct. */
  private readonly uris = new Map<string, vscode.Uri>();

  constructor(
    private readonly storageDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
  ) {
    this.index = new RepoMapIndex({
      files: this.fileSource(),
      store: this.store(),
      parserFor: parserForPath,
      enabled: () => this.enabled(),
      openFiles: () => this.openFiles(),
      onLog: (line) => this.log.appendLine(`[repo-map] ${line}`),
    });
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.enabled() && CODE_EXTENSIONS.test(doc.uri.path)) {
          const rel = vscode.workspace.asRelativePath(doc.uri, false);
          this.uris.set(rel, doc.uri);
          this.index.noteRecent(rel);
          void this.index.indexOne(rel);
        }
      }),
    );
    void this.index.init();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  get ready(): boolean {
    return this.index.ready;
  }

  buildIndex(): Promise<void> {
    return this.index.buildIndex();
  }

  /**
   * Incremental updates for changes the editor never announces. Until now the
   * only trigger was onDidSaveTextDocument, which does not fire for
   * `vscode.workspace.fs.writeFile` — so the agent's own writes left the map
   * stale. The package has always had these; the wrapper simply never forwarded
   * them, unlike the CLI's adapter (packages/cli/src/rag/repoMapIndexer.ts's
   * caller in App.tsx:389-412).
   */
  indexOne(rel: string): Promise<void> {
    return this.index.indexOne(rel);
  }

  renameFile(oldRel: string, newRel: string): Promise<void> {
    return this.index.renameFile(oldRel, newRel);
  }

  removeFile(rel: string): void {
    this.index.removeFile(rel);
  }

  /** Feeds the "recently edited" ranking boost — the agent's writes count too. */
  noteRecent(rel: string): void {
    this.index.noteRecent(rel);
  }

  clear(): Promise<void> {
    return this.index.clear();
  }

  format(pathPrefix?: string): string {
    return this.index.format(pathPrefix);
  }

  /**
   * Plain-text ranking breakdown for the "Heap Code: Show Repo Map Ranking
   * (Debug)" command — every indexed file with its score components, so you
   * can see *why* it ranked where it did without going through the agent/LLM
   * at all. Not used by the agent itself; format() is what it actually sees.
   */
  debugRanking(): string {
    return formatRankingDebug({
      title: 'Heap Code repo map — ranking debug',
      ...this.index.rankingInputs(),
      openLabel: 'Open tabs',
      recentLabel: 'Recently saved',
    });
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('heapcode').get<boolean>('repoMap.enable', true);
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
    const file = vscode.Uri.joinPath(this.storageDir, REPO_MAP_FILE);
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
}
