import { NoteError } from './errors.js';
import type { SortField } from './noteIndex.js';
import type { NoteRef, Vault } from './vault.js';
import { requestFocus } from './focus.js';

/**
 * Every Heapnotes command, defined once. `heapcode notes <cli>` and the MCP
 * server (`heapcode notes mcp`) are two front ends over this one table, the
 * way bearcli's CLI and mcp-server are — so a
 * tool an agent calls and a command a person types can never drift apart.
 */
export interface Command {
  /** The MCP tool name. */
  name: string;
  /** The CLI subcommand. */
  cli: string;
  description: string;
  /** JSON Schema for the arguments (an object). */
  input: { type: 'object'; properties: Record<string, Schema>; required?: string[] };
  /** CLI arguments taken by position, in order. */
  positional?: string[];
  /** Changes nothing — safe to call any time. */
  readOnly: boolean;
  /** Left off the MCP: too destructive to hand an agent. */
  cliOnly?: boolean;
  /** What a CLI table shows when `--fields` isn't given. */
  fields?: string[];
  run(vault: Vault, args: Record<string, unknown>): Promise<unknown>;
}

export interface Schema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description: string;
  enum?: string[];
  items?: { type: 'string' };
}

const ref = {
  id: { type: 'string', description: 'The note id (from list_notes / search_notes).' },
  title: { type: 'string', description: 'Or the note title, case-insensitive; must be unique.' },
  path: {
    type: 'string',
    description: 'Or the vault-relative file path, e.g. "Projects/Plan.md".',
  },
} satisfies Record<string, Schema>;

const guard = {
  base: {
    type: 'string',
    description:
      'The hash from your last read. The write is refused if the note (or the section) changed since — read again and retry.',
  },
  section: {
    type: 'string',
    description:
      'Limit to one section: a heading line like "## Setup", a nested path "# Guide\\n## Setup", or "preamble". See outline_note.',
  },
  index: {
    type: 'integer',
    description: 'Which match, when the section address repeats (1-based).',
  },
} satisfies Record<string, Schema>;

const paging = {
  location: {
    type: 'string',
    enum: ['notes', 'archive', 'trash', 'all'],
    description: 'Where to look. Default: notes (not archived, not trashed).',
  },
  sort: {
    type: 'string',
    description:
      'Comma-separated fields with :asc/:desc — modified, created, title. Default: pinned first, then newest modified.',
  },
  limit: { type: 'integer', description: 'At most this many (default 100).' },
  offset: { type: 'integer', description: 'Skip this many, for paging.' },
} satisfies Record<string, Schema>;

const LIST_FIELDS = ['id', 'title', 'tags', 'modified'];

