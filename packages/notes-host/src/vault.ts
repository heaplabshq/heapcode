import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { projectStateDir } from '@heapcode/core/node';
import { NoteError } from './errors.js';
import { readFrontMatter, updateFrontMatter } from './frontMatter.js';
import { NoteIndex, linkKey, type ListOptions, type Location, type NoteRecord, type NoteRow, type SortField, type Visibility } from './noteIndex.js';
import { formatTag, lines, normalizeTagName, parseNote, type ParsedNote } from './parse.js';
import { parseQuery } from './query.js';
import { contentHash, findSection, outline, type Section } from './sections.js';

/**
 * A Heapnotes vault: a folder of `.md` files, plus an index built from them.
 *
 * Metadata lives in each note's front matter (`id`, `created`, `pinned`,
 * `archived`, `trashed`); the trash is a `.trash/` folder that mirrors the
 * vault's layout; attachments sit in an `assets/` folder beside the note.
 * Nothing else is needed to read a vault, so
 * Obsidian, an editor or Finder can open the same folder.
 *
 * Every offset and every hash a caller sees is over the note's *body* — the
 * text after the front matter — so pinning a note doesn't invalidate a hash an
 * agent is holding.
 */
export interface VaultOptions {
  root: string;
  /** The index database. Defaults to this vault's folder under ~/.heapcode/projects/. */
  indexFile?: string;
  /** Hide notes from this caller by tag (§8.5): the MCP's trust boundary. */
  scope?: Visibility;
  now?: () => Date;
  /** How old the index may be before a read rescans the folder. Default 1s. */
  staleMs?: number;
}

export interface NoteSummary {
  id: string;
  title: string;
  subtitle: string;
  /** Vault-relative, `/`-separated. */
  path: string;
  location: Location;
  tags: string[];
  pinned: boolean;
  created: string;
  modified: string;
  todos: number;
  done: number;
  hasImages: boolean;
  hasFiles: boolean;
  hasCode: boolean;
  words: number;
  length: number;
  /** The receipt for `base` on a write. */
  hash: string;
  snippet?: string;
}

/** A note by `id`, vault-relative `path`, or `title` (case-insensitive; must be unique). */
export type NoteRef = { id: string } | { path: string } | { title: string };

export interface ReadResult {
  id: string;
  title: string;
  content: string;
  /** Hash of what was read: the whole body, or the section. */
  hash: string;
  /** Characters in the whole body. */
  totalLength: number;
  offset: number;
  section?: { address: string; offset: number; length: number };
}

export interface ListArgs {
  location?: Location | 'all';
  /** Bear's smart sections (§3). `today` is notes modified today. */
  section?: 'all' | 'untagged' | 'todo' | 'today' | 'pinned';
  tag?: string;
  sort?: { field: SortField; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export interface WriteGuard {
  /** A hash from a read. The write is refused if what it covers changed since. */
  base?: string;
  section?: string;
  /** Which match, when a section address repeats. */
  index?: number;
}

export interface EditArgs extends WriteGuard {
  find: string;
  replace?: string;
  insertBefore?: string;
  insertAfter?: string;
  delete?: boolean;
  /** Apply to every match instead of requiring exactly one. */
  all?: boolean;
  /** 1-based: apply to this match only. */
  occurrence?: number;
}

export interface Attachment {
  filename: string;
  /** Vault-relative. */
  path: string;
  size: number;
  image: boolean;
}

const TRASH = '.trash';
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif)$/i;

export class Vault {
  readonly root: string;
  private readonly index: NoteIndex;
  private readonly scope: Visibility;
  private readonly now: () => Date;
  private readonly staleMs: number;
  private lastRefresh = 0;
  private closed = false;
  private refreshing: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Non-note files by lowercase basename, for Obsidian's `![[file.png]]`. */
  private filesByName = new Map<string, string[]>();

  private constructor(opts: VaultOptions, index: NoteIndex) {
    this.root = resolve(opts.root);
    this.index = index;
    this.scope = {
      onlyTags: (opts.scope?.onlyTags ?? []).map(tagKey).filter(Boolean),
      excludeTags: (opts.scope?.excludeTags ?? []).map(tagKey).filter(Boolean),
    };
    this.now = opts.now ?? (() => new Date());
    this.staleMs = opts.staleMs ?? 1000;
  }

  static async open(opts: VaultOptions): Promise<Vault> {
    const root = resolve(opts.root);
    await mkdir(root, { recursive: true });
    const indexFile = opts.indexFile ?? join(projectStateDir(root), 'notes-index.db');
    const vault = new Vault(opts, NoteIndex.open(indexFile));
    await vault.refresh(true);
    return vault;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.index.close();
  }

  // ── Indexing ────────────────────────────────────────────────────────────

