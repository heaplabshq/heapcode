import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RpcPeer } from '@heapcode/core';
import { listFolders, type HostSession } from '@heapcode/web-host';
import { ChatSession, type ChatSessionDeps } from '@heapcode/chat-host';
import { noteHits, notesPersona } from './ask.js';
import { zip } from './zip.js';
import { importNotion } from './notion.js';
import { bulkAction, mergeNotes, type BulkAction } from './bulk.js';
import { TEMPLATE_TAG, fillTemplate } from './templates.js';
import { closeEnough, relatedNotes } from './related.js';
import { cleanInline, inlineMessages } from './inline.js';
import { NoteError } from './errors.js';
import { importBear, importBearExport, importMarkdownFolder, importObsidian } from './importers.js';
import { formatTag } from './parse.js';
import {
  NOTES_METHODS,
  NOTES_PROTOCOL_VERSION,
  type InlineRequest,
  type NoteListItem,
  type NoteOpenResult,
  type NoteSaveResult,
  type NotesImportKind,
  type NotesListParams,
  type NotesState,
} from './protocol.js';
import {
  DEFAULT_AI_HIDDEN_TAGS,
  defaultVaultRoot,
  readNotesSettings,
  writeNotesSettings,
} from './settings.js';
import { Vault, type NoteRef } from './vault.js';
import { pendingFocus } from './focus.js';

export interface NotesSessionDeps {
  /** The URL prefix it's mounted at, e.g. `/notes`, for the image URLs it hands out. */
  basePath: string;
  /** Which vault to open. Default: the one `heapcode notes` uses. */
  vault?: string;
  /** Tests pass `:memory:`. */
  indexFile?: string;
  /**
   * Models and connections for "Ask your notes" — what `heapcode web` gives
   * Heap Chat. Without it the page simply has no Ask panel.
   */
  ai?: Omit<ChatSessionDeps, 'root' | 'persona' | 'basePath'>;
}