export const COMMANDS: Command[] = [
  {
    name: 'list_notes',
    cli: 'list',
    description:
      'List notes, newest first with pinned on top. Filter by tag (subtags included) or a smart section. Returns { notes, total }.',
    input: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Only notes with this tag or one of its subtags.' },
        section: {
          type: 'string',
          enum: ['all', 'untagged', 'todo', 'today', 'pinned'],
          description:
            'A smart section: untagged, todo (has open tasks), today (modified today), pinned.',
        },
        ...paging,
      },
    },
    readOnly: true,
    fields: LIST_FIELDS,
    run: (v, a) =>
      v.list({
        ...pageArgs(a),
        ...(str(a.tag) ? { tag: str(a.tag)! } : {}),
        ...(a.section ? { section: a.section as 'all' } : {}),
      }),
  },
  {
    name: 'search_notes',
    cli: 'search',
    description:
      'Search notes with Bear\'s syntax: words (prefix-matched), "exact phrase", -exclude, #tag (subtags included), and tokens — @today @yesterday @last7days @date(YYYY-MM-DD) @date(<YYYY-MM-DD) @ctoday @created7days @cdate(…) @todo @done @task @tagged @untagged @title @pinned @images @files @attachments @code @wikilinks @backlinks. All combine with AND; -@token negates. Results with words carry a snippet. Returns { notes, total }.',
    input: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search.' }, ...paging },
      required: ['query'],
    },
    positional: ['query'],
    readOnly: true,
    fields: LIST_FIELDS,
    run: (v, a) => v.search(need(a, 'query'), pageArgs(a)),
  },
  {
    name: 'get_note',
    cli: 'show',
    description:
      "A note's details without its text: title, tags, dates, task counts, pin and location, its [[links]] (with the id each resolves to) and how many notes link to it, plus the hash for writes.",
    input: { type: 'object', properties: { ...ref } },
    positional: ['id'],
    readOnly: true,
    run: (v, a) => v.get(refOf(a)),
  },
  {
    name: 'read_note',
    cli: 'cat',
    description:
      "Read a note's Markdown (without its front matter): all of it, one section, or a character range. Returns { content, hash, … } — pass hash as base when you write, so you never overwrite a change you didn't see.",
    input: {
      type: 'object',
      properties: {
        ...ref,
        section: guard.section,
        index: guard.index,
        offset: { type: 'integer', description: 'Start at this character.' },
        limit: { type: 'integer', description: 'Read at most this many characters.' },
      },
    },
    positional: ['id'],
    readOnly: true,
    run: (v, a) =>
      v.read(refOf(a), {
        ...opt(a, 'section', str),
        ...opt(a, 'index', int),
        ...opt(a, 'offset', int),
        ...opt(a, 'limit', int),
      }),
  },
  {
    name: 'outline_note',
    cli: 'outline',
    description:
      "A note's headings as sections, each with the address that reaches it, its offset, length and hash. Use an address with read_note, append_to_note, overwrite_note or edit_note to work on one section.",
    input: { type: 'object', properties: { ...ref } },
    positional: ['id'],
    readOnly: true,
    run: (v, a) => v.outline(refOf(a)),
  },
  {
    name: 'search_in_note',
    cli: 'search-in',
    description:
      'Find every occurrence of exact text in one note, with line, column and the line it is on. Use it before edit_note to make sure the text you will replace is unique.',
    input: {
      type: 'object',
      properties: {
        ...ref,
        text: { type: 'string', description: 'The text to find.' },
        caseSensitive: { type: 'boolean', description: 'Match case exactly (default: no).' },
      },
      required: ['text'],
    },
    positional: ['id', 'text'],
    readOnly: true,
    run: (v, a) =>
      v.searchInNote(refOf(a), need(a, 'text'), { caseSensitive: a.caseSensitive === true }),
  },
  {
    name: 'list_backlinks',
    cli: 'backlinks',
    description: 'Notes that link to this one with [[wiki links]].',
    input: { type: 'object', properties: { ...ref } },
    positional: ['id'],
    readOnly: true,
    fields: LIST_FIELDS,
    run: (v, a) => v.backlinks(refOf(a)),
  },
  {
    name: 'create_note',
    cli: 'create',
    description:
      'Create a note. The title becomes its first line ("# Title") and its file name; tags go on the line under it. Markup: **bold** *italic* ~underline~ ~~strike~~ ==highlight== `code`, #tag / #nested/tag / #multi word tag#, [[Note title]] links, - [ ] tasks.',
    input: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title.' },
        text: { type: 'string', description: 'The body, in Markdown.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add, without #.' },
        folder: { type: 'string', description: 'A folder in the vault to put it in.' },
        pinned: { type: 'boolean', description: 'Pin it.' },
      },
    },
    positional: ['text'],
    readOnly: false,
    run: (v, a) =>
      v.create({
        ...opt(a, 'title', str),
        ...opt(a, 'text', str),
        ...opt(a, 'folder', str),
        ...(Array.isArray(a.tags) ? { tags: a.tags.map(String) } : {}),
        pinned: a.pinned === true,
      }),
  },
  {
    name: 'append_to_note',
    cli: 'append',
    description:
      'Add text to the end of a note or of one section — or with position "start", just under the title (or the section heading).',
    input: {
      type: 'object',
      properties: {
        ...ref,
        text: { type: 'string', description: 'What to add, in Markdown.' },
        position: { type: 'string', enum: ['end', 'start'], description: 'Default: end.' },
        ...guard,
      },
      required: ['text'],
    },
    positional: ['id', 'text'],
    readOnly: false,
    run: (v, a) =>
      v.append(refOf(a), need(a, 'text'), {
        ...guardOf(a),
        ...(a.position === 'start' ? { position: 'start' as const } : {}),
      }),
  },
  {
    name: 'overwrite_note',
    cli: 'overwrite',
    description:
      "Replace a note's text — or one section of it, heading included — with new Markdown. The note keeps its id, pins and dates. Prefer edit_note for small changes; pass base so you can't clobber an edit you haven't seen.",
    input: {
      type: 'object',
      properties: { ...ref, text: { type: 'string', description: 'The new Markdown.' }, ...guard },
      required: ['text'],
    },
    positional: ['id', 'text'],
    readOnly: false,
    run: (v, a) => v.overwrite(refOf(a), need(a, 'text', true), guardOf(a)),
  },
  {
    name: 'edit_note',
    cli: 'edit',
    description:
      'Find exact text in a note and replace it, insert before or after it, or delete it — say exactly one. If the text appears more than once the edit is refused (with the lines) unless you pass occurrence (which one, 1-based) or all.',
    input: {
      type: 'object',
      properties: {
        ...ref,
        find: { type: 'string', description: 'Exact text that is in the note now.' },
        replace: { type: 'string', description: 'Replace it with this.' },
        insertBefore: { type: 'string', description: 'Or insert this before it.' },
        insertAfter: { type: 'string', description: 'Or insert this after it.' },
        delete: { type: 'boolean', description: 'Or delete it.' },
        occurrence: { type: 'integer', description: 'Only this match (1-based).' },
        all: { type: 'boolean', description: 'Every match.' },
        ...guard,
      },
      required: ['find'],
    },
    positional: ['id'],
    readOnly: false,
    run: (v, a) =>
      v.edit(refOf(a), {
        find: need(a, 'find', true),
        ...opt(a, 'replace', strAllowEmpty),
        ...opt(a, 'insertBefore', strAllowEmpty),
        ...opt(a, 'insertAfter', strAllowEmpty),
        ...(a.delete === true ? { delete: true } : {}),
        ...opt(a, 'occurrence', int),
        ...(a.all === true ? { all: true } : {}),
        ...guardOf(a),
      }),
  },
  {
    name: 'duplicate_note',
    cli: 'duplicate',
    description: 'Copy a note as a new note (new id, not pinned).',
    input: { type: 'object', properties: { ...ref } },
    positional: ['id'],
    readOnly: false,
    run: (v, a) => v.duplicate(refOf(a)),
  },
  noteAction('pin_note', 'pin', 'Pin a note to the top of the list.', (v, r) => v.pin(r, true)),
  noteAction('unpin_note', 'unpin', 'Unpin a note.', (v, r) => v.pin(r, false)),
  noteAction(
    'archive_note',
    'archive',
    'Move a note to the archive: out of the list and search, kept.',
    (v, r) => v.archive(r),
  ),
  noteAction(
    'trash_note',
    'trash',
    "Move a note to the trash (the vault's .trash/ folder). restore_note brings it back.",
    (v, r) => v.trash(r),
  ),
  noteAction(
    'restore_note',
    'restore',
    'Bring a note back from the trash or the archive.',
    (v, r) => v.restore(r),
  ),
  {
    name: 'delete_note',
    cli: 'delete',
    description: 'Delete a trashed note for good.',
    input: { type: 'object', properties: { ...ref } },
    positional: ['id'],
    readOnly: false,
    cliOnly: true,
    run: async (v, a) => {
      await v.deletePermanently(refOf(a));
      return { deleted: true };
    },
  },
  {
    name: 'empty_trash',
    cli: 'empty-trash',
    description: 'Delete every note in the trash for good.',
    input: { type: 'object', properties: {} },
    readOnly: false,
    cliOnly: true,
    run: (v) => v.emptyTrash(),
  },
  {
    name: 'list_tags',
    cli: 'tags',
    description:
      'Every tag on notes in the list, with how many notes carry it. Nested tags are written parent/child.',
    input: { type: 'object', properties: {} },
    readOnly: true,
    fields: ['tag', 'count'],
    run: (v) => v.tags(),
  },
  tagAction(
    'add_tag',
    'tag-add',
    'Add a tag to a note, on the tag line under its title.',
    (v, r, t) => v.addTag(r, t),
  ),
  tagAction('remove_tag', 'tag-remove', 'Remove a tag from a note (its subtags stay).', (v, r, t) =>
    v.removeTag(r, t),
  ),
  {
    name: 'rename_tag',
    cli: 'tag-rename',
    description:
      'Rename a tag in every note, subtags included: work → job turns #work/q3 into #job/q3.',
    input: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'The tag now.' },
        to: { type: 'string', description: 'Its new name.' },
      },
      required: ['from', 'to'],
    },
    positional: ['from', 'to'],
    readOnly: false,
    run: (v, a) => v.renameTag(need(a, 'from'), need(a, 'to')),
  },
  {
    name: 'delete_tag',
    cli: 'tag-delete',
    description: 'Remove a tag (and its subtags) from every note. The notes themselves stay.',
    input: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'The tag.' } },
      required: ['tag'],
    },
    positional: ['tag'],
    readOnly: false,
    run: (v, a) => v.deleteTag(need(a, 'tag')),
  },
  {
    name: 'list_attachments',
    cli: 'attachments',
    description: 'Files a note links to or embeds: images, PDFs, anything in the vault.',
    input: { type: 'object', properties: { ...ref } },
    positional: ['id'],
    readOnly: true,
    fields: ['filename', 'size', 'path'],
    run: (v, a) => v.listAttachments(refOf(a)),
  },
  {
    name: 'add_attachment',
    cli: 'attach',
    description:
      "Save a file into the note's assets/ folder and link it at the end of the note (an image shows inline).",
    input: {
      type: 'object',
      properties: {
        ...ref,
        filename: { type: 'string', description: 'File name, with extension.' },
        base64: { type: 'string', description: 'The file, base64-encoded.' },
      },
      required: ['filename', 'base64'],
    },
    positional: ['id', 'filename'],
    readOnly: false,
    run: (v, a) =>
      v.addAttachment(refOf(a), need(a, 'filename'), Buffer.from(need(a, 'base64'), 'base64')),
  },
  {
    name: 'read_attachment',
    cli: 'attachment',
    description: "Read one of a note's attachments. Returns { filename, size, base64 }.",
    input: {
      type: 'object',
      properties: {
        ...ref,
        filename: { type: 'string', description: 'Its file name (see list_attachments).' },
      },
      required: ['filename'],
    },
    positional: ['id', 'filename'],
    readOnly: true,
    run: async (v, a) => {
      const { attachment, data } = await v.readAttachment(refOf(a), need(a, 'filename'));
      return { ...attachment, base64: data.toString('base64') };
    },
  },
  {
    name: 'delete_attachment',
    cli: 'detach',
    description:
      "Remove a note's links to an attachment, and the file itself once no other note uses it.",
    input: {
      type: 'object',
      properties: { ...ref, filename: { type: 'string', description: 'Its file name.' } },
      required: ['filename'],
    },
    positional: ['id', 'filename'],
    readOnly: false,
    run: (v, a) => v.deleteAttachment(refOf(a), need(a, 'filename')),
  },
  {
    name: 'open_note',
    cli: 'open',
    description:
      'Show a note to the user in the Heapnotes app (heapcode web, at /notes). Says whether an open app showed it; when none is open, tell the user where the note is instead.',
    input: { type: 'object', properties: { ...ref } },
    positional: ['id'],
    readOnly: true,
    run: async (v, a) => {
      const note = await v.get(refOf(a));
      const shown = await requestFocus(v.root, note.id);
      return {
        id: note.id,
        title: note.title,
        path: note.path,
        shown,
        message: shown
          ? 'Shown in Heapnotes.'
          : 'No Heapnotes app has this vault open. Run `heapcode web` and open /notes to see it.',
      };
    },
  },
  {
    name: 'reindex',
    cli: 'reindex',
    description: 'Rebuild the search index from the files.',
    input: { type: 'object', properties: {} },
    readOnly: false,
    cliOnly: true,
    run: (v) => v.rebuild(),
  },
];

