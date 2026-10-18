import { join } from 'node:path';
import type { ToolCall, ToolDefinition, ToolResult } from '@heapcode/core';
import { projectStateDir } from '@heapcode/core/node';
import type { ChatChangePreview, ChatPersona, Evidence } from '@heapcode/chat-host';
import { COMMANDS, checkArgs, type Command } from './commands.js';
import { NoteError } from './errors.js';
import { readFrontMatter } from './frontMatter.js';
import { formatTag, normalizeTagName } from './parse.js';
import type { EditArgs, NoteRef, NoteSummary, Vault } from './vault.js';

/**
 * "Ask your notes": Heapnotes' assistant, as a persona on Heap Chat's session
 * (HEAPNOTES_PHASE2_PLAN §2A, §3).
 *
 * Its tools are rows of the same command table the MCP serves, so the
 * assistant inside the app and an agent outside it can do exactly the same
 * things — plus `search_by_meaning` over Heap Code's index. Reads run at once;
 * every change is shown to the person as a diff and runs only on Apply.
 *
 * It sees the vault through `vault()`: the app passes a view with the hidden
 * tags (default `#private`) scoped out, so a hidden note is unreadable by
 * every tool here, meaning search included.
 */
const READS = [
  'search_notes',
  'list_notes',
  'get_note',
  'read_note',
  'outline_note',
  'search_in_note',
  'list_backlinks',
  'list_tags',
  'open_note',
] as const;

const CHANGES = [
  'create_note',
  'edit_note',
  'append_to_note',
  'overwrite_note',
  'add_tag',
  'remove_tag',
] as const;

const SEARCH_BY_MEANING: ToolDefinition = {
  name: 'search_by_meaning',
  description:
    'Search the notes by meaning rather than exact words — "what did we decide about the launch date". Returns the passages closest in meaning, each with its note. Use it when the words in the note may differ from the question; use search_notes for exact words, tags and dates.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you are looking for, in plain words.' },
    },
    required: ['query'],
  },
  permission: 'read',
};

const VIEW_IMAGE: ToolDefinition = {
  name: 'view_image',
  description:
    "Look at an image in a note — a photo, screenshot or diagram it embeds. Give the note and the image's file name (as list_attachments or the note's text shows it). Use it when the question is about what an image shows.",
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The note id.' },
      filename: { type: 'string', description: 'The image file name, e.g. "photo.png".' },
    },
    required: ['id', 'filename'],
  },
  permission: 'read',
};

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
/** Past this an image costs more than it tells; providers cap near here too. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface NotesPersonaOptions {
  /** The vault as the assistant may see it. Called per use: the app can switch vaults. */
  vault(): Vault;
  /** Tags hidden from the assistant, for its prompt. */
  hiddenTags(): string[];
  /** Vault paths of the notes those tags hide — kept out of the meaning index entirely. */
  hiddenPaths?(): Promise<string[]>;
  /** The note open in the editor, when the person is asking about it. */
  openNote?(): string | undefined;
  /** Make changes without asking each time — the person switched Apply off. */
  autoApply?(): boolean;
}

/**
 * Changes one question may make. A model asked to "improve" a note will, left
 * alone, apply a change, read the result, find something else to improve and
 * go again — for as long as the turn allows. Past this many it's told to stop
 * and say what it did.
 */
export const MAX_CHANGES_PER_QUESTION = 3;

/**
 * One of a note's images, for the model to see. Through the assistant's own
 * vault, so a hidden note's images stay hidden like its text.
 */
async function viewImage(vault: Vault, call: ToolCall, vision: boolean): Promise<ToolResult> {
  const id = String(call.args.id ?? '').trim();
  const filename = String(call.args.filename ?? '').trim();
  if (!id || !filename)
    throw new NoteError('invalid_argument', 'Give the note id and the image file name.');
  if (!vision)
    throw new NoteError(
      'invalid_argument',
      "This model can't see images. Answer from the note's text, and say you couldn't look at the image.",
    );
  const { attachment, data } = await vault.readAttachment({ id }, filename);
  const type = IMAGE_TYPES[attachment.filename.split('.').pop()?.toLowerCase() ?? ''];
  if (!type)
    throw new NoteError(
      'invalid_argument',
      `${attachment.filename} isn't an image this can show (png, jpg, gif, webp).`,
    );
  if (data.byteLength > IMAGE_MAX_BYTES)
    throw new NoteError(
      'invalid_argument',
      `${attachment.filename} is too large to look at (over 5 MB).`,
    );
  return {
    id: call.id,
    name: call.name,
    content: `${attachment.filename} is attached below.`,
    images: [`data:${type};base64,${data.toString('base64')}`],
  };
}

