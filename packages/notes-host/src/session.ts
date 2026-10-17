import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { RpcPeer } from '@heapcode/core';
import { listFolders, type HostSession } from '@heapcode/web-host';
import { NoteError } from './errors.js';
import { importBear, importBearExport, importMarkdownFolder, importObsidian } from './importers.js';
import { formatTag } from './parse.js';
import {
  NOTES_METHODS,
  NOTES_PROTOCOL_VERSION,
  type NoteOpenResult,
  type NoteSaveResult,
  type NotesImportKind,
  type NotesListParams,
  type NotesState,
} from './protocol.js';
import { defaultVaultRoot, readNotesSettings, writeNotesSettings } from './settings.js';
import { Vault, type NoteRef } from './vault.js';
import { pendingFocus } from './focus.js';

export interface NotesSessionDeps {
  /** The URL prefix it's mounted at, e.g. `/notes`, for the image URLs it hands out. */
  basePath: string;
  /** Which vault to open. Default: the one `heapcode notes` uses. */
  vault?: string;
  /** Tests pass `:memory:`. */
  indexFile?: string;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

/**
 * Heapnotes in `heapcode web`: the page's requests, answered from a Vault.
 *
 * Everything the page does goes through the same Vault methods the CLI and
 * the MCP server use, so a note saved here follows the same rules — rename
 * keeps links, a stale save is refused — wherever it is edited next. The vault
 * folder is watched, so an edit made in another app shows up here.
 */
export class NotesSession implements HostSession {
  private readonly peers = new Set<RpcPeer>();
  private vault: Promise<Vault>;
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private focusPoll: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: NotesSessionDeps) {
    this.vault = this.openVault(deps.vault ?? defaultVaultRoot());
  }

  private async openVault(root: string): Promise<Vault> {
    const vault = await Vault.open({
      root,
      ...(this.deps.indexFile ? { indexFile: this.deps.indexFile } : {}),
    });
    this.unsubscribe = vault.onChange((ids) => {
      for (const peer of this.peers) peer.notify(NOTES_METHODS.changed, { ids });
    });
    this.watch(vault);
    return vault;
  }