function noteAction(
  name: string,
  cli: string,
  description: string,
  fn: (v: Vault, r: NoteRef) => Promise<unknown>,
): Command {
  return {
    name,
    cli,
    description,
    input: { type: 'object', properties: { ...ref } },
    positional: ['id'],
    readOnly: false,
    run: (v, a) => fn(v, refOf(a)),
  };
}

function tagAction(
  name: string,
  cli: string,
  description: string,
  fn: (v: Vault, r: NoteRef, tag: string) => Promise<unknown>,
): Command {
  return {
    name,
    cli,
    description,
    input: {
      type: 'object',
      properties: { ...ref, tag: { type: 'string', description: 'The tag, without #.' } },
      required: ['tag'],
    },
    positional: ['id', 'tag'],
    readOnly: false,
    run: (v, a) => fn(v, refOf(a), need(a, 'tag')),
  };
}

export function findCommand(by: { name?: string; cli?: string }): Command | undefined {
  return COMMANDS.find(
    (c) =>
      (by.name !== undefined && c.name === by.name) || (by.cli !== undefined && c.cli === by.cli),
  );
}

/**
 * Check arguments against a command's schema, coercing what a CLI hands over
 * as text ("3", "true"). Unknown keys are refused, so a misspelt `sectoin`
 * fails loudly instead of being silently ignored.
 */
