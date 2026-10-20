import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { NoteError } from './errors.js';
import type { Filter, SearchQuery } from './query.js';

/**
 * The search index: SQLite with FTS5, through Node's built-in `node:sqlite`.
 *
 * Disposable by design: the `.md` files are the
 * truth, and this is rebuilt from them whenever its schema version doesn't
 * match — so changing the schema is bumping SCHEMA_VERSION, never a migration.
 */
export const SCHEMA_VERSION = 2;

export type Location = 'notes' | 'archive' | 'trash';

export interface NoteRow {
  rowid: number;
  id: string;
  /** Vault-relative, `/`-separated. */
  path: string;
  location: Location;
  title: string;
  subtitle: string;
  created: number;
  modified: number;
  pinned: boolean;
  trashedAt: number | null;
  size: number;
  mtime: number;
  hash: string;
  length: number;
  todoOpen: number;
  todoDone: number;
  hasImages: boolean;
  hasFiles: boolean;
  hasCode: boolean;
  words: number;
  /** Set on search results when there were words to match. */
  snippet?: string;
}

export interface NoteExtras {
  /** What full-text search sees: the note without its front matter. */
  body: string;
  tags: { tag: string; display: string }[];
  links: { target: string; heading?: string }[];
  /** Vault-relative paths of files the note links to or embeds. */
  files: string[];
}

export interface NoteRecord extends Omit<NoteRow, 'rowid' | 'snippet'> {
  /** File name without `.md`: what an Obsidian-style `[[link]]` names. */
  stem: string;
}

/** Which notes a caller may see at all (§8.5). Tags are lowercase; subtags included. */
export interface Visibility {
  onlyTags?: string[];
  excludeTags?: string[];
}

export type SortField = 'modified' | 'created' | 'title';

