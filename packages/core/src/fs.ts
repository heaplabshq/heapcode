/**
 * The filesystem seams the shared agent subsystems are written against.
 *
 * Neither host can hand core a filesystem directly: the CLI has Node's
 * `fs/promises` and plain string paths, the extension has
 * `vscode.workspace.fs` and `Uri`s that may not even be local (a remote or
 * virtual workspace). These are the narrowest shapes that both can satisfy,
 * following the pattern `packages/repomap` already established for its own
 * store — a couple of methods, no path arithmetic, no stat, no streaming.
 *
 * Node hosts can use the ready-made adapters in `./node/fs.js` rather than
 * writing their own.
 */

/** A single text file, read and written whole. */
export interface TextFileStore {
  /** undefined when the file is absent or unreadable — never throws for that. */
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * A directory tree addressed by '/'-separated paths relative to a root the
 * host owns. Keeping paths relative (and the root private to the adapter) is
 * what lets the extension stay on `Uri.joinPath` and keep working in a
 * non-file-scheme workspace, where reconstructing an absolute path would be
 * wrong.
 */
export interface FileTree {
  /** undefined when the file is absent or unreadable — never throws for that. */
  readFile(rel: string): Promise<string | undefined>;
  writeFile(rel: string, text: string): Promise<void>;
  /** Empty when the directory is absent or unreadable — never throws for that. */
  readDirectory(rel: string): Promise<DirectoryEntry[]>;
}

/**
 * Byte-level access to arbitrary files, addressed by whatever handle the host
 * natively uses (`P` is a string path in the CLI, a `vscode.Uri` in the
 * extension). Used where content is not necessarily text and the paths come
 * from the host rather than from core — see SessionCheckpoint.
 */
export interface FileHandles<P> {
  /** undefined when the file is absent or unreadable — never throws for that. */
  read(path: P): Promise<Uint8Array | undefined>;
  write(path: P, bytes: Uint8Array): Promise<void>;
  /** Deleting something already gone is success, not an error. */
  delete(path: P): Promise<void>;
  /** A stable identity for `path`, for use as a map key. */
  key(path: P): string;
  /** `path` as a workspace-relative, '/'-separated string. */
  relative(path: P): string;
}