export function checkArgs(cmd: Command, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const schema = cmd.input.properties[key];
    if (!schema)
      throw new NoteError(
        'invalid_argument',
        `${cmd.name} has no argument "${key}". It takes: ${Object.keys(cmd.input.properties).join(', ') || 'nothing'}.`,
      );
    out[key] = coerce(key, schema, value);
  }
  for (const key of cmd.input.required ?? []) {
    if (out[key] === undefined)
      throw new NoteError('invalid_argument', `${cmd.name} needs "${key}".`);
  }
  return out;
}

function coerce(key: string, schema: Schema, value: unknown): unknown {
  const bad = (): never => {
    throw new NoteError(
      'invalid_argument',
      `"${key}" should be ${schema.type === 'integer' ? 'a whole number' : `a ${schema.type}`}.`,
    );
  };
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') bad();
      if (schema.enum && !schema.enum.includes(value as string)) {
        throw new NoteError(
          'invalid_argument',
          `"${key}" must be one of ${schema.enum.join(', ')}.`,
        );
      }
      return value;
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (
        typeof n !== 'number' ||
        Number.isNaN(n) ||
        (schema.type === 'integer' && !Number.isInteger(n))
      )
        bad();
      return n;
    }
    case 'boolean':
      if (value === 'true') return true;
      if (value === 'false') return false;
      if (typeof value !== 'boolean') bad();
      return value;
    case 'array': {
      const list = Array.isArray(value) ? value : [value];
      if (!list.every((x) => typeof x === 'string')) bad();
      return list;
    }
  }
}