/** How long a title has to stay the same before the file is renamed to match. */
const TITLE_SETTLE_MS = 4_000;

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
  /** The open vault, once it is — the assistant's tools need it synchronously. */
  private current: Vault | undefined;
  /** The assistant's view of it, with the hidden tags scoped out. */
  private aiView: Vault | undefined;
  /** Ask over one tag: its questions see only notes with it (and subtags). */
  private askTag: string | undefined;
  private tagView: Vault | undefined;
  /** "Ask your notes": Heap Chat's session with the notes persona. */
  private readonly ask: ChatSession | undefined;
  private reindexTimer: ReturnType<typeof setTimeout> | undefined;
  /** Title changes waiting to settle, by note id: the title before the edits began. */
  private readonly titleSettles = new Map<
    string,
    { from: string; timer: ReturnType<typeof setTimeout> }
  >();
  /** The note Ask's questions are about, as the page last said. */
  private askAboutId: string | undefined;
  /** ⌘J requests in flight, so Discard can stop the model. */
  private readonly inlineRuns = new Map<string, AbortController>();

  constructor(private readonly deps: NotesSessionDeps) {
    const root = deps.vault ?? defaultVaultRoot();
    this.vault = this.openingVault(root);
    this.ask = deps.ai
      ? new ChatSession({
          ...deps.ai,
          root,
          basePath: deps.basePath,
          persona: notesPersona({
            vault: () => this.askVault(),
            scopeTag: () => this.askTag,
            hiddenTags: () => this.hiddenTags(),
            hiddenPaths: () => this.hiddenPaths(),
            openNote: () => this.askAboutId,
            autoApply: () => readNotesSettings().autoApply === true,
          }),
        })
      : undefined;
  }

  /**
   * Open a vault, marked as handled from the start. Nothing awaits it until a
   * request arrives, and an unhandled rejection ends the whole process — so a
   * vault that can't open (no built-in SQLite on this Node) took Heap Code
   * down with it. Each request that needs it still gets the reason.
   */
  private openingVault(root: string): Promise<Vault> {
    const opening = this.openVault(root);
    opening.catch(() => undefined);
    return opening;
  }

  private async openVault(root: string): Promise<Vault> {
    const vault = await Vault.open({
      root,
      ...(this.deps.indexFile ? { indexFile: this.deps.indexFile } : {}),
    });
    this.unsubscribe = vault.onChange((ids) => {
      for (const peer of this.peers) peer.notify(NOTES_METHODS.changed, { ids });
      this.scheduleReindex();
    });
    this.watch(vault);
    this.current = vault;
    this.aiView = undefined;
    this.tagView = undefined;
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
    // Heap Chat's chat/* methods on the same socket: the Ask panel.
    this.ask?.attach(ui);
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
    on(NOTES_METHODS.inline, async (p) => {
      if (!this.ask) throw new Error('No model is connected.');
      const req = p as unknown as InlineRequest;
      // Hidden from AI means hidden from this too, whoever asked.
      if (
        !(await this.assistantVault()
          .get({ id: req.id })
          .catch(() => undefined))
      ) {
        throw new Error(
          `This note is tagged ${this.hiddenTags()
            .map((t) => `#${t}`)
            .join(' or ')}, which keeps AI out of it.`,
        );
      }
      const abort = new AbortController();
      this.inlineRuns.set(req.requestId, abort);
      try {
        const { text } = await this.ask.complete(inlineMessages(req), {
          role: 'edit',
          temperature: req.action === 'fix' ? 0 : 0.4,
          signal: abort.signal,
          onText: (chunk) =>
            ui.notify(NOTES_METHODS.inlineText, { requestId: req.requestId, chunk }),
        });
        return { text: cleanInline(text, req.selection) };
      } finally {
        this.inlineRuns.delete(req.requestId);
      }
    });
    on(NOTES_METHODS.askAbout, async (p) => {
      this.askAboutId = typeof p.id === 'string' && p.id ? p.id : undefined;
      const tag = typeof p.tag === 'string' && p.tag ? p.tag : undefined;
      if (tag !== this.askTag) this.tagView = undefined;
      this.askTag = tag;
      return { ok: true };
    });
    on(NOTES_METHODS.inlineCancel, async (p) => {
      this.inlineRuns.get(String(p.requestId ?? ''))?.abort();
      return { ok: true };
    });
    on(NOTES_METHODS.relatedTo, async (p) => {
      const ask = this.ask;
      // Plain similarity, as for the list's search: the cut needs real scores.
      const semantic = ask
        ? (text: string) =>
            ask.semanticQuery(text, undefined, { k: 20, hybridSearch: false, rerank: false })
        : undefined;
      return relatedNotes(await v(), str(p.id), semantic, { hiddenTags: this.hiddenTags() });
    });
    on(NOTES_METHODS.related, async (p) =>
      this.related(
        await v(),
        String(p.query ?? ''),
        Array.isArray(p.exclude) ? p.exclude.map(String) : [],
      ),
    );
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
    on(NOTES_METHODS.peek, async (p) => {
      const vault = await v();
      const hit = await vault.resolveLink(str(p.target));
      if (!hit) return null;
      const read = await vault.read({ id: hit.id }, { limit: 1500 });
      return {
        id: hit.id,
        title: read.title,
        path: hit.path,
        content: read.content,
        more: read.totalLength > read.content.length,
      };
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
    on(NOTES_METHODS.deleteTag, async (p) => (await v()).deleteTag(str(p.tag)));
    on(NOTES_METHODS.bulk, async (p) =>
      bulkAction(
        await v(),
        Array.isArray(p.ids) ? p.ids.map(String) : [],
        str(p.action) as BulkAction,
        typeof p.tag === 'string' ? p.tag : undefined,
      ),
    );
    on(NOTES_METHODS.merge, async (p) => {
      const vault = await v();
      const merged = await mergeNotes(vault, Array.isArray(p.ids) ? p.ids.map(String) : []);
      return this.open(vault, { id: merged.id });
    });
    on(NOTES_METHODS.attach, async (p) => {
      const data = Buffer.from(str(p.base64), 'base64');
      return (await v()).saveAttachmentFile({ id: str(p.id) }, str(p.filename), data);
    });
    on(NOTES_METHODS.import, async (p) => {
      const vault = await v();
      const kind = p.kind as NotesImportKind;
      const path = typeof p.path === 'string' && p.path ? p.path : undefined;
      if (kind === 'bear') return path ? importBearExport(vault, path) : importBear(vault);
      if (kind === 'notion') {
        if (!path)
          throw new NoteError('invalid_argument', 'Pick the .zip Notion exported, or its folder.');
        return importNotion(vault, path);
      }
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
    on(NOTES_METHODS.browseFolders, async (p) => {
      const listing = await listFolders(typeof p.path === 'string' ? p.path : undefined);
      if (p.zips !== true) return listing;
      // Notion's export is a .zip: list those too, so it can be picked as it is.
      const zips = (await readdir(listing.path, { withFileTypes: true }).catch(() => []))
        .filter((d) => d.isFile() && /\.zip$/i.test(d.name) && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: join(listing.path, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { ...listing, entries: [...listing.entries, ...zips] };
    });
    on(NOTES_METHODS.setVault, async (p) => {
      const path = resolve(str(p.path));
      const st = await stat(path).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`Not a folder: ${path}`);
      await this.closeVault();
      this.vault = this.openingVault(path);
      await this.vault;
      writeNotesSettings({ vault: path });
      // Its history, index and tools follow the vault.
      await this.ask?.setFolder(path).catch(() => undefined);
      return this.state();
    });
    on(NOTES_METHODS.templates, async () => {
      const page = await (
        await v()
      ).list({ tag: TEMPLATE_TAG, limit: 500, sort: [{ field: 'title', direction: 'asc' }] });
      return { templates: page.notes.map((n) => ({ id: n.id, title: n.title, tags: n.tags })) };
    });
    on(NOTES_METHODS.setTemplate, async (p) => {
      const vault = await v();
      const ref = { id: str(p.id) };
      return p.on === false ? vault.removeTag(ref, TEMPLATE_TAG) : vault.addTag(ref, TEMPLATE_TAG);
    });
    on(NOTES_METHODS.fromTemplate, async (p) => {
      const vault = await v();
      const template = await vault.read({ id: str(p.id) });
      const tag = typeof p.tag === 'string' && p.tag ? `\n${formatTag(p.tag)}` : '';
      const body = fillTemplate(template.content);
      // The tag you were in comes along, as it does for a plain new note.
      const lines = body.split('\n');
      const text =
        tag && !body.includes(formatTag(String(p.tag)))
          ? [lines[0], tag.slice(1), ...lines.slice(1)].join('\n')
          : body;
      return this.open(vault, { id: (await vault.createRaw(text)).id });
    });
    on(NOTES_METHODS.versions, async (p) => ({
      versions: await (await v()).versions({ id: str(p.id) }),
    }));
    on(NOTES_METHODS.version, async (p) =>
      (await v()).readVersion({ id: str(p.id) }, str(p.version)),
    );
    on(NOTES_METHODS.restoreVersion, async (p) => {
      const vault = await v();
      await vault.restoreVersion({ id: str(p.id) }, str(p.version));
      return this.open(vault, { id: str(p.id) });
    });
    on(NOTES_METHODS.exportNotes, async (p) => {
      const vault = await v();
      const id = typeof p.id === 'string' && p.id ? p.id : undefined;
      const stamp = new Date().toISOString().slice(0, 10);
      // Several notes: each with its images, in one .zip; a file two share goes in once.
      if (Array.isArray(p.ids) && p.ids.length) {
        const seen = new Map<string, { path: string; data: Buffer; modified: Date }>();
        for (const one of p.ids.map(String))
          for (const f of await vault.exportFiles({ id: one })) seen.set(f.path, f);
        return {
          filename: `${p.ids.length} notes ${stamp}.zip`,
          base64: zip([...seen.values()]).toString('base64'),
        };
      }
      const files = await vault.exportFiles(id ? { id } : undefined);
      if (id) {
        const note = await vault.get({ id });
        const name = fileName(note.title || 'Untitled');
        // A note on its own is just its file; with images, the images come too.
        if (files.length === 1)
          return { filename: `${name}.md`, base64: files[0]!.data.toString('base64') };
        return { filename: `${name}.zip`, base64: zip(files).toString('base64') };
      }
      const folder = fileName(vault.root.split(/[\\/]/).pop() || 'Notes');
      return {
        filename: `${folder} ${stamp}.zip`,
        base64: zip(files.map((f) => ({ ...f, path: `${folder}/${f.path}` }))).toString('base64'),
      };
    });
    on(NOTES_METHODS.saveSettings, async (p) => {
      if (typeof p.fontSize === 'number' && p.fontSize >= 10 && p.fontSize <= 32)
        writeNotesSettings({ fontSize: Math.round(p.fontSize) });
      if (typeof p.autoApply === 'boolean') writeNotesSettings({ autoApply: p.autoApply });
      if (Array.isArray(p.aiHiddenTags)) {
        writeNotesSettings({
          aiHiddenTags: p.aiHiddenTags
            .map((t) => String(t).replace(/^#|#$/g, '').trim())
            .filter(Boolean),
        });
        this.aiView = undefined;
        this.tagView = undefined;
        this.lastHidden = '';
        await this.pushHiddenPaths().catch(() => undefined);
      }
      return this.state();
    });
  }

  detach(ui: RpcPeer): void {
    this.peers.delete(ui);
    this.ask?.detach(ui);
    if (this.peers.size === 0) this.stopFocusPoll();
  }

  async close(): Promise<void> {
    for (const id of [...this.titleSettles.keys()]) await this.settleTitle(id);
    this.stopFocusPoll();
    clearTimeout(this.reindexTimer);
    await this.ask?.close();
    await this.closeVault();
  }

  /**
   * Keep Ask's meaning search current: a few seconds after notes stop
   * changing, re-embed what changed. Debounced, because a note being typed
   * saves every half second.
   */
  private scheduleReindex(): void {
    if (!this.ask) return;
    clearTimeout(this.reindexTimer);
    this.reindexTimer = setTimeout(() => {
      // The hidden list first: a note just tagged #private must leave the
      // index before the refresh, never be re-embedded by it.
      void this.pushHiddenPaths()
        .then(() => this.ask?.refreshIndex())
        .catch(() => undefined);
    }, 5_000);
  }

  /** Every note (any location) carrying a hidden tag, by vault path. */
  private async hiddenPaths(): Promise<string[]> {
    const vault = await this.vault;
    const paths = new Set<string>();
    for (const tag of this.hiddenTags()) {
      for (const n of (await vault.list({ tag, location: 'all', limit: 1_000_000 })).notes)
        paths.add(n.path);
    }
    return [...paths].sort();
  }

  private lastHidden = '';

  /** Tell the index which notes are hidden, when that changed. */
  private async pushHiddenPaths(): Promise<void> {
    if (!this.ask) return;
    const paths = await this.hiddenPaths();
    const key = paths.join('\n');
    if (key === this.lastHidden) return;
    this.lastHidden = key;
    await this.ask.setIndexExclude(paths);
  }

  /** (Re)start a note's settle timer, keeping the title it had before the first change. */
  private settleLater(id: string, before: string): void {
    const pending = this.titleSettles.get(id);
    if (pending) clearTimeout(pending.timer);
    const from = pending?.from ?? before;
    this.titleSettles.set(id, {
      from,
      timer: setTimeout(() => void this.settleTitle(id), TITLE_SETTLE_MS),
    });
  }

  /** Rename the file and fix links for a title that has stopped changing; tell the page. */
  private async settleTitle(id: string): Promise<void> {
    const pending = this.titleSettles.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.titleSettles.delete(id);
    const vault = await this.vault.catch(() => undefined);
    if (!vault) return;
    const done = await vault.settleTitle({ id }, pending.from).catch(() => undefined);
    if (!done) return;
    for (const peer of this.peers)
      peer.notify(NOTES_METHODS.changed, { ids: [id, ...done.relinked] });
  }

  private hiddenTags(): string[] {
    return readNotesSettings().aiHiddenTags ?? DEFAULT_AI_HIDDEN_TAGS;
  }

  /** What Ask sees: the assistant's vault, narrowed to one tag when asked over it. */
  private askVault(): Vault {
    if (!this.askTag) return this.assistantVault();
    this.tagView ??= this.current!.scoped(
      { excludeTags: this.hiddenTags(), onlyTags: [this.askTag] },
      'ask',
    );
    return this.tagView;
  }

  /** The vault as the assistant sees it: hidden tags scoped out. */
  private assistantVault(): Vault {
    if (!this.current)
      throw new NoteError('io', 'The notes are still opening; try again in a moment.');
    this.aiView ??= this.current.scoped({ excludeTags: this.hiddenTags() }, 'ask');
    return this.aiView;
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
    const vault = await this.vault.catch(() => undefined);
    if (!vault) return undefined;
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
    this.current = undefined;
    this.aiView = undefined;
    this.tagView = undefined;
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
      aiHiddenTags: this.hiddenTags(),
      autoApply: readNotesSettings().autoApply === true,
      ask: Boolean(this.ask),
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

  /**
   * "Related by meaning" for the note list (HEAPNOTES_PHASE2_PLAN §2B): the
   * index's closest passages, one row per note, best first, minus notes the
   * keyword search already listed. The person's own view — nothing is hidden
   * here; the hidden tags only apply to the assistant.
   */
  private async related(vault: Vault, query: string, exclude: string[]): Promise<NoteListItem[]> {
    if (!this.ask || query.trim().length < 3) return [];
    // Plain similarity, no keyword fusion or reranking: fusion scores are only
    // ranks, and the list needs "how close", to leave out the merely nearest.
    const formatted = await this.ask
      .semanticQuery(query, undefined, { k: 20, hybridSearch: false, rerank: false })
      .catch(() => '');
    if (!formatted) return [];
    const skip = new Set(exclude);
    const out: NoteListItem[] = [];
    for (const hit of closeEnough(await noteHits(vault, formatted))) {
      if (skip.has(hit.note.id) || hit.note.location !== 'notes') continue;
      skip.add(hit.note.id);
      out.push({
        ...hit.note,
        snippet: hit.passage.replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 160),
      });
      if (out.length >= 8) break;
    }
    return out;
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
      ...(note.source ? { source: note.source } : {}),
    };
  }

  private async save(
    vault: Vault,
    id: string,
    content: string,
    base: string | undefined,
  ): Promise<NoteSaveResult> {
    this.scheduleReindex();
    try {
      const before = await vault.get({ id });
      // Saved every half second while typing: renaming on each save would
      // walk the file through every partial title, rewriting every link to
      // it each time. The rename waits until the title has settled.
      const note = await vault.overwrite({ id }, content, {
        ...(base ? { base } : {}),
        deferRename: true,
      });
      if (note.title !== before.title || this.titleSettles.has(id))
        this.settleLater(id, before.title);
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

/** A title as a file name anywhere: no path separators or characters Windows refuses. */
function fileName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .trim()
      .slice(0, 120) || 'Untitled'
  );
}
