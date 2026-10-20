import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { NoteError } from './errors.js';
import { updateFrontMatter } from './frontMatter.js';
import { formatTag, normalizeTagName } from './parse.js';
import type { ImportOptions, ImportResult } from './importers.js';
import type { Vault } from './vault.js';
import { unzip } from './zip.js';

/**
 * Notion's export ("Markdown & CSV"), from the .zip it downloads or the
 * folder it unzips to.
 *
 * Notion names every page and folder `Title <32-hex id>` and links pages by
 * those names, URL-encoded. This takes the ids off, turns links between
 * pages into [[wiki links]], keeps images and files beside their pages, makes
 * each database (a CSV) a note holding a table, and turns callouts into
 * quotes. Each page's id becomes its note id, so importing the same export
 * twice skips what is already here.
 */

interface SourceFile {
  /** `/`-separated, inside the export. */
  path: string;
  data: Buffer;
  modified: Date;
}

const ID = /\s+([0-9a-f]{32})$/i;
/** `Title 1234…abcd` → { name: 'Title', id }. */
function cleanName(segment: string): { name: string; id?: string } {
  const ext = posix.extname(segment);
  const stem = ext ? segment.slice(0, -ext.length) : segment;
  const m = ID.exec(stem);
  const name = (m ? stem.slice(0, m.index) : stem).trim() || 'Untitled';
  return { name: name + ext, ...(m ? { id: m[1]!.toLowerCase() } : {}) };
}

/** Every file of the export: a zip (and the zips Notion nests inside it), or a folder. */
async function readExport(source: string): Promise<SourceFile[]> {
  const src = resolve(source);
  const st = await stat(src).catch(() => null);
  if (!st) throw new NoteError('not_found', `Couldn't find ${source}.`);
  const fromZip = (buf: Buffer, prefix = ''): SourceFile[] =>
    unzip(buf).flatMap((e) =>
      // Large exports come as a zip of "Part-1.zip", "Part-2.zip"…
      /\.zip$/i.test(e.path)
        ? fromZip(e.data, prefix)
        : [{ path: prefix + e.path, data: e.data, modified: e.modified ?? new Date() }],
    );
  if (st.isFile()) {
    if (!/\.zip$/i.test(src))
      throw new NoteError(
        'invalid_argument',
        'Choose the .zip Notion exported, or the folder it unzips to.',
      );
    return fromZip(await readFile(src));
  }
  const out: SourceFile[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await visit(abs, childRel);
      else if (e.isFile()) {
        const data = await readFile(abs);
        if (/\.zip$/i.test(e.name)) out.push(...fromZip(data));
        else out.push({ path: childRel, data, modified: (await stat(abs)).mtime });
      }
    }
  }
  await visit(src, '');
  return out;
}

/** Notion's wrapper folders say nothing about the notes: "Export-…", "Private & Shared". */
function dropWrappers(files: SourceFile[]): void {
  for (;;) {
    const firsts = new Set(files.map((f) => f.path.split('/')[0]));
    const [only] = firsts;
    if (
      firsts.size !== 1 ||
      !only ||
      files.some((f) => !f.path.includes('/')) ||
      !/^(Export-[\w-]+|Private & Shared|Private|Shared|Teamspaces?)$/i.test(only)
    )
      return;
    for (const f of files) f.path = f.path.slice(only.length + 1);
  }
}

// ── CSV (databases) ──────────────────────────────────────────────────────

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function tableFromCsv(rows: string[][], pageTitles: Set<string>): string {
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [
    line(head),
    `| ${Array<string>(width).fill('---').join(' | ')} |`,
    // The first column names each row's page: link it when the page came too.
    ...body.map((r) =>
      line([
        pageTitles.has(r[0]?.trim() ?? '') ? `[[${r[0]!.trim()}]]` : (r[0] ?? ''),
        ...r.slice(1),
      ]),
    ),
  ].join('\n');
}

// ── The import ───────────────────────────────────────────────────────────