export interface ListOptions extends Visibility {
  location?: Location | 'all';
  sort?: { field: SortField; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

type Row = Record<string, SQLInputValue>;

export class NoteIndex {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open (or build) the index at `file`; `:memory:` for a throwaway one. */
  static open(file: string): NoteIndex {
    const sqlite = loadSqlite();
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    let db = new sqlite.DatabaseSync(file);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version !== SCHEMA_VERSION && version !== 0 && file !== ':memory:') {
      db.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
      db = new sqlite.DatabaseSync(file);
    }
    // The MCP server and the app can have the same vault open at once.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return new NoteIndex(db);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** What's indexed, by path: enough to tell which files changed since. */
  fingerprints(): Map<string, { id: string; mtime: number; size: number }> {
    const rows = this.db.prepare('SELECT path, id, mtime, size FROM notes').all() as {
      path: string;
      id: string;
      mtime: number;
      size: number;
    }[];
    return new Map(rows.map((r) => [r.path, { id: r.id, mtime: r.mtime, size: r.size }]));
  }

  upsert(note: NoteRecord, { body, tags, links, files }: NoteExtras): void {
    const existing = this.db
      .prepare('SELECT rowid FROM notes WHERE path = ? OR id = ?')
      .all(note.path, note.id) as { rowid: number }[];
    for (const r of existing) this.removeRow(r.rowid);
    const result = this.db
      .prepare(
        `INSERT INTO notes (id, path, location, title, subtitle, stem, title_key, stem_key, path_key, created, modified, pinned, trashed_at,
           size, mtime, hash, length, todo_open, todo_done, has_images, has_files, has_code, words)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        note.id,
        note.path,
        note.location,
        note.title,
        note.subtitle,
        note.stem,
        linkKey(note.title),
        linkKey(note.stem),
        linkKey(note.path.replace(/\.md$/i, '')),
        note.created,
        note.modified,
        note.pinned ? 1 : 0,
        note.trashedAt,
        note.size,
        note.mtime,
        note.hash,
        note.length,
        note.todoOpen,
        note.todoDone,
        note.hasImages ? 1 : 0,
        note.hasFiles ? 1 : 0,
        note.hasCode ? 1 : 0,
        note.words,
      );
    const rowid = Number(result.lastInsertRowid);
    this.db
      .prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)')
      .run(rowid, note.title, body);
    const addTag = this.db.prepare(
      'INSERT OR IGNORE INTO tags (note, tag, display) VALUES (?, ?, ?)',
    );
    for (const t of tags) addTag.run(rowid, t.tag, t.display);
    const addLink = this.db.prepare('INSERT INTO links (note, target, heading) VALUES (?, ?, ?)');
    for (const l of links) addLink.run(rowid, linkKey(l.target), l.heading ?? null);
    const addFile = this.db.prepare('INSERT OR IGNORE INTO files (note, path) VALUES (?, ?)');
    for (const f of files) addFile.run(rowid, f);
  }

  /** Notes (any location) that reference this vault file. */
  referencesTo(path: string): string[] {
    const rows = this.db
      .prepare('SELECT n.id AS id FROM files f JOIN notes n ON n.rowid = f.note WHERE f.path = ?')
      .all(path) as { id: string }[];
    return rows.map((r) => r.id);
  }

  remove(path: string): void {
    const row = this.db.prepare('SELECT rowid FROM notes WHERE path = ?').get(path) as
      { rowid: number } | undefined;
    if (row) this.removeRow(row.rowid);
  }

  private removeRow(rowid: number): void {
    this.db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(rowid);
    this.db.prepare('DELETE FROM notes WHERE rowid = ?').run(rowid);
  }

  byId(id: string): NoteRow | undefined {
    return this.one('n.id = ?', [id]);
  }

  byPath(path: string): NoteRow | undefined {
    return this.one('n.path = ?', [path]);
  }

  /** Every note a `[[target]]` could mean: by title, then by file name, then by path. */
  resolveLink(target: string, vis: Visibility = {}): NoteRow[] {
    const key = linkKey(target);
    for (const column of ['title_key', 'stem_key', 'path_key']) {
      const rows = this.many(`n.${column} = ? AND n.location != 'trash'`, [key], vis);
      if (rows.length > 0) return rows;
    }
    return [];
  }

  byTitle(title: string, vis: Visibility = {}): NoteRow[] {
    return this.many('n.title_key = ?', [linkKey(title)], vis);
  }

  tagsOf(rowid: number): string[] {
    const rows = this.db
      .prepare('SELECT display FROM tags WHERE note = ? ORDER BY rowid')
      .all(rowid) as { display: string }[];
    return rows.map((r) => r.display);
  }

  /** Outgoing `[[links]]`, as written (lowercased). */
  linksOf(rowid: number): { target: string; heading: string | null }[] {
    // In the order the note has them: smart order follows it.
    return this.db
      .prepare('SELECT target, heading FROM links WHERE note = ? ORDER BY rowid')
      .all(rowid) as {
      target: string;
      heading: string | null;
    }[];
  }

  /** Notes whose `[[links]]` reach this one. */
  backlinks(note: NoteRow, vis: Visibility = {}): NoteRow[] {
    return this.many(
      `n.location != 'trash' AND n.rowid != ? AND EXISTS (SELECT 1 FROM links l WHERE l.note = n.rowid AND l.target IN (?, ?, ?))`,
      [note.rowid, ...this.keysOf(note.rowid)],
      vis,
    );
  }

  /** Notes (not trashed, not `except`) with a `[[link]]` whose target is one of these keys. */
  linkingTo(keys: string[], except: number, vis: Visibility = {}): NoteRow[] {
    if (keys.length === 0) return [];
    return this.many(
      `n.location != 'trash' AND n.rowid != ? AND EXISTS (SELECT 1 FROM links l WHERE l.note = n.rowid AND l.target IN (${keys.map(() => '?').join(', ')}))`,
      [except, ...keys.map(linkKey)],
      vis,
    );
  }

  private keysOf(rowid: number): [string, string, string] {
    const r = this.db
      .prepare('SELECT title_key, stem_key, path_key FROM notes WHERE rowid = ?')
      .get(rowid) as { title_key: string; stem_key: string; path_key: string };
    return [r.title_key, r.stem_key, r.path_key];
  }

  list(opts: ListOptions & { where?: string; params?: SQLInputValue[] } = {}): {
    rows: NoteRow[];
    total: number;
  } {
    const { clause, params } = this.baseWhere(opts);
    const where = [clause, opts.where].filter(Boolean).join(' AND ');
    return this.page(
      `FROM notes n WHERE ${where}`,
      [...params, ...(opts.params ?? [])],
      orderBy(opts.sort),
      opts,
    );
  }

  search(q: SearchQuery, opts: ListOptions = {}): { rows: NoteRow[]; total: number } {
    const { clause, params } = this.baseWhere(opts);
    const where = [clause];
    const all = [...params];
    const match = ftsQuery(q.terms, q.titleOnly);
    for (const t of q.excludeTerms) {
      const m = ftsQuery([t], q.titleOnly);
      if (m) {
        where.push('n.rowid NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)');
        all.push(m);
      }
    }
    for (const tag of q.tags) {
      where.push(hasTag('n'));
      all.push(tag, likePrefix(tag));
    }
    for (const tag of q.excludeTags) {
      where.push(`NOT ${hasTag('n')}`);
      all.push(tag, likePrefix(tag));
    }
    for (const f of q.filters) {
      const sql = filterSql(f, all);
      where.push(f.negate ? `NOT (${sql})` : sql);
    }

    if (match) {
      const order = opts.sort?.length
        ? orderBy(opts.sort)
        : 'bm25(notes_fts, 10.0, 1.0), n.modified DESC';
      return this.page(
        `FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? AND ${where.join(' AND ')}`,
        [match, ...all],
        order,
        opts,
        "snippet(notes_fts, 1, '**', '**', '…', 12) AS snippet",
      );
    }
    if (q.terms.length > 0) return { rows: [], total: 0 };
    return this.page(`FROM notes n WHERE ${where.join(' AND ')}`, all, orderBy(opts.sort), opts);
  }

  /** Every tag with how many visible notes carry it (subtags not rolled up). */
  tags(opts: ListOptions = {}): { tag: string; name: string; count: number }[] {
    const { clause, params } = this.baseWhere(opts);
    return this.db
      .prepare(
        `SELECT t.tag AS tag, MIN(t.display) AS name, COUNT(DISTINCT t.note) AS count
         FROM tags t JOIN notes n ON n.rowid = t.note WHERE ${clause} GROUP BY t.tag ORDER BY t.tag`,
      )
      .all(...params) as { tag: string; name: string; count: number }[];
  }

  /** Visible notes carrying this tag or a subtag of it. */
  withTag(tag: string, opts: ListOptions = {}): NoteRow[] {
    return this.list({ ...opts, where: hasTag('n'), params: [tag, likePrefix(tag)] }).rows;
  }

  isVisible(rowid: number, vis: Visibility): boolean {
    const { clause, params } = visibilitySql(vis);
    if (!clause) return true;
    return (
      this.db
        .prepare(`SELECT 1 FROM notes n WHERE n.rowid = ? AND ${clause}`)
        .get(rowid, ...params) !== undefined
    );
  }

  private baseWhere(opts: ListOptions): { clause: string; params: SQLInputValue[] } {
    const parts: string[] = [];
    const params: SQLInputValue[] = [];
    const location = opts.location ?? 'notes';
    if (location !== 'all') {
      parts.push('n.location = ?');
      params.push(location);
    }
    const vis = visibilitySql(opts);
    if (vis.clause) {
      parts.push(vis.clause);
      params.push(...vis.params);
    }
    return { clause: parts.length ? parts.join(' AND ') : '1', params };
  }

  private page(
    from: string,
    params: SQLInputValue[],
    order: string,
    opts: ListOptions,
    extra?: string,
  ): { rows: NoteRow[]; total: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c ${from}`).get(...params) as { c: number })
      .c;
    const limit = opts.limit ?? -1;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS}${extra ? `, ${extra}` : ''} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Row[];
    return { rows: rows.map(toNote), total };
  }

