/**
 * Minimal stand-in for the `vscode` module so extension code that imports it
 * at runtime can be unit-tested. Aliased in vitest.config.ts.
 *
 * `workspace.fs` is backed by the real Node filesystem rather than an
 * in-memory fake, deliberately: the write-path guards these tests cover are
 * about what does or doesn't reach disk, so the assertion that matters is
 * reading the file back afterwards — same fidelity as the CLI's
 * WorkspaceToolExecutor tests, which run against a real temp directory.
 *
 * Only the surface the tests actually exercise is implemented. Anything else
 * is either a no-op or absent on purpose: a missing member failing loudly is
 * better than a fake that quietly diverges from the real API.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

export class Uri {
  private constructor(
    readonly fsPath: string,
    readonly scheme: string = 'file',
  ) {}

  get path(): string {
    return this.fsPath;
  }

  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }

  static file(p: string): Uri {
    return new Uri(p);
  }

  /** Test hook: a non-`file` root, the case RAG and ShadowGit both decline. */
  static withScheme(p: string, scheme: string): Uri {
    return new Uri(p, scheme);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(nodePath.join(base.fsPath, ...segments), base.scheme);
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

/** Mirrors the real enum's values — completionProvider branches on Invoke. */
export enum InlineCompletionTriggerKind {
  Invoke = 0,
  Automatic = 1,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

let workspaceRoot: string | undefined;
let workspaceScheme = 'file';

/** Test hook: point `asRelativePath`/`workspaceFolders` at a temp directory. */
export function __setWorkspaceRoot(root: string | undefined, scheme = 'file'): void {
  workspaceRoot = root;
  workspaceScheme = scheme;
}

const configs = new Map<string, Record<string, unknown>>();

/**
 * Test hook: settings for one `getConfiguration(section)` namespace. The
 * agent controller reads a dozen `heapcode.agent.*` values, and defaulting
 * every one of them (the previous stub returned the caller's fallback
 * unconditionally) makes it impossible to test anything that a setting gates
 * — sub-agents, plan mode, the command timeout.
 */
export function __setConfig(section: string, values: Record<string, unknown>): void {
  configs.set(section, values);
}

export function __resetConfig(): void {
  configs.clear();
}

/** Recorded `showErrorMessage`/`showWarningMessage` calls, so tests can assert what the user was told. */
export const __shownMessages: string[] = [];

/**
 * Test hook: when on, `findFiles` walks the workspace root for real instead
 * of returning nothing. Off by default so existing suites keep the empty
 * result they were written against — only the index adapters call it.
 */
let walkWorkspace = false;
export function __setFindFilesWalk(enabled: boolean): void {
  walkWorkspace = enabled;
}

const didSaveListeners: Array<(doc: { uri: Uri }) => void> = [];

/** Test hook: fire `onDidSaveTextDocument`, the event both indexes update from. */
export function __fireDidSave(uri: Uri): void {
  for (const listener of [...didSaveListeners]) listener({ uri });
}

async function walk(dir: string, root: string, out: Uri[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walk(full, root, out);
    } else {
      out.push(Uri.file(full));
    }
  }
}

export const workspace = {
  get workspaceFolders(): Array<{ uri: Uri }> | undefined {
    return workspaceRoot ? [{ uri: Uri.withScheme(workspaceRoot, workspaceScheme) }] : undefined;
  },

  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      return new Uint8Array(await readFile(uri.fsPath));
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      // The real workspace.fs.writeFile creates missing parent directories.
      await mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await writeFile(uri.fsPath, content);
    },
    async stat(uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> {
      const s = await stat(uri.fsPath);
      return {
        type: s.isDirectory() ? FileType.Directory : FileType.File,
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
        size: s.size,
      };
    },
    async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
      await rm(uri.fsPath, { recursive: options?.recursive ?? true, force: true });
    },
    async rename(from: Uri, to: Uri, _options?: { overwrite?: boolean }): Promise<void> {
      await rename(from.fsPath, to.fsPath);
    },
    async createDirectory(uri: Uri): Promise<void> {
      await mkdir(uri.fsPath, { recursive: true });
    },
    async readDirectory(uri: Uri): Promise<Array<[string, FileType]>> {
      const entries = await readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
    },
  },

  asRelativePath(uri: Uri | string, _includeWorkspaceFolder?: boolean): string {
    const p = typeof uri === 'string' ? uri : uri.fsPath;
    if (!workspaceRoot) return p;
    return nodePath.relative(workspaceRoot, p).replace(/\\/g, '/');
  },

  async findFiles(): Promise<Uri[]> {
    if (!walkWorkspace || !workspaceRoot) return [];
    const out: Uri[] = [];
    await walk(workspaceRoot, workspaceRoot, out);
    return out;
  },

  onDidSaveTextDocument(listener: (doc: { uri: Uri }) => void): { dispose(): void } {
    didSaveListeners.push(listener);
    return {
      dispose() {
        const i = didSaveListeners.indexOf(listener);
        if (i >= 0) didSaveListeners.splice(i, 1);
      },
    };
  },

  getConfiguration(section = '') {
    const values = configs.get(section) ?? {};
    return {
      get: <T>(key: string, fallback?: T) => (key in values ? (values[key] as T) : fallback),
    };
  },
};

export const window = {
  terminals: [] as unknown[],
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
  /**
   * Deliberately throws. run_command tries the visible "Heap Code" terminal
   * first and falls back to a hidden child process when shell integration
   * isn't available (workspaceTools.ts:675) — throwing here is what puts the
   * tests on the child-process path, which is the one that can actually be
   * observed and killed.
   */
  createTerminal() {
    throw new Error('vscode stub: createTerminal is not implemented');
  },
  showWarningMessage(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string): Promise<undefined> {
    __shownMessages.push(message);
    return Promise.resolve(undefined);
  },
  onDidEndTerminalShellExecution() {
    return { dispose() {} };
  },
};

/** VS Code's Language Model Tools registry — empty unless a test fills it (lmTools.ts:25). */
export const lm = { tools: [] as unknown[] };

/** Installed extensions, read by lmTools.ts:59 to label contributed tools. */
export const extensions = { all: [] as unknown[] };

export const languages = {
  getDiagnostics(): unknown[] {
    return [];
  },
};

export const commands = {
  executeCommand(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
};