  /**
   * Bring the index up to date with the folder: re-read changed files, drop
   * deleted ones. Cheap when nothing changed (a stat per file), and throttled
   * by `staleMs` so a burst of reads costs one scan.
   */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.lastRefresh < this.staleMs) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan().finally(() => {
      this.refreshing = undefined;
      this.lastRefresh = Date.now();
    });
    return this.refreshing;
  }

  /** Throw the index away and build it again from the files. */
  async rebuild(): Promise<{ notes: number }> {
    this.index.transaction(() => {
      for (const path of this.index.fingerprints().keys()) this.index.remove(path);
    });
    await this.refresh(true);
    return { notes: this.index.fingerprints().size };
  }

  private async scan(): Promise<void> {
    const { notes, files } = await walk(this.root);
    this.filesByName = new Map();
    for (const f of files) {
      const key = posix.basename(f).toLowerCase();
      this.filesByName.set(key, [...(this.filesByName.get(key) ?? []), f]);
    }
    const known = this.index.fingerprints();
    const changed: { path: string; text: string; mtime: number; size: number; birth: number }[] = [];
    for (const [path, st] of notes) {
      const fp = known.get(path);
      if (fp && fp.mtime === st.mtime && fp.size === st.size) continue;
      try {
        changed.push({ path, text: await readFile(this.abs(path), 'utf8'), ...st });
      } catch {
        // Gone between the listing and the read; the next scan settles it.
      }
    }
    const removed = [...known.keys()].filter((p) => !notes.has(p));
    if (changed.length === 0 && removed.length === 0) return;

    const takenIds = new Map<string, string>();
    for (const [path, fp] of known) if (notes.has(path) && !changed.some((c) => c.path === path)) takenIds.set(fp.id, path);
    this.index.transaction(() => {
      for (const path of removed) this.index.remove(path);
      for (const c of changed) {
        const entry = this.entryFor(c.path, c.text, c);
        // A copied file brings its twin's id along; the copy is the one that yields.
        const owner = takenIds.get(entry.record.id);
        if (owner && owner !== c.path) entry.record.id = derivedId(c.path);
        takenIds.set(entry.record.id, c.path);
        this.index.upsert(entry.record, entry.extras);
      }
    });
  }

  private entryFor(path: string, text: string, st: { mtime: number; size: number; birth: number }) {
    const parsed = parseNote(text);
    const fm = parsed.frontMatter;
    const stem = posix.basename(path).replace(/\.md$/i, '');
    const location: Location = path.startsWith(`${TRASH}/`) ? 'trash' : fm.archived === true ? 'archive' : 'notes';
    const tags = new Map<string, string>();
    for (const t of [...parsed.tags.map((t) => t.name), ...frontMatterTags(fm)]) {
      const key = tagKey(t);
      if (key && !tags.has(key)) tags.set(key, t);
    }
    const files = new Set<string>();
    for (const l of parsed.localLinks) {
      const p = posix.normalize(posix.join(posix.dirname(path), l.path));
      if (!p.startsWith('..')) files.add(p);
    }
    const links: { target: string; heading?: string }[] = [];
    for (const w of parsed.wikiLinks) {
      const asFile = w.embed && /\.[a-z0-9]{1,5}$/i.test(w.target) && !/\.md$/i.test(w.target);
      if (asFile) {
        const hit = this.filesByName.get(posix.basename(w.target).toLowerCase())?.[0];
        if (hit) files.add(hit);
      } else {
        links.push({ target: w.target.replace(/\.md$/i, ''), ...(w.heading ? { heading: w.heading } : {}) });
      }
    }
    const body = text.slice(parsed.bodyStart);
    const record: NoteRecord = {
      id: typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : typeof fm.id === 'number' ? String(fm.id) : derivedId(path),
      path,
      location,
      title: parsed.title || stem,
      subtitle: parsed.subtitle,
      stem,
      created: dateOf(fm.created) ?? st.birth ?? st.mtime,
      modified: st.mtime,
      pinned: fm.pinned === true,
      trashedAt: location === 'trash' ? (dateOf(fm.trashed) ?? st.mtime) : null,
      size: st.size,
      mtime: st.mtime,
      hash: contentHash(body),
      length: body.length,
      todoOpen: parsed.todoOpen,
      todoDone: parsed.todoDone,
      hasImages: parsed.hasImages,
      hasFiles: parsed.hasFiles,
      hasCode: parsed.hasCode,
      words: parsed.words,
    };
    return { record, extras: { body, tags: [...tags].map(([tag, display]) => ({ tag, display })), links, files: [...files] } };
  }

  private async reindex(path: string): Promise<void> {
    const text = await readFile(this.abs(path), 'utf8');
    const st = await stat(this.abs(path));
    const entry = this.entryFor(path, text, { mtime: st.mtimeMs, size: st.size, birth: st.birthtimeMs || st.mtimeMs });
    this.index.transaction(() => this.index.upsert(entry.record, entry.extras));
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  async list(args: ListArgs = {}): Promise<{ notes: NoteSummary[]; total: number }> {
    await this.refresh();
    const opts: ListOptions & { where?: string; params?: (string | number)[] } = { ...this.scope, ...pageOf(args) };
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (args.tag) {
      const key = tagKey(args.tag);
      where.push(`EXISTS (SELECT 1 FROM tags t WHERE t.note = n.rowid AND (t.tag = ? OR substr(t.tag, 1, ?) = ?))`);
      params.push(key, key.length + 1, `${key}/`);
    }
    switch (args.section) {
      case 'untagged':
        where.push('NOT EXISTS (SELECT 1 FROM tags t WHERE t.note = n.rowid)');
        break;
      case 'todo':
        where.push('n.todo_open > 0');
        break;
      case 'today':
        where.push('n.modified >= ?');
        params.push(startOfToday(this.now()));
        break;
      case 'pinned':
        where.push('n.pinned = 1');
        break;
    }
    if (where.length) {
      opts.where = where.join(' AND ');
      opts.params = params;
    }
    const { rows, total } = this.index.list(opts);
    return { notes: rows.map((r) => this.summary(r)), total };
  }

  async search(query: string, args: Omit<ListArgs, 'section' | 'tag'> = {}): Promise<{ notes: NoteSummary[]; total: number }> {
    await this.refresh();
    const q = parseQuery(query, this.now());
    const { rows, total } = this.index.search(q, { ...this.scope, ...pageOf(args) });
    return { notes: rows.map((r) => this.summary(r)), total };
  }

  async get(ref: NoteRef): Promise<NoteSummary & { backlinks: number; links: { target: string; heading?: string; id?: string }[] }> {
    const row = await this.resolve(ref);
    const links = this.index.linksOf(row.rowid).map((l) => {
      const hits = this.index.resolveLink(l.target, this.scope);
      return { target: l.target, ...(l.heading ? { heading: l.heading } : {}), ...(hits.length === 1 ? { id: hits[0]!.id } : {}) };
    });
    return { ...this.summary(row), backlinks: this.index.backlinks(row, this.scope).length, links };
  }

  async read(ref: NoteRef, opts: { section?: string; index?: number; offset?: number; limit?: number } = {}): Promise<ReadResult> {
    const row = await this.resolve(ref);
    const { text, parsed } = await this.load(row);
    const body = text.slice(parsed.bodyStart);
    const base = { id: row.id, title: row.title, totalLength: body.length };
    if (opts.section !== undefined) {
      if (opts.offset !== undefined || opts.limit !== undefined) throw new NoteError('invalid_argument', 'Read a section or a range (offset/limit), not both.');
      const s = findSection(text, parsed, opts.section, opts.index);
      const content = text.slice(s.start, s.end);
      return { ...base, content, hash: contentHash(content), offset: s.start - parsed.bodyStart, section: { address: s.address, offset: s.start - parsed.bodyStart, length: content.length } };
    }
    const offset = Math.max(0, opts.offset ?? 0);
    const content = opts.limit !== undefined ? body.slice(offset, offset + Math.max(0, opts.limit)) : body.slice(offset);
    // A partial read can't be a receipt for the whole note, so it hands out the whole note's hash.
    return { ...base, content, hash: contentHash(body), offset };
  }

  async outline(ref: NoteRef): Promise<{ id: string; title: string; hash: string; sections: (Omit<Section, 'start' | 'end'> & { offset: number; length: number; hash: string })[] }> {
    const row = await this.resolve(ref);
    const { text, parsed } = await this.load(row);
    return {
      id: row.id,
      title: row.title,
      hash: contentHash(text.slice(parsed.bodyStart)),
      sections: outline(text, parsed).map(({ start, end, ...s }) => ({
        ...s,
        offset: start - parsed.bodyStart,
        length: end - start,
        hash: contentHash(text.slice(start, end)),
      })),
    };
  }

  async searchInNote(ref: NoteRef, needle: string, opts: { caseSensitive?: boolean } = {}): Promise<{ line: number; column: number; offset: number; text: string }[]> {
    if (!needle) throw new NoteError('invalid_argument', 'Give the text to look for.');
    const row = await this.resolve(ref);
    const { text, parsed } = await this.load(row);
    const body = text.slice(parsed.bodyStart);
    const hay = opts.caseSensitive ? body : body.toLowerCase();
    const find = opts.caseSensitive ? needle : needle.toLowerCase();
    const out: { line: number; column: number; offset: number; text: string }[] = [];
    let lineNo = 1;
    let lineStart = 0;
    for (let at = hay.indexOf(find); at !== -1; at = hay.indexOf(find, at + Math.max(1, find.length))) {
      while (true) {
        const nl = body.indexOf('\n', lineStart);
        if (nl === -1 || nl >= at) break;
        lineStart = nl + 1;
        lineNo++;
      }
      const lineEnd = body.indexOf('\n', at);
      out.push({ line: lineNo, column: at - lineStart + 1, offset: at, text: body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).replace(/\r$/, '') });
    }
    return out;
  }

  async backlinks(ref: NoteRef): Promise<NoteSummary[]> {
    const row = await this.resolve(ref);
    return this.index.backlinks(row, this.scope).map((r) => this.summary(r));
  }

  async tags(): Promise<{ tag: string; count: number }[]> {
    await this.refresh();
    return this.index.tags({ ...this.scope, location: 'notes' }).map((t) => ({ tag: t.name, count: t.count }));
  }

  // ── Writing ─────────────────────────────────────────────────────────────

  async create(args: { title?: string; text?: string; tags?: string[]; folder?: string; pinned?: boolean } = {}): Promise<NoteSummary> {
    return this.exclusive(async () => {
      const tags = (args.tags ?? []).map(normalizeTagName).filter(Boolean);
      this.checkCreateScope(tags, args.text ?? '');
      const parts: string[] = [];
      const title = args.title?.trim();
      if (title) parts.push(`# ${title}`);
      if (tags.length) parts.push(tags.map(formatTag).join(' '));
      if (args.text?.trim()) parts.push((parts.length ? '\n' : '') + args.text.replace(/\s+$/, ''));
      const body = parts.join('\n') + '\n';
      const id = randomUUID().toUpperCase();
      const text = updateFrontMatter(body, { id, created: this.now().toISOString(), ...(args.pinned ? { pinned: true } : {}) });

      const folder = args.folder ? this.relPath(args.folder) : '';
      const stem = fileStem(parseNote(text).title);
      const path = await this.uniquePath(folder, stem);
      await mkdir(this.abs(posix.dirname(path)), { recursive: true });
      await atomicWrite(this.abs(path), text);
      await this.reindex(path);
      return this.summary(this.index.byPath(path)!);
    });
  }

  /** Add text at the end (or start: just after the title line) of a note or one section. */
  async append(ref: NoteRef, addition: string, opts: WriteGuard & { position?: 'end' | 'start' } = {}): Promise<NoteSummary> {
    return this.modify(ref, opts, (text, parsed, range) => {
      const eol = eolOf(text);
      const add = addition.replace(/\r?\n/g, eol).replace(/\s+$/, '');
      if (opts.position === 'start') {
        const at = range ? lineEndAfter(text, range.start) : parsed.titleEnd;
        // A title (or heading) on the file's last line, with no line break after it.
        const lead = at > parsed.bodyStart && !text.slice(0, at).endsWith('\n') ? eol : '';
        return splice(text, at, at, `${lead}${add}${eol}`);
      }
      const end = range ? range.end : text.length;
      const trimmed = text.slice(0, end).replace(/\s+$/, '');
      // Never trim into the front matter's closing fence.
      const before = trimmed.length < parsed.bodyStart ? text.slice(0, parsed.bodyStart) : trimmed;
      const sep = before.length <= parsed.bodyStart ? '' : eol;
      const after = text.slice(end);
      return `${before}${sep}${add}${eol}${after ? eol + after.replace(/^\s+/, '') : ''}`;
    });
  }

  /** Replace the body (or one section). The front matter — id, pins — is kept. */
  async overwrite(ref: NoteRef, content: string, opts: WriteGuard = {}): Promise<NoteSummary> {
    return this.modify(ref, opts, (text, parsed, range) => {
      const eol = eolOf(text);
      let next = content.replace(/\r?\n/g, eol);
      if (range) {
        // Keep the spacing the section had before the next heading.
        if (range.end < text.length) {
          const gap = /\s*$/.exec(text.slice(range.start, range.end))![0];
          next = next.replace(/\s+$/, '') + (gap.includes('\n') ? gap : eol);
        }
        return splice(text, range.start, range.end, next);
      }
      const given = readFrontMatter(next);
      if (given.present && !given.invalid) {
        // A full file came in: its front matter wins, but the note keeps its identity.
        const old = parsed.frontMatter;
        const keep: Record<string, unknown> = {};
        for (const key of ['id', 'created']) if (old[key] !== undefined && given.data[key] === undefined) keep[key] = old[key];
        return updateFrontMatter(next, keep);
      }
      return text.slice(0, parsed.bodyStart) + next;
    });
  }

  /**
   * Find exact text and replace it, insert around it, or delete it. More than
   * one match is refused unless `all` or `occurrence` says which — a silent
   * pick of the wrong one is how edits corrupt files.
   */
  async edit(ref: NoteRef, args: EditArgs): Promise<NoteSummary & { replaced: number }> {
    const ops = [args.replace !== undefined, args.insertBefore !== undefined, args.insertAfter !== undefined, args.delete === true].filter(Boolean).length;
    if (ops !== 1) throw new NoteError('invalid_argument', 'Say exactly one of: replace, insertBefore, insertAfter, delete.');
    if (!args.find) throw new NoteError('invalid_argument', 'find must be non-empty text that appears in the note.');
    let replaced = 0;
    const summary = await this.modify(ref, args, (text, parsed, range) => {
      const from = range ? range.start : parsed.bodyStart;
      const to = range ? range.end : text.length;
      const scope = text.slice(from, to);
      const hits: number[] = [];
      for (let at = scope.indexOf(args.find); at !== -1; at = scope.indexOf(args.find, at + args.find.length)) hits.push(at);
      if (hits.length === 0) throw new NoteError('not_found', `${JSON.stringify(clip(args.find))} isn't in ${range ? 'that section' : 'the note'}. Read it again; the text must match exactly.`);
      let chosen = hits;
      if (args.occurrence !== undefined) {
        const one = hits[args.occurrence - 1];
        if (one === undefined) throw new NoteError('not_found', `Asked for match ${args.occurrence}, but there are ${hits.length}.`);
        chosen = [one];
      } else if (!args.all && hits.length > 1) {
        const where = hits.map((h) => lineOf(text, from + h) - lineOf(text, parsed.bodyStart) + 1).join(', ');
        throw new NoteError('ambiguous', `${JSON.stringify(clip(args.find))} appears ${hits.length} times (lines ${where}). Include more surrounding text, or pass occurrence or all.`);
      }
      let out = scope;
      for (const at of [...chosen].reverse()) {
        const end = at + args.find.length;
        const piece =
          args.replace !== undefined
            ? args.replace
            : args.insertBefore !== undefined
              ? args.insertBefore + args.find
              : args.insertAfter !== undefined
                ? args.find + args.insertAfter
                : '';
        out = out.slice(0, at) + piece + out.slice(end);
      }
      replaced = chosen.length;
      return text.slice(0, from) + out + text.slice(to);
    });
    return { ...summary, replaced };
  }

  async duplicate(ref: NoteRef): Promise<NoteSummary> {
    const row = await this.resolve(ref);
    const { text, parsed } = await this.load(row);
    return this.exclusive(async () => {
      const copy = updateFrontMatter(text, { id: randomUUID().toUpperCase(), created: this.now().toISOString(), pinned: undefined, archived: undefined, trashed: undefined });
      const folder = row.location === 'trash' ? posix.dirname(row.path.slice(TRASH.length + 1)) : posix.dirname(row.path);
      const path = await this.uniquePath(folder === '.' ? '' : folder, fileStem(parsed.title || row.title));
      await atomicWrite(this.abs(path), copy);
      await this.reindex(path);
      return this.summary(this.index.byPath(path)!);
    });
  }

  async pin(ref: NoteRef, pinned: boolean): Promise<NoteSummary> {
    return this.setMeta(ref, { pinned: pinned ? true : undefined });
  }

  async archive(ref: NoteRef): Promise<NoteSummary> {
    const row = await this.resolve(ref);
    if (row.location === 'trash') throw new NoteError('invalid_argument', 'That note is in the trash. Restore it first.');
    return this.setMeta(ref, { archived: true });
  }

  /** Move to `.trash/`, keeping its folder layout so restore can put it back. */
  async trash(ref: NoteRef): Promise<NoteSummary> {
    const row = await this.resolve(ref);
    if (row.location === 'trash') return this.summary(row);
    return this.exclusive(async () => {
      await this.setMetaNow(row, { trashed: this.now().toISOString() });
      const dest = await this.uniquePath(posix.dirname(`${TRASH}/${row.path}`), posix.basename(row.path).replace(/\.md$/i, ''));
      await this.move(row.path, dest);
      return this.summary(this.index.byPath(dest)!);
    });
  }

  /** Out of the trash or the archive, back to the notes. */
  async restore(ref: NoteRef): Promise<NoteSummary> {
    const row = await this.resolve(ref);
    return this.exclusive(async () => {
      if (row.location === 'trash') {
        await this.setMetaNow(row, { trashed: undefined, archived: undefined });
        const original = row.path.slice(TRASH.length + 1);
        const dir = posix.dirname(original);
        const dest = await this.uniquePath(dir === '.' ? '' : dir, posix.basename(original).replace(/\.md$/i, ''));
        await this.move(row.path, dest);
        return this.summary(this.index.byPath(dest)!);
      }
      await this.setMetaNow(row, { archived: undefined });
      return this.summary(this.index.byId(row.id)!);
    });
  }

  /** Delete one trashed note for good. Only from the trash, so nothing is lost by one call. */
  async deletePermanently(ref: NoteRef): Promise<void> {
    const row = await this.resolve(ref);
    if (row.location !== 'trash') throw new NoteError('invalid_argument', 'Only a note in the trash can be deleted for good. Trash it first.');
    await this.exclusive(async () => {
      await unlink(this.abs(row.path));
      this.index.transaction(() => this.index.remove(row.path));
      await pruneEmptyDirs(this.abs(TRASH), posix.dirname(row.path.slice(TRASH.length + 1)));
    });
  }

  async emptyTrash(): Promise<{ deleted: number }> {
    await this.refresh(true);
    const { rows } = this.index.list({ ...this.scope, location: 'trash' });
    for (const r of rows) await this.deletePermanently({ id: r.id });
    return { deleted: rows.length };
  }

  // ── Tags ────────────────────────────────────────────────────────────────

  /** Add a tag at the top: onto the tag line under the title, or as a new one. */
  async addTag(ref: NoteRef, tag: string): Promise<NoteSummary> {
    const name = normalizeTagName(tag.replace(/^#|#$/g, ''));
    if (!name) throw new NoteError('invalid_argument', 'Give a tag name.');
    if (this.scope.excludeTags?.some((t) => under(tagKey(name), t))) throw new NoteError('out_of_scope', `#${name} is hidden from this connection.`);
    return this.modify(ref, {}, (text, parsed) => {
      if (parsed.tags.some((t) => tagKey(t.name) === tagKey(name))) return text;
      const eol = eolOf(text);
      const at = parsed.titleEnd;
      const next = [...lines(text, at)][0];
      if (next && next.line.trim() !== '' && isTagLine(next.line)) {
        const end = next.start + next.line.length;
        return splice(text, end, end, ` ${formatTag(name)}`);
      }
      const atEnd = at >= text.length || text.slice(parsed.bodyStart).trim() === '';
      const prefix = atEnd && at > parsed.bodyStart && !/\n$/.test(text.slice(0, at)) ? eol : '';
      return splice(text, at, at, `${prefix}${formatTag(name)}${eol}`);
    });
  }

  async removeTag(ref: NoteRef, tag: string): Promise<NoteSummary> {
    const key = tagKey(tag);
    return this.modify(ref, {}, (text, parsed) => removeTags(text, parsed, (k) => k === key));
  }

  /** Rename a tag and its subtags in every note this caller can see: `#old/x` → `#new/x`. */
  async renameTag(from: string, to: string): Promise<{ notes: number }> {
    const oldKey = tagKey(from);
    const newName = normalizeTagName(to.replace(/^#|#$/g, ''));
    if (!oldKey || !newName) throw new NoteError('invalid_argument', 'Give both the old and the new tag name.');
    return this.forEachTagged(oldKey, (text, parsed) => {
      let out = text;
      for (const t of [...parsed.tags].reverse()) {
        const k = tagKey(t.name);
        if (!under(k, oldKey)) continue;
        out = splice(out, t.start, t.end, formatTag(newName + t.name.slice(oldKey.length)));
      }
      return renameFrontMatterTags(out, parsed, oldKey, newName);
    });
  }

  /** Remove a tag and its subtags from every note this caller can see. The notes stay. */
  async deleteTag(tag: string): Promise<{ notes: number }> {
    const key = tagKey(tag);
    if (!key) throw new NoteError('invalid_argument', 'Give a tag name.');
    return this.forEachTagged(key, (text, parsed) => removeTags(text, parsed, (k) => under(k, key)));
  }

  private async forEachTagged(key: string, change: (text: string, parsed: ParsedNote) => string): Promise<{ notes: number }> {
    await this.refresh(true);
    const rows = this.index.withTag(key, { ...this.scope, location: 'all' });
    let n = 0;
    for (const r of rows) {
      await this.modify({ id: r.id }, {}, change);
      n++;
    }
    return { notes: n };
  }

  // ── Attachments ─────────────────────────────────────────────────────────

  async listAttachments(ref: NoteRef): Promise<Attachment[]> {
    const row = await this.resolve(ref);
    const { parsed } = await this.load(row);
    const out = new Map<string, Attachment>();
    for (const l of parsed.localLinks) {
      const p = posix.normalize(posix.join(posix.dirname(row.path), l.path));
      if (p.startsWith('..') || /\.md$/i.test(p) || out.has(p)) continue;
      const st = await stat(this.abs(p)).catch(() => null);
      if (st?.isFile()) out.set(p, { filename: posix.basename(p), path: p, size: st.size, image: l.image || IMAGE_EXT.test(p) });
    }
    for (const w of parsed.wikiLinks) {
      if (!w.embed) continue;
      const p = this.filesByName.get(posix.basename(w.target).toLowerCase())?.[0];
      if (!p || out.has(p)) continue;
      const st = await stat(this.abs(p)).catch(() => null);
      if (st?.isFile()) out.set(p, { filename: posix.basename(p), path: p, size: st.size, image: IMAGE_EXT.test(p) });
    }
    return [...out.values()];
  }

  /** Save a file into `assets/` beside the note and link it at the end. */
  async addAttachment(ref: NoteRef, filename: string, data: Uint8Array): Promise<Attachment> {
    const name = posix.basename(filename.replace(/\\/g, '/')).replace(/[\0/]/g, '').trim();
    if (!name || name === '.' || name === '..') throw new NoteError('invalid_argument', 'Give the attachment a file name.');
    const row = await this.resolve(ref);
    const noteDir = posix.dirname(row.path);
    const dir = noteDir === '.' ? 'assets' : `${noteDir}/assets`;
    await mkdir(this.abs(dir), { recursive: true });
    const path = await this.uniqueFile(dir, name);
    await writeFile(this.abs(path), data);
    const rel = `assets/${posix.basename(path)}`;
    const image = IMAGE_EXT.test(path);
    const link = image ? `![](${encodeLink(rel)})` : `[${posix.basename(path)}](${encodeLink(rel)})`;
    await this.append({ id: row.id }, link);
    return { filename: posix.basename(path), path, size: data.byteLength, image };
  }

  async readAttachment(ref: NoteRef, filename: string): Promise<{ attachment: Attachment; data: Buffer }> {
    const attachment = await this.findAttachment(ref, filename);
    return { attachment, data: await readFile(this.abs(attachment.path)) };
  }

  /** Remove the note's links to the file, and the file itself once no note uses it. */
  async deleteAttachment(ref: NoteRef, filename: string): Promise<{ fileDeleted: boolean }> {
    const attachment = await this.findAttachment(ref, filename);
    const row = await this.resolve(ref);
    await this.modify({ id: row.id }, {}, (text, parsed) => {
      let out = text;
      const spans = [
        ...parsed.localLinks.filter((l) => posix.normalize(posix.join(posix.dirname(row.path), l.path)) === attachment.path),
        ...parsed.wikiLinks.filter((w) => w.embed && posix.basename(w.target).toLowerCase() === attachment.filename.toLowerCase()),
      ].sort((a, b) => b.start - a.start);
      for (const s of spans) out = removeSpan(out, s.start, s.end);
      return out;
    });
    const users = this.index.referencesTo(attachment.path).filter((id) => id !== row.id);
    if (users.length > 0) return { fileDeleted: false };
    await unlink(this.abs(attachment.path)).catch(() => undefined);
    return { fileDeleted: true };
  }

  private async findAttachment(ref: NoteRef, filename: string): Promise<Attachment> {
    const all = await this.listAttachments(ref);
    const want = filename.toLowerCase();
    const hit = all.find((a) => a.path.toLowerCase() === want) ?? all.find((a) => a.filename.toLowerCase() === want);
    if (!hit) throw new NoteError('not_found', `No attachment ${JSON.stringify(filename)} on that note.${all.length ? ` It has: ${all.map((a) => a.filename).join(', ')}.` : ''}`);
    return hit;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Find a note this caller may see, or say why not. */
  async resolve(ref: NoteRef): Promise<NoteRow> {
    await this.refresh();
    let rows: NoteRow[];
    if ('id' in ref) {
      const r = this.index.byId(ref.id) ?? this.index.byId(ref.id.toUpperCase());
      rows = r ? [r] : [];
    } else if ('path' in ref) {
      const r = this.index.byPath(this.relPath(ref.path));
      rows = r ? [r] : [];
    } else {
      rows = this.index.byTitle(ref.title, this.scope);
      const live = rows.filter((r) => r.location !== 'trash');
      if (live.length > 0) rows = live;
    }
    rows = rows.filter((r) => this.index.isVisible(r.rowid, this.scope));
    if (rows.length === 0) throw new NoteError('not_found', `No note ${describe(ref)}.`);
    if (rows.length > 1) {
      throw new NoteError('ambiguous', `${rows.length} notes are titled ${JSON.stringify((ref as { title: string }).title)}: ${rows.map((r) => `${r.id} (${r.path})`).join(', ')}. Use an id.`);
    }
    return rows[0]!;
  }

  private async load(row: NoteRow): Promise<{ text: string; parsed: ParsedNote }> {
    let text: string;
    try {
      text = await readFile(this.abs(row.path), 'utf8');
    } catch {
      await this.refresh(true);
      throw new NoteError('not_found', `${row.path} is no longer in the vault.`);
    }
    return { text, parsed: parseNote(text) };
  }

  /**
   * The one write path: re-read from disk, check `base`, apply, write
   * atomically, and keep the index and every `[[link]]` to it in step.
   */
  private async modify(
    ref: NoteRef,
    guard: WriteGuard,
    change: (text: string, parsed: ParsedNote, range: { start: number; end: number } | null) => string,
  ): Promise<NoteSummary> {
    const row = await this.resolve(ref);
    return this.exclusive(async () => {
      const { text, parsed } = await this.load(row);
      const range = guard.section !== undefined ? findSection(text, parsed, guard.section, guard.index) : null;
      if (guard.base !== undefined) {
        const body = contentHash(text.slice(parsed.bodyStart));
        const part = range ? contentHash(text.slice(range.start, range.end)) : body;
        if (guard.base !== body && guard.base !== part) {
          throw new NoteError('conflict', `The ${range ? 'section' : 'note'} changed since it was read (now ${part}). Read it again and retry.`);
        }
      }
      let next = change(text, parsed, range);
      if (next === text) return this.summary(row);
      next = this.withId(next, row);
      const nextParsed = parseNote(next);
      await atomicWrite(this.abs(row.path), next);
      let path = row.path;
      const oldTitle = parsed.title;
      const newTitle = nextParsed.title;
      if (newTitle && oldTitle !== newTitle) path = await this.followRename(row, oldTitle, newTitle);
      await this.reindex(path);
      return this.summary(this.index.byPath(path)!);
    });
  }

  private async setMeta(ref: NoteRef, patch: Record<string, unknown>): Promise<NoteSummary> {
    const row = await this.resolve(ref);
    return this.exclusive(async () => {
      await this.setMetaNow(row, patch);
      return this.summary(this.index.byPath(row.path)!);
    });
  }

  /** Front matter only; the caller holds the lock. */
  private async setMetaNow(row: NoteRow, patch: Record<string, unknown>): Promise<void> {
    const { text } = await this.load(row);
    const next = this.withId(updateFrontMatter(text, patch), row);
    if (next !== text) await atomicWrite(this.abs(row.path), next);
    await this.reindex(row.path);
  }

  /**
   * Write the id the note is already known by into its front matter, so it
   * survives the note moving. A note opened from someone else's folder has a
   * path-derived id until Heapnotes first changes it; keeping that same id
   * means no caller's reference goes stale at that moment.
   */
  private withId(text: string, row: NoteRow): string {
    const fm = readFrontMatter(text);
    if (fm.invalid || (fm.data.id !== undefined && String(fm.data.id).trim() !== '')) return text;
    return updateFrontMatter(text, { id: row.id });
  }

  /**
   * A title change: point `[[Old title]]` links at the new one, and rename
   * the file if it was named after the old title. Only notes this caller can
   * see are rewritten — a scoped connection never writes outside its scope.
   */
  private async followRename(row: NoteRow, oldTitle: string, newTitle: string): Promise<string> {
    const stem = posix.basename(row.path).replace(/\.md$/i, '');
    const keys = new Set([linkKey(oldTitle), linkKey(stem)].filter(Boolean));
    for (const other of this.index.backlinks(row, this.scope)) {
      const { text, parsed } = await this.load(other);
      let out = text;
      for (const w of [...parsed.wikiLinks].reverse()) {
        if (!keys.has(linkKey(w.target))) continue;
        // Only links that really mean this note — not a same-named one.
        const hits = this.index.resolveLink(w.target, this.scope);
        if (hits.length !== 1 || hits[0]!.id !== row.id) continue;
        const rest = `${w.heading ? `#${w.heading}` : ''}${w.alias ? `|${w.alias}` : ''}`;
        out = splice(out, w.start, w.end, `${w.embed ? '!' : ''}[[${newTitle}${rest}]]`);
      }
      if (out !== text) {
        await atomicWrite(this.abs(other.path), out);
        await this.reindex(other.path);
      }
    }

    const namedAfterTitle = stem === fileStem(oldTitle) || /^Untitled(?: \d+)?$/.test(stem);
    if (!namedAfterTitle || row.location === 'trash') return row.path;
    const dir = posix.dirname(row.path);
    const want = fileStem(newTitle);
    if (want === stem) return row.path;
    const dest = await this.uniquePath(dir === '.' ? '' : dir, want);
    await this.move(row.path, dest);
    return dest;
  }

  private async move(from: string, to: string): Promise<void> {
    await mkdir(this.abs(posix.dirname(to)), { recursive: true });
    await rename(this.abs(from), this.abs(to));
    this.index.transaction(() => this.index.remove(from));
    await this.reindex(to);
    if (from.startsWith(`${TRASH}/`)) await pruneEmptyDirs(this.abs(TRASH), posix.dirname(from.slice(TRASH.length + 1)));
  }

  private checkCreateScope(tags: string[], text: string): void {
    const all = [...tags, ...parseNote(text).tags.map((t) => t.name)].map(tagKey);
    if (this.scope.onlyTags?.length && !all.some((k) => this.scope.onlyTags!.some((o) => under(k, o)))) {
      throw new NoteError('out_of_scope', `This connection only sees notes tagged ${this.scope.onlyTags.map((t) => `#${t}`).join(', ')}; give the new note one of them.`);
    }
    const hidden = all.find((k) => this.scope.excludeTags?.some((x) => under(k, x)));
    if (hidden) throw new NoteError('out_of_scope', `#${hidden} is hidden from this connection.`);
  }

  /** Serialize writes, so two calls never interleave a read-modify-write on one file. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private summary(r: NoteRow): NoteSummary {
    return {
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      path: r.path,
      location: r.location,
      tags: this.index.tagsOf(r.rowid),
      pinned: r.pinned,
      created: new Date(r.created).toISOString(),
      modified: new Date(r.modified).toISOString(),
      todos: r.todoOpen,
      done: r.todoDone,
      hasImages: r.hasImages,
      hasFiles: r.hasFiles,
      hasCode: r.hasCode,
      words: r.words,
      length: r.length,
      hash: r.hash,
      ...(r.snippet ? { snippet: r.snippet } : {}),
    };
  }

  private abs(rel: string): string {
    return join(this.root, ...rel.split('/'));
  }

  /** A caller's path, made vault-relative and kept inside the vault. */
  private relPath(p: string): string {
    const abs = resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || resolve(rel) === rel) throw new NoteError('invalid_argument', `${p} is outside the vault.`);
    return rel.split(sep).join('/');
  }

  private async uniquePath(folder: string, stem: string): Promise<string> {
    const prefix = folder && folder !== '.' ? `${folder}/` : '';
    for (let n = 1; ; n++) {
      const candidate = `${prefix}${n === 1 ? stem : `${stem} ${n}`}.md`;
      if (!existsSync(this.abs(candidate))) return candidate;
    }
  }

  private async uniqueFile(folder: string, name: string): Promise<string> {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; ; n++) {
      const candidate = `${folder}/${n === 1 ? name : `${base} ${n}${ext}`}`;
      if (!existsSync(this.abs(candidate))) return candidate;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Notes and other files under the vault, skipping dot-folders (but the trash) and node_modules. */
async function walk(root: string): Promise<{ notes: Map<string, { mtime: number; size: number; birth: number }>; files: string[] }> {
  const notes = new Map<string, { mtime: number; size: number; birth: number }>();
  const files: string[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if ((e.name.startsWith('.') && !(rel === '' && e.name === TRASH)) || e.name === 'node_modules') continue;
        await visit(join(dir, e.name), childRel);
      } else if (e.isFile()) {
        if (e.name.startsWith('.')) continue;
        if (/\.md$/i.test(e.name)) {
          const st = await stat(join(dir, e.name)).catch(() => null);
          if (st) notes.set(childRel, { mtime: st.mtimeMs, size: st.size, birth: st.birthtimeMs || st.mtimeMs });
        } else {
          files.push(childRel);
        }
      }
    }
  }
  await visit(root, '');
  return { notes, files };
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function pruneEmptyDirs(base: string, rel: string): Promise<void> {
  let dir = rel;
  while (dir && dir !== '.') {
    try {
      await rmdir(join(base, ...dir.split('/')));
    } catch {
      return;
    }
    dir = posix.dirname(dir);
  }
}

/** The id of a note with none in its front matter: stable while it stays at this path. */
function derivedId(path: string): string {
  return `P-${contentHash(path).toUpperCase()}`;
}

/** A title made safe as a file name on every OS. */
export function fileStem(title: string): string {
  const stem = title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100)
    .trim();
  return stem || 'Untitled';
}

export function tagKey(tag: string): string {
  return normalizeTagName(tag.replace(/^#|#$/g, '')).toLowerCase();
}

/** `work/q3` is under `work`. */
function under(key: string, parent: string): boolean {
  return key === parent || key.startsWith(`${parent}/`);
}

function frontMatterTags(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : [];
  return list.filter((t): t is string => typeof t === 'string').map((t) => normalizeTagName(t.replace(/^#/, ''))).filter(Boolean);
}

function renameFrontMatterTags(text: string, parsed: ParsedNote, oldKey: string, newName: string): string {
  const raw = parsed.frontMatter.tags;
  if (!Array.isArray(raw) || !raw.some((t) => typeof t === 'string' && under(tagKey(t), oldKey))) return text;
  const next = raw.map((t) => (typeof t === 'string' && under(tagKey(t), oldKey) ? newName + normalizeTagName(t.replace(/^#/, '')).slice(oldKey.length) : t));
  return updateFrontMatter(text, { tags: next });
}

function removeTags(text: string, parsed: ParsedNote, match: (key: string) => boolean): string {
  let out = text;
  for (const t of [...parsed.tags].reverse()) if (match(tagKey(t.name))) out = removeSpan(out, t.start, t.end);
  const raw = parsed.frontMatter.tags;
  if (Array.isArray(raw) && raw.some((t) => typeof t === 'string' && match(tagKey(t)))) {
    const kept = raw.filter((t) => !(typeof t === 'string' && match(tagKey(t))));
    out = updateFrontMatter(out, { tags: kept.length ? kept : undefined });
  }
  return out;
}

/** Cut a span, then tidy: its line goes if nothing's left on it, and doubled spaces close up. */
function removeSpan(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, start) + text.slice(end, lineEnd);
  if (line.trim() === '') {
    const cutEnd = lineEnd < text.length ? lineEnd + 1 : lineEnd;
    return text.slice(0, lineStart) + text.slice(cutEnd);
  }
  const before = text.slice(lineStart, start).replace(/[ \t]+$/, '');
  const after = text.slice(end, lineEnd).replace(/^[ \t]+/, '');
  const joined = before && after ? `${before} ${after}` : before + after;
  return text.slice(0, lineStart) + joined.replace(/[ \t]+$/, '') + text.slice(lineEnd);
}

function isTagLine(line: string): boolean {
  return line.trim() !== '' && line.replace(/(^|\s)#(?:[^\s#][^#\n]*?[^\s#]#|[^\s#]+)/g, '').trim() === '';
}

function splice(s: string, from: number, to: number, insert: string): string {
  return s.slice(0, from) + insert + s.slice(to);
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function lineEndAfter(text: string, at: number): number {
  const nl = text.indexOf('\n', at);
  return nl === -1 ? text.length : nl + 1;
}

function lineOf(text: string, at: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function describe(ref: NoteRef): string {
  if ('id' in ref) return `with id ${ref.id}`;
  if ('path' in ref) return `at ${ref.path}`;
  return `titled ${JSON.stringify(ref.title)}`;
}

function encodeLink(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function dateOf(v: unknown): number | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.getTime();
  if (typeof v === 'string' || typeof v === 'number') {
    const t = new Date(v).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

function startOfToday(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function pageOf(args: { location?: Location | 'all'; sort?: ListArgs['sort']; limit?: number; offset?: number }): ListOptions {
  return {
    ...(args.location ? { location: args.location } : {}),
    ...(args.sort ? { sort: args.sort } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
  };
}