export async function importNotion(
  vault: Vault,
  source: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const files = await readExport(source);
  dropWrappers(files);
  if (!files.some((f) => /\.(md|csv)$/i.test(f.path)))
    throw new NoteError(
      'invalid_argument',
      "That doesn't look like a Notion export: no pages in it. Export as Markdown & CSV.",
    );

  const into = opts.into
    ? relative(vault.root, resolve(vault.root, opts.into)).split(sep).join('/')
    : '';
  if (into.startsWith('..'))
    throw new NoteError('invalid_argument', `${opts.into} is outside the vault.`);
  const result: ImportResult = { notes: 0, attachments: 0, skipped: [] };

  // A database exports both `DB.csv` and `DB_all.csv` (every column); keep the fuller one.
  const csvs = new Map<string, SourceFile>();
  for (const f of files.filter((f) => /\.csv$/i.test(f.path))) {
    const key = f.path.replace(/_all\.csv$/i, '.csv');
    if (!csvs.has(key) || /_all\.csv$/i.test(f.path)) csvs.set(key, f);
  }
  const pages = files.filter((f) => /\.md$/i.test(f.path));
  const others = files.filter((f) => !/\.(md|csv)$/i.test(f.path));

  // Where everything lands, ids off, names kept apart if two clean to the same.
  const taken = new Set<string>();
  const place = (path: string, asNote: boolean): { rel: string; id?: string; title: string } => {
    const parts = path.split('/');
    let id: string | undefined;
    const clean = parts.map((p, i) => {
      const c = cleanName(i === parts.length - 1 && asNote ? p.replace(/\.csv$/i, '.md') : p);
      if (i === parts.length - 1) id = c.id;
      return c.name;
    });
    const dir = clean.slice(0, -1).join('/');
    const last = clean[clean.length - 1]!;
    const ext = posix.extname(last);
    const stem = ext ? last.slice(0, -ext.length) : last;
    for (let n = 1; ; n++) {
      const name = n === 1 ? last : `${stem} ${n}${ext}`;
      const rel = [into, dir, name].filter(Boolean).join('/');
      if (!taken.has(rel.toLowerCase()) && !existsSync(join(vault.root, ...rel.split('/')))) {
        taken.add(rel.toLowerCase());
        // The title stays the clean name even when the file needs " 2": links go by title.
        return { rel, ...(id ? { id } : {}), title: stem };
      }
    }
  };

  // Already imported: the page's Notion id is its note id here.
  const noteId = (id: string) => `notion-${id}`;
  const already = async (id: string | undefined) =>
    id
      ? vault.get({ id: noteId(id) }).then(
          () => true,
          () => false,
        )
      : false;

  const placed = new Map<string, { rel: string; title?: string; note: boolean }>();
  const byId = new Map<string, string>(); // notion id → title, for notion.so links
  const work: { file: SourceFile; rel: string; title: string; id?: string; csv?: boolean }[] = [];
  for (const file of [...pages, ...csvs.values()]) {
    const csv = /\.csv$/i.test(file.path);
    const id = cleanName(
      file.path
        .split('/')
        .pop()!
        .replace(/(_all)?\.(md|csv)$/i, ''),
    ).id;
    if (await already(id)) {
      result.skipped.push({
        // Its name as it would have been here, not Notion's with the id.
        source: file.path
          .replace(/_all\.csv$/i, '.csv')
          .split('/')
          .map((p) => cleanName(p).name)
          .join('/'),
        reason: 'already imported',
      });
      continue;
    }
    const spot = place(file.path.replace(/_all\.csv$/i, '.csv'), true);
    // Links go to a page by the title at its top — Notion writes it as `# Title`.
    const heading = csv
      ? undefined
      : /^\s*#\s+(.+?)\s*$/m.exec(
          file.data.subarray(0, 4000).toString('utf8').split('\n')[0] ?? '',
        )?.[1];
    spot.title = heading ?? spot.title;
    placed.set(file.path, { rel: spot.rel, title: spot.title, note: true });
    if (csv)
      placed.set(file.path.replace(/_all\.csv$/i, '.csv'), {
        rel: spot.rel,
        title: spot.title,
        note: true,
      });
    if (id) byId.set(id, spot.title);
    work.push({ file, rel: spot.rel, title: spot.title, ...(id ? { id } : {}), csv });
  }
  for (const file of others)
    placed.set(file.path, { rel: place(file.path, false).rel, note: false });

  const titles = new Set(work.filter((w) => !w.csv).map((w) => w.title));

  // Notion's nesting, as nested tags — the way Heapnotes (like Bear) shows a
  // hierarchy. A page sits under the tag of the folder it's in; a page with
  // subpages carries the tag they sit under, so its tag shows it with them.
  const cleanPath = (p: string) =>
    p
      .split('/')
      .filter((s) => s && s !== '.')
      .map((s) => cleanName(s).name)
      .join('/');
  // Folders that hold pages; one holding only a page's images isn't nesting.
  const folders = new Set<string>();
  for (const f of files.filter((f) => /\.(md|csv)$/i.test(f.path))) {
    const parts = cleanPath(posix.dirname(f.path)).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const databases = new Set(
    work.filter((w) => w.csv).map((w) => cleanPath(w.file.path.replace(/(_all)?\.csv$/i, ''))),
  );
  const tagFor = (w: (typeof work)[number]): string | undefined => {
    const own = cleanPath(w.file.path.replace(/(_all)?\.(md|csv)$/i, ''));
    const dir = cleanPath(posix.dirname(w.file.path));
    const tag = folders.has(own) ? own : dir;
    // A tag can't hold "#"; the rest — spaces, emoji — it can.
    return tag ? normalizeTagName(tag.replace(/#/g, '')) : undefined;
  };
  /** A database row's `Key: value` lines, which Markdown would run into one paragraph. */
  const properties = (body: string): string =>
    body.replace(
      /^(# [^\n]*\n\n?)((?:[^\n:#>|-][^\n:]{0,60}: [^\n]*\n?)+)/,
      (_m, head: string, block: string) =>
        `${head}${block
          .trimEnd()
          .split('\n')
          .map((l) => {
            const i = l.indexOf(': ');
            return `- **${l.slice(0, i).trim()}:** ${l.slice(i + 2).trim()}`;
          })
          .join('\n')}\n`,
    );
  result.tags = [];

  /** A Markdown link from page `from` (export path), pointed at its new place. */
  const relinkOne = (
    from: string,
    newRel: string,
    bang: string,
    text: string,
    target: string,
  ): string => {
    const raw = target.trim().replace(/^<|>$/g, '');
    const notionUrl = /^https?:\/\/(?:www\.)?notion\.so\/.*?([0-9a-f]{32})(?:[?#].*)?$/i.exec(raw);
    if (notionUrl) {
      const title = byId.get(notionUrl[1]!.toLowerCase());
      return title ? wiki(title, text) : `${bang}[${text}](${target})`;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#'))
      return `${bang}[${text}](${target})`;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // Literal.
    }
    const hit = placed.get(posix.normalize(posix.join(posix.dirname(from), decoded)));
    if (!hit) return `${bang}[${text}](${target})`;
    if (hit.note && !bang) return wiki(hit.title!, text);
    const rel = posix.relative(posix.dirname(newRel), hit.rel) || posix.basename(hit.rel);
    return `${bang}[${text}](${rel.split('/').map(encodeURIComponent).join('/')})`;
  };
  const wiki = (title: string, text: string) =>
    !text || text.trim() === title ? `[[${title}]]` : `[[${title}|${text.trim()}]]`;

  for (const w of work) {
    let body: string;
    if (w.csv) {
      const rows = parseCsv(w.file.data.toString('utf8'));
      body = `# ${w.title}\n\n${rows.length ? tableFromCsv(rows, titles) : '_An empty database._'}\n`;
    } else {
      body = w.file.data
        .toString('utf8')
        .replace(
          /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g,
          (_m, bang: string, text: string, target: string) =>
            relinkOne(w.file.path, w.rel, bang, text, target),
        )
        // Callouts: <aside>💡 text</aside> → a quote, which Markdown has.
        .replace(/<aside>\s*([\s\S]*?)\s*<\/aside>/g, (_m, inner: string) =>
          inner
            .split('\n')
            .map((l) => `> ${l}`.trimEnd())
            .join('\n'),
        );
      if (!/^\s*# /.test(body)) body = `# ${w.title}\n\n${body}`;
      if (databases.has(cleanPath(posix.dirname(w.file.path)))) body = properties(body);
    }
    const tag = tagFor(w);
    if (tag) {
      // Under the title, where Bear writes a note's tags.
      body = body.replace(/^(\s*# [^\n]*\n)/, `$1${formatTag(tag)}\n`);
      const top = tag.split('/')[0]!;
      if (!result.tags.includes(top)) result.tags.push(top);
    }
    const text = updateFrontMatter(body.endsWith('\n') ? body : `${body}\n`, {
      ...(w.id ? { id: noteId(w.id) } : {}),
      created: w.file.modified.toISOString(),
      source: 'notion',
    });
    const abs = join(vault.root, ...w.rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, 'utf8');
    await utimes(abs, w.file.modified, w.file.modified).catch(() => undefined);
    result.notes++;
  }
  for (const file of others) {
    const hit = placed.get(file.path)!;
    const abs = join(vault.root, ...hit.rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.data);
    result.attachments++;
  }
  if (!result.tags?.length) delete result.tags;
  await vault.refresh(true);
  return result;
}