function refOf(a: Record<string, unknown>): NoteRef {
  const given = (['id', 'path', 'title'] as const).filter(
    (k) => typeof a[k] === 'string' && (a[k] as string) !== '',
  );
  if (given.length !== 1)
    throw new NoteError('invalid_argument', 'Say which note: exactly one of id, title or path.');
  const k = given[0]!;
  return { [k]: a[k] as string } as NoteRef;
}

function guardOf(a: Record<string, unknown>): { base?: string; section?: string; index?: number } {
  return { ...opt(a, 'base', str), ...opt(a, 'section', str), ...opt(a, 'index', int) };
}

function pageArgs(a: Record<string, unknown>) {
  return {
    ...(a.location ? { location: a.location as 'all' } : {}),
    ...(str(a.sort) ? { sort: parseSort(str(a.sort)!) } : {}),
    limit: int(a.limit) ?? 100,
    ...opt(a, 'offset', int),
  };
}

export function parseSort(s: string): { field: SortField; direction: 'asc' | 'desc' }[] {
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [field, dir] = p.split(':') as [string, string | undefined];
      if (!['modified', 'created', 'title'].includes(field))
        throw new NoteError(
          'invalid_argument',
          `Can't sort by "${field}". Use modified, created or title.`,
        );
      if (dir !== undefined && dir !== 'asc' && dir !== 'desc')
        throw new NoteError('invalid_argument', `Sort direction is asc or desc, not "${dir}".`);
      return { field: field as SortField, direction: dir ?? (field === 'title' ? 'asc' : 'desc') };
    });
}

function need(a: Record<string, unknown>, key: string, allowEmpty = false): string {
  const v = a[key];
  if (typeof v !== 'string' || (!allowEmpty && v.trim() === ''))
    throw new NoteError('invalid_argument', `"${key}" is required.`);
  return v;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function strAllowEmpty(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function opt<K extends string, T>(
  a: Record<string, unknown>,
  key: K,
  read: (v: unknown) => T | undefined,
): { [P in K]?: T } {
  const v = read(a[key]);
  return (v === undefined ? {} : { [key]: v }) as { [P in K]?: T };
}
