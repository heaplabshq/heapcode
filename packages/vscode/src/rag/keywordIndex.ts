import * as vscode from 'vscode';
import { DEFAULT_IGNORE_GLOB, KeywordIndex as KeywordIdx, KEYWORD_INDEX_FILE } from '@heapcode/core';
import { CODE_EXTENSIONS, MAX_INDEXED_FILES, type FileSource, type RepoMapStore } from '@heapcode/repomap';
import { filterIgnored } from '../ignoreFiles.js';

export type { KeywordIndex } from '@heapcode/core';

/**
 * The vector-free keyword index (@heapcode/core) wired to the workspace.
 *
 * It exists for ghost text's typing trigger, which retrieves repo context
 * inside the debounce window and so cannot afford a socket round-trip once
 * the semantic index lives in the server (docs/phase3-rag-design.md §2.3 and
 * open question 1). It needs no embeddings model and makes no model calls, so
 * unlike the semantic index it is useful the moment a workspace opens.
 *
 * Same adapter shape as repoMapIndexer.ts and rag/indexer.ts: findFiles +
 * workspace.fs behind a FileSource, workspace storage behind a store, and the
 * editor's own save events driving incremental updates — the same trigger
 * that already drives the other two indexes.
 */
export class WorkspaceKeywordIndex implements vscode.Disposable {
  private readonly index: KeywordIdx;
  private readonly disposables: vscode.Disposable[] = [];
  /** Workspace-relative path -> Uri from the last enumeration — asRelativePath is not reliably invertible in a multi-root workspace. */
  private readonly uris = new Map<string, vscode.Uri>();

  constructor(
    private readonly storageDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
  ) {
    this.index = new KeywordIdx({
      files: this.fileSource(),
      store: this.store(),
      onLog: (line) => this.log.appendLine(`[rag] ${line}`),
    });
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (CODE_EXTENSIONS.test(doc.uri.path)) {
          const rel = vscode.workspace.asRelativePath(doc.uri, false);
          this.uris.set(rel, doc.uri);
          void this.index.indexOne(rel);
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  init(): Promise<void> {
    return this.index.init();
  }

  buildIndex(): Promise<{ files: number; chunks: number } | undefined> {
    return this.index.buildIndex();
  }

  get inner(): KeywordIdx {
    return this.index;
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
    const file = vscode.Uri.joinPath(this.storageDir, KEYWORD_INDEX_FILE);
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