  private watch(vault: Vault): void {
    try {
      this.watcher = watch(vault.root, { recursive: true }, (_event, file) => {
        const name = String(file ?? '');
        // Our own temp files, and the folders a vault never holds notes in.
        if (/\.tmp$/.test(name) || /(^|[\\/])\.(?!trash)/.test(name)) return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void vault.refresh(true), 250);
      });
    } catch {
      // No recursive watch here: edits from other apps show up on the next read.
    }
  }

  attach(ui: RpcPeer): void {
    this.peers.add(ui);
    // open_note from an MCP server: a file in the vault's state folder, read
    // three times a second while a page is here to show the note.
    this.focusPoll ??= setInterval(() => void this.checkFocus(), 300);
    const v = () => this.vault;
    const on = (method: string, fn: (p: Record<string, unknown>) => Promise<unknown>) =>
      ui.onRequest(method, (raw) => fn((raw ?? {}) as Record<string, unknown>));

    on(NOTES_METHODS.hello, async () => ({
      version: NOTES_PROTOCOL_VERSION,
      state: await this.state(),
    }));
    on(NOTES_METHODS.list, async (p) => this.list(await v(), p as NotesListParams));
    on(NOTES_METHODS.tags, async () => (await v()).tags());
    on(NOTES_METHODS.titles, async () =>
      (
        await (
          await v()
        ).list({ limit: 1_000_000, sort: [{ field: 'modified', direction: 'desc' }] })
      ).notes.map((n) => ({ id: n.id, title: n.title, tags: n.tags })),
    );
    on(NOTES_METHODS.open, async (p) => this.open(await v(), { id: str(p.id) }));
    on(NOTES_METHODS.save, async (p) =>
      this.save(
        await v(),
        str(p.id),
        String(p.content ?? ''),
        typeof p.base === 'string' ? p.base : undefined,
      ),
    );
    on(NOTES_METHODS.create, async (p) => {
      const tag = typeof p.tag === 'string' && p.tag ? p.tag : undefined;
      // Bear's new note: an empty title line, the cursor on it, and the tag you were in.
      const text = typeof p.text === 'string' ? p.text : `# \n${tag ? `${formatTag(tag)}\n` : ''}`;
      return this.open(await v(), { id: (await (await v()).createRaw(text)).id });
    });
    on(NOTES_METHODS.followLink, async (p) => {
      const vault = await v();
      const target = str(p.target);
      const hit = await vault.resolveLink(target);
      const id = hit?.id ?? (await vault.create({ title: target.replace(/#.*$/, '').trim() })).id;
      return this.open(vault, { id });
    });
    on(NOTES_METHODS.pin, async (p) => (await v()).pin({ id: str(p.id) }, p.pinned !== false));
    on(NOTES_METHODS.archive, async (p) => (await v()).archive({ id: str(p.id) }));
    on(NOTES_METHODS.trash, async (p) => (await v()).trash({ id: str(p.id) }));
    on(NOTES_METHODS.restore, async (p) => (await v()).restore({ id: str(p.id) }));
    on(NOTES_METHODS.deleteForever, async (p) => {
      await (await v()).deletePermanently({ id: str(p.id) });
      return { ok: true };
    });
    on(NOTES_METHODS.emptyTrash, async () => (await v()).emptyTrash());
    on(NOTES_METHODS.duplicate, async (p) =>
      this.open(await v(), { id: (await (await v()).duplicate({ id: str(p.id) })).id }),
    );
    on(NOTES_METHODS.renameTag, async (p) => (await v()).renameTag(str(p.from), str(p.to)));
    on(NOTES_METHODS.attach, async (p) => {
      const data = Buffer.from(str(p.base64), 'base64');
      return (await v()).saveAttachmentFile({ id: str(p.id) }, str(p.filename), data);
    });
    on(NOTES_METHODS.import, async (p) => {
      const vault = await v();
      const kind = p.kind as NotesImportKind;
      const path = typeof p.path === 'string' && p.path ? p.path : undefined;
      if (kind === 'bear') return path ? importBearExport(vault, path) : importBear(vault);
      if (!path) throw new NoteError('invalid_argument', 'Pick the folder to import.');
      return kind === 'obsidian' ? importObsidian(vault, path) : importMarkdownFolder(vault, path);
    });
    on(NOTES_METHODS.workspaces, async () => {
      const root = (await v()).root;
      return {
        current: root,
        recent: [{ path: root, name: root.split(/[\\/]/).pop() || root, lastOpened: Date.now() }],
        home: homedir(),
      };
    });
    on(NOTES_METHODS.browseFolders, async (p) =>
      listFolders(typeof p.path === 'string' ? p.path : undefined),
    );
    on(NOTES_METHODS.setVault, async (p) => {
      const path = resolve(str(p.path));
      const st = await stat(path).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`Not a folder: ${path}`);
      await this.closeVault();
      this.vault = this.openVault(path);
      await this.vault;
      writeNotesSettings({ vault: path });
      return this.state();
    });
    on(NOTES_METHODS.saveSettings, async (p) => {
      if (typeof p.fontSize === 'number' && p.fontSize >= 10 && p.fontSize <= 32)
        writeNotesSettings({ fontSize: Math.round(p.fontSize) });
      return this.state();
    });
  }

  detach(ui: RpcPeer): void {
    this.peers.delete(ui);
    if (this.peers.size === 0) this.stopFocusPoll();
  }

  async close(): Promise<void> {
    this.stopFocusPoll();
    await this.closeVault();
  }

  private stopFocusPoll(): void {
    clearInterval(this.focusPoll);
    this.focusPoll = undefined;
  }

  private async checkFocus(): Promise<void> {
    if (this.peers.size === 0) return;
    const vault = await this.vault.catch(() => undefined);
    const req = vault && pendingFocus(vault.root);
    if (!req) return;
    for (const peer of this.peers) peer.notify(NOTES_METHODS.focus, { id: req.id });
    req.markShown();
  }

  /** `<base>/attachment/<vault-relative path>`: an image or file a note shows. */
  async attachment(id: string): Promise<{ bytes: Buffer; mediaType: string } | undefined> {
    const vault = await this.vault;
    const bytes = await vault.readVaultFile(id);
    if (!bytes) return undefined;
    const ext = id.split('.').pop()?.toLowerCase() ?? '';
    return { bytes, mediaType: MIME[ext] ?? 'application/octet-stream' };
  }

  private async closeVault(): Promise<void> {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
    this.unsubscribe?.();
    const vault = await this.vault.catch(() => undefined);
    vault?.close();
  }

  private async state(): Promise<NotesState> {
    const vault = await this.vault;
    const { total } = await vault.list({ limit: 0 });
    return {
      vault: vault.root,
      count: total,
      fontSize: readNotesSettings().fontSize ?? 16,
      attachmentBase: `${this.deps.basePath}/attachment/`,
    };
  }

  private async list(vault: Vault, p: NotesListParams) {
    const location =
      p.section === 'archive' ? 'archive' : p.section === 'trash' ? 'trash' : 'notes';
    const sort = p.sort
      ? [{ field: p.sort, direction: p.sort === 'title' ? ('asc' as const) : ('desc' as const) }]
      : undefined;
    const page = { location, limit: 2000, ...(sort ? { sort } : {}) } as const;
    if (p.query?.trim()) {
      const query = p.tag ? `${p.query} ${formatTag(p.tag)}` : p.query;
      return vault.search(query, page);
    }
    const section =
      p.section && !['archive', 'trash', 'all'].includes(p.section)
        ? (p.section as 'todo')
        : undefined;
    return vault.list({
      ...page,
      ...(section ? { section } : {}),
      ...(p.tag ? { tag: p.tag } : {}),
    });
  }

  private async open(vault: Vault, ref: NoteRef): Promise<NoteOpenResult> {
    const [note, read, outline, backlinks] = await Promise.all([
      vault.get(ref),
      vault.read(ref),
      vault.outline(ref),
      vault.backlinks(ref),
    ]);
    return {
      note,
      content: read.content,
      hash: read.hash,
      outline: outline.sections.map((s) => ({
        address: s.address,
        level: s.level,
        heading: s.heading,
        offset: s.offset,
      })),
      backlinks: backlinks.map((b) => ({ id: b.id, title: b.title, subtitle: b.subtitle })),
    };
  }

  private async save(
    vault: Vault,
    id: string,
    content: string,
    base: string | undefined,
  ): Promise<NoteSaveResult> {
    try {
      const note = await vault.overwrite({ id }, content, base ? { base } : {});
      return { ok: true, note, hash: note.hash };
    } catch (err) {
      if (err instanceof NoteError && err.code === 'conflict') {
        const now = await vault.read({ id });
        return { ok: false, conflict: true, content: now.content, hash: now.hash };
      }
      throw err;
    }
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new NoteError('invalid_argument', 'Missing argument.');
  return v;
}
