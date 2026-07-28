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
  private constructor(readonly fsPath: string) {}

  get path(): string {
    return this.fsPath;
  }

  get scheme(): string {
    return 'file';
  }

  toString(): string {
    return `file://${this.fsPath}`;
  }

  static file(p: string): Uri {
    return new Uri(p);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(nodePath.join(base.fsPath, ...segments));
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

let workspaceRoot: string | undefined;

/** Test hook: point `asRelativePath`/`workspaceFolders` at a temp directory. */
export function __setWorkspaceRoot(root: string | undefined): void {
  workspaceRoot = root;
}

export const workspace = {
  get workspaceFolders(): Array<{ uri: Uri }> | undefined {
    return workspaceRoot ? [{ uri: Uri.file(workspaceRoot) }] : undefined;
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

  findFiles(): Promise<Uri[]> {
    return Promise.resolve([]);
  },

  getConfiguration() {
    return { get: <T>(_section: string, fallback?: T) => fallback };
  },
};

export const window = {
  terminals: [] as unknown[],
  createTerminal() {
    throw new Error('vscode stub: createTerminal is not implemented');
  },
  showWarningMessage(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
  onDidEndTerminalShellExecution() {
    return { dispose() {} };
  },
};

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