  private one(where: string, params: SQLInputValue[]): NoteRow | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM notes n WHERE ${where}`).get(...params) as
      Row | undefined;
    return row ? toNote(row) : undefined;
  }

  private many(where: string, params: SQLInputValue[], vis: Visibility): NoteRow[] {
    const v = visibilitySql(vis);
    const clause = v.clause ? `${where} AND ${v.clause}` : where;
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM notes n WHERE ${clause} ORDER BY n.modified DESC`)
      .all(...params, ...v.params) as Row[];
    return rows.map(toNote);
  }
}

/** How `[[links]]` compare: case- and spacing-insensitive. */
export function linkKey(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function loadSqlite(): typeof import('node:sqlite') {
  let mod: typeof import('node:sqlite') | undefined;
  try {
    mod = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
  } catch {
    mod = undefined;
  }
  if (!mod?.DatabaseSync) {
    throw new NoteError(
      'io',
      `Heapnotes needs Node.js 22.13 or newer (it uses Node's built-in SQLite). This is Node ${process.versions.node}.`,
    );
  }
  return mod;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  stem TEXT NOT NULL,
  title_key TEXT NOT NULL,
  stem_key TEXT NOT NULL,
  path_key TEXT NOT NULL,
  created INTEGER NOT NULL,
  modified INTEGER NOT NULL,
  pinned INTEGER NOT NULL,
  trashed_at INTEGER,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  hash TEXT NOT NULL,
  length INTEGER NOT NULL,
  todo_open INTEGER NOT NULL,
  todo_done INTEGER NOT NULL,
  has_images INTEGER NOT NULL,
  has_files INTEGER NOT NULL,
  has_code INTEGER NOT NULL,
  words INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_title_key ON notes (title_key);
CREATE INDEX IF NOT EXISTS notes_stem_key ON notes (stem_key);
CREATE INDEX IF NOT EXISTS notes_path_key ON notes (path_key);
CREATE INDEX IF NOT EXISTS notes_modified ON notes (modified);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5 (title, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS tags (
  note INTEGER NOT NULL REFERENCES notes (rowid) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  display TEXT NOT NULL,
  PRIMARY KEY (note, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags (tag);
CREATE TABLE IF NOT EXISTS links (
  note INTEGER NOT NULL REFERENCES notes (rowid) ON DELETE CASCADE,
  target TEXT NOT NULL,
  heading TEXT
);
CREATE INDEX IF NOT EXISTS links_target ON links (target);
CREATE INDEX IF NOT EXISTS links_note ON links (note);
CREATE TABLE IF NOT EXISTS files (
  note INTEGER NOT NULL REFERENCES notes (rowid) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY (note, path)
);
CREATE INDEX IF NOT EXISTS files_path ON files (path);
`;

const COLUMNS = `n.rowid AS rowid, n.id AS id, n.path AS path, n.location AS location, n.title AS title, n.subtitle AS subtitle,
  n.created AS created, n.modified AS modified, n.pinned AS pinned, n.trashed_at AS trashedAt, n.size AS size, n.mtime AS mtime,
  n.hash AS hash, n.length AS length, n.todo_open AS todoOpen, n.todo_done AS todoDone, n.has_images AS hasImages,
  n.has_files AS hasFiles, n.has_code AS hasCode, n.words AS words`;

function toNote(r: Row): NoteRow {
  return {
    rowid: Number(r.rowid),
    id: String(r.id),
    path: String(r.path),
    location: r.location as Location,
    title: String(r.title),
    subtitle: String(r.subtitle),
    created: Number(r.created),
    modified: Number(r.modified),
    pinned: r.pinned === 1,
    trashedAt: r.trashedAt === null ? null : Number(r.trashedAt),
    size: Number(r.size),
    mtime: Number(r.mtime),
    hash: String(r.hash),
    length: Number(r.length),
    todoOpen: Number(r.todoOpen),
    todoDone: Number(r.todoDone),
    hasImages: r.hasImages === 1,
    hasFiles: r.hasFiles === 1,
    hasCode: r.hasCode === 1,
    words: Number(r.words),
    ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
  };
}

function hasTag(alias: string): string {
  return `EXISTS (SELECT 1 FROM tags t WHERE t.note = ${alias}.rowid AND (t.tag = ? OR t.tag LIKE ? ESCAPE '\\'))`;
}

/** `work` → `work/%`, with LIKE's wildcards in the tag itself escaped. */
function likePrefix(tag: string): string {
  return `${tag.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
}

function visibilitySql(vis: Visibility): { clause: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (vis.onlyTags?.length) {
    parts.push(`(${vis.onlyTags.map(() => hasTag('n')).join(' OR ')})`);
    for (const t of vis.onlyTags) params.push(t, likePrefix(t));
  }
  for (const t of vis.excludeTags ?? []) {
    parts.push(`NOT ${hasTag('n')}`);
    params.push(t, likePrefix(t));
  }
  return { clause: parts.join(' AND '), params };
}

function orderBy(sort: ListOptions['sort']): string {
  const fields = sort?.length ? sort : [{ field: 'modified' as const, direction: 'desc' as const }];
  const cols = fields.map(({ field, direction }) => {
    const col = field === 'title' ? 'n.title_key' : `n.${field}`;
    return `${col} ${direction === 'asc' ? 'ASC' : 'DESC'}`;
  });
  return sort?.length ? cols.join(', ') : `n.pinned DESC, ${cols.join(', ')}`;
}

/**
 * FTS5 MATCH text for words (prefix-matched, so `meet` finds `meeting`) and
 * phrases (exact). Each is quoted, so nothing a person types is FTS syntax.
 */
function ftsQuery(terms: SearchQuery['terms'], titleOnly: boolean): string | null {
  const parts = terms
    .filter((t) => /[\p{L}\p{N}]/u.test(t.text))
    .map((t) => {
      const quoted = `"${t.text.replace(/"/g, '""')}"`;
      return t.phrase ? quoted : `${quoted}*`;
    });
  if (parts.length === 0) return null;
  const body = parts.join(' AND ');
  return titleOnly ? `title : (${body})` : body;
}

function filterSql(f: Filter, params: SQLInputValue[]): string {
  if (f.kind === 'date') {
    const parts: string[] = [];
    if (f.from !== undefined) {
      parts.push(`n.${f.field} >= ?`);
      params.push(f.from);
    }
    if (f.to !== undefined) {
      parts.push(`n.${f.field} < ?`);
      params.push(f.to);
    }
    return parts.join(' AND ') || '1';
  }
  switch (f.flag) {
    case 'todo':
      return 'n.todo_open > 0';
    case 'done':
      return 'n.todo_done > 0';
    case 'task':
      return 'n.todo_open + n.todo_done > 0';
    case 'tagged':
      return 'EXISTS (SELECT 1 FROM tags t WHERE t.note = n.rowid)';
    case 'untagged':
      return 'NOT EXISTS (SELECT 1 FROM tags t WHERE t.note = n.rowid)';
    case 'pinned':
      return 'n.pinned = 1';
    case 'images':
      return 'n.has_images = 1';
    case 'files':
      return 'n.has_files = 1';
    case 'attachments':
      return '(n.has_images = 1 OR n.has_files = 1)';
    case 'code':
      return 'n.has_code = 1';
    case 'wikilinks':
      return 'EXISTS (SELECT 1 FROM links l WHERE l.note = n.rowid)';
    case 'backlinks':
      return `EXISTS (SELECT 1 FROM links l JOIN notes s ON s.rowid = l.note
        WHERE s.location != 'trash' AND s.rowid != n.rowid AND l.target IN (n.title_key, n.stem_key, n.path_key))`;
  }
}
