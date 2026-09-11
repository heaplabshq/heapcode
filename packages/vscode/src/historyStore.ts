import * as vscode from 'vscode';
import { JsonConversationStore as CoreJsonConversationStore, type TextFileStore } from '@heapcode/core';
import { conversationsFile } from '@heapcode/core/node';

const FILE_NAME = 'conversations.json';

/**
 * The shared JSON conversation store (@heapcode/core) on workspace.fs. Only
 * the file access is here; the store itself is shared with the CLI.
 */
export class JsonConversationStore extends CoreJsonConversationStore {
  constructor(uri: vscode.Uri) {
    super(uriTextFile(uri));
  }
}

/**
 * Where this window's conversations live.
 *
 * A local folder gets the same file the CLI and `heapcode web` use for that
 * project — `~/.heapcode/projects/<name>-<hash>/conversations.json` — so a
 * chat started in a terminal is there when the editor opens, and the reverse.
 * The extension had its own store under extension storage, which is why the
 * two never saw each other.
 *
 * Anything else falls back to extension storage, exactly as before. That is
 * not only the no-folder case: a workspace can be virtual or on a scheme with
 * no filesystem behind it, and there is no `~/.heapcode` to resolve there. The
 * extension keeps working with no CLI ever installed either way — nothing here
 * requires that directory to already exist.
 */
export function conversationsUri(context: vscode.ExtensionContext): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder?.scheme === 'file') return vscode.Uri.file(conversationsFile(folder.fsPath));
  return vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, FILE_NAME);
}

/** The store this window should use. */
export function createConversationStore(context: vscode.ExtensionContext): JsonConversationStore {
  return new JsonConversationStore(conversationsUri(context));
}

/**
 * Move what the extension already had into the shared file, once.
 *
 * Conversations written before this existed are under extension storage, and
 * pointing the store elsewhere would make them look deleted. They are copied
 * across by id, so nothing is duplicated, and a marker stops it running again —
 * without which a conversation deleted after migrating would come back on the
 * next window.
 *
 * Best-effort by design: a failure here must not stop the extension loading,
 * and the old file is left where it is rather than removed, so a bad migration
 * costs nothing.
 */
export async function migrateConversations(
  context: vscode.ExtensionContext,
  target: JsonConversationStore,
  log?: (line: string) => void,
): Promise<void> {
  const MARKER = 'heapcode.historyMigrated';
  if (context.workspaceState.get<boolean>(MARKER)) return;

  const legacyDir = context.storageUri ?? context.globalStorageUri;
  const legacyUri = vscode.Uri.joinPath(legacyDir, FILE_NAME);
  // Same file: nothing to move, and marking it done keeps this cheap.
  if (legacyUri.toString() === conversationsUri(context).toString()) {
    await context.workspaceState.update(MARKER, true);
    return;
  }

  try {
    const legacy = new JsonConversationStore(legacyUri);
    const existing = new Set((await target.list()).map((c) => c.id));
    let moved = 0;
    for (const meta of await legacy.list()) {
      if (existing.has(meta.id)) continue;
      const full = await legacy.get(meta.id);
      if (!full) continue;
      await target.save(full);
      moved += 1;
    }
    await context.workspaceState.update(MARKER, true);
    if (moved > 0) log?.(`[history] moved ${moved} conversation(s) into the shared history for this project`);
  } catch (err) {
    // Leave the marker unset so the next window tries again.
    log?.(`[history] could not move earlier conversations: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function uriTextFile(uri: vscode.Uri): TextFileStore {
  return {
    read: async () => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        return undefined; // first run or unreadable
      }
    },
    write: async (text) => {
      await vscode.workspace.fs.createDirectory(uri.with({ path: uri.path.replace(/\/[^/]+$/, '') }));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    },
  };
}
