import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { NoteError } from './errors.js';
import { readFrontMatter, updateFrontMatter } from './frontMatter.js';
import { parseNote } from './parse.js';
import { fileStem, type Vault } from './vault.js';

/**
 * Bringing notes in: a Markdown folder, an Obsidian
 * vault, or Bear. Each copies — the source is never changed — and gives every
 * note an `id` and `created` in its front matter, keeping its file dates.
 */
export interface ImportResult {
  notes: number;
  attachments: number;
  /** Notes left out, and why: already imported, unreadable, … */
  skipped: { source: string; reason: string }[];
}

export interface ImportOptions {
  /** A folder inside the vault to import into. Default: the vault's top level. */
  into?: string;
}

/**
 * A folder of `.md` files, layout kept. Files the notes link to by relative
 * path come along to the same relative place, so the links keep working.
 */
export async function importMarkdownFolder(vault: Vault, source: string, opts: ImportOptions = {}): Promise<ImportResult> {
  return importFolder(vault, source, opts, { allFiles: false });
}

/**
 * An Obsidian vault. Same as a Markdown folder, but every attachment comes
 * along — Obsidian's `![[photo.png]]` names a file by its name alone, wherever
 * it sits — and `.obsidian/` settings stay behind. Heapnotes reads `[[links]]`,
 * `![[embeds]]` and front-matter `tags:` as they are, so nothing is rewritten.
 */
export async function importObsidian(vault: Vault, source: string, opts: ImportOptions = {}): Promise<ImportResult> {
  return importFolder(vault, source, opts, { allFiles: true });
}

async function importFolder(vault: Vault, source: string, opts: ImportOptions, mode: { allFiles: boolean }): Promise<ImportResult> {
  const src = resolve(source);
  const st = await stat(src).catch(() => null);
  if (!st?.isDirectory()) throw new NoteError('not_found', `${source} isn't a folder.`);
  if (isInside(vault.root, src) || isInside(src, vault.root)) {
    throw new NoteError('invalid_argument', 'Import from a folder outside the vault (and not one that contains it).');
  }
  const into = intoFolder(vault, opts.into);
  const result: ImportResult = { notes: 0, attachments: 0, skipped: [] };
  const { notes, files } = await listFolder(src);
  const wanted = new Set<string>(mode.allFiles ? files : []);

  for (const rel of notes) {
    const from = join(src, ...rel.split('/'));
    let text: string;
    try {
      text = await readFile(from, 'utf8');
    } catch (err) {
      result.skipped.push({ source: rel, reason: (err as Error).message });
      continue;
    }
    for (const link of parseNote(text).localLinks) {
      const target = posix.normalize(posix.join(posix.dirname(rel), link.path));
      if (!target.startsWith('..') && files.includes(target)) wanted.add(target);
    }
    const times = await stat(from);
    const dir = posix.dirname(rel);
    const placed = await placeNote(vault.root, joinRel(into, dir === '.' ? '' : dir), basename(rel, extname(rel)), withIdentity(text, times.birthtime), times);
    if (!placed) result.skipped.push({ source: rel, reason: "front matter isn't valid YAML" });
    else result.notes++;
  }
  for (const rel of wanted) {
    const dest = join(vault.root, ...joinRel(into, rel).split('/'));
    if (existsSync(dest)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(src, ...rel.split('/')), dest);
    result.attachments++;
  }
  await vault.refresh(true);
  return result;
}

// ── Bear ──────────────────────────────────────────────────────────────────

/** Runs bearcli and returns stdout. Swappable so tests need no Bear. */
export type BearCli = (args: string[]) => Promise<Buffer>;

export const BEARCLI_PATH = '/Applications/Bear.app/Contents/MacOS/bearcli';