export function notesPersona(opts: NotesPersonaOptions): ChatPersona {
  const commands = new Map<string, Command>();
  for (const name of [...READS, ...CHANGES]) {
    const cmd = COMMANDS.find((c) => c.name === name);
    if (cmd) commands.set(name, cmd);
  }
  const tools: ToolDefinition[] = [
    SEARCH_BY_MEANING,
    VIEW_IMAGE,
    ...[...commands.values()].map((c) => ({
      name: c.name,
      description: CHANGES.includes(c.name as (typeof CHANGES)[number])
        ? `${c.description} The person sees the change and applies it; if they don't, it isn't made.`
        : c.description,
      parameters: c.input as unknown as Record<string, unknown>,
      permission: c.readOnly ? ('read' as const) : ('write' as const),
    })),
  ];

  const isChange = (name: string): boolean => CHANGES.includes(name as (typeof CHANGES)[number]);
  let changesMade = 0;

  return {
    name: 'Heapnotes',
    tools,
    systemPrompt: () => notesPrompt(opts.hiddenTags()),
    conversationsFile: (root) => join(projectStateDir(root), 'notes-ask.json'),
    // Hidden notes are never read for the index — so never sent to an
    // embeddings model, which may well be a cloud one.
    ...(opts.hiddenPaths ? { indexExclude: () => opts.hiddenPaths!() } : {}),
    async turnContext() {
      // Called once per question: the count of changes starts again.
      changesMade = 0;
      const id = opts.openNote?.();
      if (!id) return undefined;
      // Through the assistant's own view: a hidden note isn't named, even here.
      const note = await opts
        .vault()
        .get({ id })
        .catch(() => undefined);
      if (!note || note.location === 'trash') return undefined;
      return `The person has the note "${note.title}" (id ${note.id}) open. "This note", "this", "here" and "it" mean that note unless they say otherwise — read it with read_note before answering about it.`;
    },
    permission: (call) =>
      // Over the limit the call is refused in `execute`; no card for that.
      !isChange(call.name) || opts.autoApply?.() || changesMade >= MAX_CHANGES_PER_QUESTION
        ? 'grant'
        : 'ask',

    async execute(call, ctx, signal): Promise<ToolResult> {
      try {
        if (call.name === SEARCH_BY_MEANING.name) {
          const query = String(call.args.query ?? '').trim();
          if (!query) throw new NoteError('invalid_argument', 'Give a query.');
          const raw = await ctx.semanticSearch(query, signal);
          if (raw.isError) return { ...raw, id: call.id, name: call.name };
          const content = await visibleHits(opts.vault(), raw.content);
          return {
            id: call.id,
            name: call.name,
            content:
              content ||
              'Nothing close in meaning. Try search_notes with exact words, or say it is not in the notes.',
          };
        }
        if (call.name === VIEW_IMAGE.name) return await viewImage(opts.vault(), call, ctx.vision);
        const cmd = commands.get(call.name);
        if (!cmd) throw new NoteError('invalid_argument', `No tool ${call.name}.`);
        if (isChange(call.name) && changesMade >= MAX_CHANGES_PER_QUESTION)
          throw new NoteError(
            'invalid_argument',
            `That's ${changesMade} changes for this question — the limit. Don't make another: finish now and tell the person, in a line or two, what you changed.`,
          );
        const result = await cmd.run(opts.vault(), checkArgs(cmd, call.args));
        if (isChange(call.name)) changesMade += 1;
        return {
          id: call.id,
          name: call.name,
          content: JSON.stringify(result ?? { ok: true }, null, 2),
        };
      } catch (err) {
        const e =
          err instanceof NoteError
            ? err
            : new NoteError('io', err instanceof Error ? err.message : String(err));
        return { id: call.id, name: call.name, content: JSON.stringify(e.toJSON()), isError: true };
      }
    },

    async preview(call): Promise<ChatChangePreview | undefined> {
      const vault = opts.vault();
      const cmd = commands.get(call.name);
      if (!cmd) return undefined;
      const a = checkArgs(cmd, call.args);
      const ref = refOf(a);
      const guard = {
        ...(typeof a.base === 'string' ? { base: a.base } : {}),
        ...(typeof a.section === 'string' ? { section: a.section } : {}),
        ...(typeof a.index === 'number' ? { index: a.index } : {}),
      };
      switch (call.name) {
        case 'create_note': {
          const title = typeof a.title === 'string' ? a.title.trim() : '';
          const tags = Array.isArray(a.tags)
            ? a.tags.map((t) => formatTag(normalizeTagName(String(t))))
            : [];
          const body = [
            title ? `# ${title}` : '',
            tags.join(' '),
            typeof a.text === 'string' ? a.text : '',
          ]
            .filter(Boolean)
            .join('\n');
          return { title: `New note${title ? ` “${title}”` : ''}`, before: '', after: body };
        }
        case 'edit_note': {
          const p = await vault.preview(ref!, {
            kind: 'edit',
            args: a as unknown as EditArgs,
            guard,
          });
          return { title: `Edit “${p.title}”`, before: p.before, after: p.after };
        }
        case 'append_to_note': {
          const p = await vault.preview(ref!, {
            kind: 'append',
            text: String(a.text ?? ''),
            ...(a.position === 'start' ? { position: 'start' as const } : {}),
            guard,
          });
          return { title: `Add to “${p.title}”`, before: p.before, after: p.after };
        }
        case 'overwrite_note': {
          const p = await vault.preview(ref!, {
            kind: 'overwrite',
            text: String(a.text ?? ''),
            guard,
          });
          return { title: `Rewrite “${p.title}”`, before: p.before, after: p.after };
        }
        case 'add_tag':
        case 'remove_tag': {
          const note = await vault.get(ref!);
          const tag = formatTag(normalizeTagName(String(a.tag ?? '').replace(/^#|#$/g, '')));
          return {
            title: `${call.name === 'add_tag' ? 'Tag' : 'Untag'} “${note.title}” ${tag}`,
            before: '',
            after: '',
          };
        }
      }
      return undefined;
    },

    evidence(name, args, content): Evidence[] {
      try {
        if (name === 'read_note') {
          const r = JSON.parse(content) as { title?: string; content?: string };
          return r.title && r.content ? [{ source: r.title, text: r.content }] : [];
        }
        if (name === 'search_notes' || name === 'list_notes') {
          const r = JSON.parse(content) as {
            notes?: { title: string; subtitle?: string; snippet?: string }[];
          };
          return (r.notes ?? []).map((n) => ({
            source: n.title,
            text: `${n.title}\n${n.snippet ?? n.subtitle ?? ''}`,
          }));
        }
        if (name === SEARCH_BY_MEANING.name) {
          return content
            .split(/\n(?=--- )/)
            .map((block) => ({ source: /^--- (.+?) \(/.exec(block)?.[1] ?? 'notes', text: block }))
            .filter((e) => e.text.trim());
        }
      } catch {
        // Not JSON — an error, which is no evidence.
      }
      return [];
    },
  };
}

/** One meaning-search passage, tied to the note it came from. */
export interface NoteHit {
  note: NoteSummary;
  lines: string;
  passage: string;
  score: number;
}

/**
 * The index's hits, kept only where the note is one this vault view may see:
 * a Markdown note, not in the trash, not hidden by tag. In the index's order
 * (best first). Shared by the assistant and the note list's "related" group.
 */
export async function noteHits(vault: Vault, content: string): Promise<NoteHit[]> {
  const out: NoteHit[] = [];
  for (const block of content.split(/\n(?=--- )/)) {
    const head = /^--- (.+?):(\d+)-(\d+) \(score (-?[\d.]+)\) ---\n?/.exec(block);
    if (!head) continue;
    const path = head[1]!;
    if (!/\.md$/i.test(path)) continue;
    try {
      const note = await vault.get({ path });
      if (note.location === 'trash') continue;
      // The index embeds whole files, so a note's first passage carries its front matter.
      const raw = block.slice(head[0].length);
      const passage = raw.slice(readFrontMatter(raw).end).trim();
      out.push({ note, lines: `${head[2]}-${head[3]}`, passage, score: Number(head[4]) });
    } catch {
      // Not visible to this view (hidden tag), or gone since it was indexed.
    }
  }
  return out;
}

/** Hits headed by the note's title and id, so the model can cite and open it. */
export async function visibleHits(vault: Vault, content: string): Promise<string> {
  return (await noteHits(vault, content))
    .map((h) => `--- ${h.note.title} (id ${h.note.id}, lines ${h.lines}) ---\n${h.passage}`)
    .join('\n\n');
}

function refOf(a: Record<string, unknown>): NoteRef | undefined {
  if (typeof a.id === 'string' && a.id) return { id: a.id };
  if (typeof a.path === 'string' && a.path) return { path: a.path };
  if (typeof a.title === 'string' && a.title) return { title: a.title };
  return undefined;
}

function notesPrompt(hidden: string[]): string {
  const hiddenLine = hidden.length
    ? `\n\nNotes tagged ${hidden.map((t) => `#${t}`).join(', ')} are hidden from you by the person's choice. You cannot find or read them; never guess what they say, and don't mention that they might exist.`
    : '';
  return `You are the assistant inside Heapnotes, a notes app. You work in the person's own notes: plain Markdown files, written by them, in their words.

## Finding things

Search in this turn before you answer anything about the notes — what you found for an earlier question doesn't count, and the notes may have changed. Never say you searched, or that something isn't in the notes, unless you called a search tool for it in this turn.

- \`search_notes\` finds exact words and uses Bear's search syntax: "exact phrase", -exclude, #tag (subtags included), @today, @last7days, @todo, @done, @title and more. Start here when the question names something specific.
- \`search_by_meaning\` finds passages close in meaning when the wording may differ. Use it when \`search_notes\` comes back empty before you say something isn't there.
- \`read_note\` (by id) before you quote or rely on a note. A search snippet is a pointer, not the note. For a long note, \`outline_note\` then read one section.
- \`view_image\` to see an image a note embeds, when the question is about what it shows.

## Answering

Ground every specific claim in a note you read, and cite it as a link the person can click: [[Note title]]. Quote the line when the exact words matter. If notes disagree, say so and show both. When the notes don't hold the answer, say that plainly — then, if it's general knowledge, answer it and say that's where it came from. Never fill a gap by guessing what a note probably says.

## Changing notes

You can propose changes: \`edit_note\` for a precise change (exact \`find\` text that appears once), \`append_to_note\`, \`create_note\`, \`overwrite_note\` for a full rewrite the person asked for, and tags. **The person sees each change as a diff and applies it or not** — so propose only what they asked for, one coherent change at a time, and pass \`base\` (the hash from your last \`read_note\`) so you never overwrite something they just typed. If a change isn't applied, don't retry it; ask what they'd like instead.

**One pass, then stop.** When the change they asked for is made, finish: say in a line what you changed. Don't read the note again to look for more to improve, and don't follow a change with another round polishing the same text — they'll ask if they want more.

Keep their voice: edit the words they asked about and leave the rest alone. Use their markup — #tags, [[links]], - [ ] tasks.

## Ending a turn

Your last message is the answer the person sees; everything before it — searches, reads, remarks on the way — is folded out of sight. So make that last message stand alone: the whole answer, with its [[Note title]] links, short and plain. Say it once: either write it as prose and let \`finish\` carry a one-line note, or put all of it in \`finish\` — not both.

## Tone

Short and direct. Lead with the answer. The notes are theirs; you're helping them find and shape what they wrote.${hiddenLine}`;
}