export function bearCli(path = BEARCLI_PATH): BearCli {
  const run = promisify(execFile);
  return async (args) => {
    const { stdout } = await run(path, args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    return stdout;
  };
}

interface BearNote {
  id: string;
  title?: string;
  created?: string;
  modified?: string;
  pins?: string[];
  location?: 'notes' | 'archive' | 'trash';
  attachments?: string[];
  /** bearcli says "yes" / "no". */
  locked?: string | boolean;
  content?: string;
}

/**
 * Straight out of Bear through `bearcli`, Bear's own command-line tool
 * (Bear 3+): every note with its dates, pin, archive and trash state, and its
 * attachments. Bear's ids are kept, so running it again skips what's already
 * here instead of duplicating it. Encrypted notes stay in Bear — bearcli never
 * hands them out.
 */
export async function importBear(vault: Vault, opts: ImportOptions & { cli?: BearCli } = {}): Promise<ImportResult> {
  const cli = opts.cli ?? bearCli();
  const into = intoFolder(vault, opts.into);
  let notes: BearNote[];
  try {
    notes = JSON.parse((await cli(['list', '--location', 'all', '--format', 'json', '--fields', 'all,content'])).toString('utf8')) as BearNote[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new NoteError(
      'not_found',
      code === 'ENOENT'
        ? "Couldn't find Bear's bearcli. Bear 3 or newer ships it; or export from Bear (File → Export Notes, Markdown or TextBundle) and import that folder."
        : `bearcli failed: ${(err as Error).message}`,
    );
  }
  await vault.refresh(true);
  const result: ImportResult = { notes: 0, attachments: 0, skipped: [] };
  for (const note of notes) {
    if (note.locked === true || note.locked === 'yes') {
      result.skipped.push({ source: note.title ?? note.id, reason: 'locked in Bear' });
      continue;
    }
    if (await exists(vault, note.id)) {
      result.skipped.push({ source: note.title ?? note.id, reason: 'already imported' });
      continue;
    }
    let content = note.content ?? '';
    const trashed = note.location === 'trash';
    const folder = joinRel(trashed ? '.trash' : '', into);
    const assetsDir = joinRel(folder, 'assets');
    for (const filename of note.attachments ?? []) {
      let data: Buffer;
      try {
        data = await cli(['attachments', 'save', note.id, '--filename', filename]);
      } catch (err) {
        result.skipped.push({ source: `${note.title ?? note.id} / ${filename}`, reason: (err as Error).message });
        continue;
      }
      const saved = await uniqueFile(vault.root, assetsDir, filename);
      await mkdir(dirname(join(vault.root, ...saved.split('/'))), { recursive: true });
      await writeFile(join(vault.root, ...saved.split('/')), data);
      result.attachments++;
      content = relink(content, filename, `assets/${posix.basename(saved)}`);
    }
    const created = parseDate(note.created);
    const modified = parseDate(note.modified);
    const text = updateFrontMatter(content.endsWith('\n') ? content : `${content}\n`, {
      id: note.id,
      ...(created ? { created: created.toISOString() } : {}),
      ...(note.pins?.includes('global') ? { pinned: true } : {}),
      ...(note.location === 'archive' ? { archived: true } : {}),
      ...(trashed ? { trashed: (modified ?? new Date()).toISOString() } : {}),
    });
    const times = modified ? { atime: modified, mtime: modified } : undefined;
    await placeNote(vault.root, folder, fileStem(parseNote(text).title || note.title || 'Untitled'), text, times);
    result.notes++;
  }
  await vault.refresh(true);
  return result;
}

/**
 * A folder Bear exported (File → Export Notes): Markdown files with their
 * images in a folder named after each note, or TextBundles. TextBundles are
 * unpacked — their `assets/` become the note's attachments.
 */
export async function importBearExport(vault: Vault, source: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const src = resolve(source);
  const st = await stat(src).catch(() => null);
  if (!st?.isDirectory()) throw new NoteError('not_found', `${source} isn't a folder.`);
  const into = intoFolder(vault, opts.into);
  const result = await importFolder(vault, src, opts, { allFiles: false });

  for (const bundle of await findBundles(src)) {
    const textFile = ['text.md', 'text.markdown', 'text.txt'].map((f) => join(bundle, f)).find((f) => existsSync(f));
    const name = basename(bundle).replace(/\.textbundle$/i, '');
    if (!textFile) {
      result.skipped.push({ source: name, reason: 'TextBundle has no text file' });
      continue;
    }
    let text = await readFile(textFile, 'utf8');
    const assetsSrc = join(bundle, 'assets');
    for (const file of existsSync(assetsSrc) ? await readdir(assetsSrc) : []) {
      const saved = await uniqueFile(vault.root, joinRel(into, 'assets'), file);
      await mkdir(dirname(join(vault.root, ...saved.split('/'))), { recursive: true });
      await copyFile(join(assetsSrc, file), join(vault.root, ...saved.split('/')));
      text = relink(text, `assets/${file}`, `assets/${posix.basename(saved)}`);
      result.attachments++;
    }
    const times = await stat(textFile);
    await placeNote(vault.root, into, fileStem(parseNote(text).title || name), withIdentity(text, times.birthtime), times);
    result.notes++;
  }
  await vault.refresh(true);
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function exists(vault: Vault, id: string): Promise<boolean> {
  try {
    await vault.resolve({ id });
    return true;
  } catch {
    return false;
  }
}

/** Add `id` and `created` unless the note has them. Broken front matter is left as it is. */
function withIdentity(text: string, birth: Date): string | null {
  const fm = readFrontMatter(text);
  if (fm.invalid) return null;
  const patch: Record<string, unknown> = {};
  if (fm.data.id === undefined) patch.id = randomUUID().toUpperCase();
  if (fm.data.created === undefined && !Number.isNaN(birth.getTime())) patch.created = birth.toISOString();
  return Object.keys(patch).length ? updateFrontMatter(text, patch) : text;
}

async function placeNote(root: string, folder: string, stem: string, text: string | null, times?: { atime: Date; mtime: Date }): Promise<string | null> {
  if (text === null) return null;
  const path = await uniqueFile(root, folder, `${stem}.md`);
  const abs = join(root, ...path.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text, 'utf8');
  if (times) await utimes(abs, times.atime, times.mtime);
  return path;
}

async function uniqueFile(root: string, folder: string, name: string): Promise<string> {
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; ; n++) {
    const candidate = joinRel(folder, n === 1 ? name : `${base} ${n}${ext}`);
    if (!existsSync(join(root, ...candidate.split('/')))) return candidate;
  }
}

/** Point links at a file's new place — written encoded or not. */
function relink(text: string, from: string, to: string): string {
  const encodedTo = to.split('/').map(encodeURIComponent).join('/');
  const variants = new Set([from, encodeURI(from), from.split('/').map(encodeURIComponent).join('/')]);
  let out = text;
  for (const v of variants) out = out.split(`](${v})`).join(`](${encodedTo})`).split(`](<${v}>)`).join(`](${encodedTo})`);
  return out;
}

async function listFolder(root: string): Promise<{ notes: string[]; files: string[] }> {
  const notes: string[] = [];
  const files: string[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (/\.textbundle$/i.test(e.name)) continue;
        await visit(join(dir, e.name), childRel);
      } else if (e.isFile()) {
        (/\.(?:md|markdown)$/i.test(e.name) ? notes : files).push(childRel);
      }
    }
  }
  await visit(root, '');
  return { notes, files };
}

async function findBundles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (/\.textbundle$/i.test(e.name)) out.push(join(dir, e.name));
      else await visit(join(dir, e.name));
    }
  }
  await visit(root);
  return out;
}

function intoFolder(vault: Vault, into: string | undefined): string {
  if (!into) return '';
  const abs = resolve(vault.root, into);
  if (!isInside(vault.root, abs)) throw new NoteError('invalid_argument', `${into} is outside the vault.`);
  return relative(vault.root, abs).split(sep).join('/');
}

function joinRel(a: string, b: string): string {
  return [a, b].filter(Boolean).join('/');
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && resolve(rel) !== rel);
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
