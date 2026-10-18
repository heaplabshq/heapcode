/**
 * Heapnotes' page ↔ host protocol, over the same JSON-RPC socket shell as the
 * other products (`@heapcode/web-host`). Types only, and nothing that pulls in
 * Node — the page imports this file.
 */

export const NOTES_PROTOCOL_VERSION = 1;

export const NOTES_METHODS = {
  hello: 'notes/hello',
  /** Notes for the list: a section/tag, or a search when `query` is set. */
  list: 'notes/list',
  tags: 'notes/tags',
  /** Every note's id and title, for Quick Open and [[link]] completion. */
  titles: 'notes/titles',
  /** Notes close in meaning to a search, beyond its keyword hits. Empty without an embeddings model. */
  related: 'notes/related',
  /** Notes related to one note — meaning, shared links, shared tags — minus ones already linked. */
  relatedTo: 'notes/relatedTo',
  /** ⌘J: rewrite a selection. Streams `inlineText`; answers with the final text. */
  inline: 'notes/inline',
  inlineCancel: 'notes/inlineCancel',
  open: 'notes/open',
  /** Save the editor's text. Answers `{ conflict }` rather than failing, so the page can offer a choice. */
  save: 'notes/save',
  create: 'notes/create',
  /** A [[link]] was followed: its note, made first if there is none (as Bear does). */
  followLink: 'notes/followLink',
  pin: 'notes/pin',
  archive: 'notes/archive',
  trash: 'notes/trash',
  restore: 'notes/restore',
  deleteForever: 'notes/deleteForever',
  emptyTrash: 'notes/emptyTrash',
  duplicate: 'notes/duplicate',
  renameTag: 'notes/renameTag',
  attach: 'notes/attach',
  import: 'notes/import',
  /** The vault picker, and settings. */
  workspaces: 'notes/workspaces',
  browseFolders: 'notes/browseFolders',
  setVault: 'notes/setVault',
  saveSettings: 'notes/saveSettings',
  /** Host → page: something in the vault changed on disk. */
  changed: 'notes/changed',
  /** Host → page: show this note — an agent called open_note. */
  focus: 'notes/focus',
  /** Host → page: more of a ⌘J result, as it streams. */
  inlineText: 'notes/inlineText',
} as const;

export type NotesLocation = 'notes' | 'archive' | 'trash';

/** The smart sections in the sidebar. */
export type NotesSection = 'all' | 'untagged' | 'todo' | 'today' | 'pinned' | 'archive' | 'trash';

export interface NoteListItem {
  id: string;
  title: string;
  subtitle: string;
  path: string;
  location: NotesLocation;
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
  hash: string;
  snippet?: string;
}

export interface NotesState {
  vault: string;
  /** Notes in the list (not archived or trashed), for the sidebar's count. */
  count: number;
  fontSize: number;
  /** Tags hidden from the assistant (default `private`). */
  aiHiddenTags: string[];
  /** Whether Ask is available: false when the host runs without a model connection. */
  ask: boolean;
  /** Where the page should send images: `${base}/attachment/<path>`. */
  attachmentBase: string;
}

export interface NotesListParams {
  section?: NotesSection;
  tag?: string;
  query?: string;
  sort?: 'modified' | 'created' | 'title';
}

export interface NoteOpenResult {
  note: NoteListItem;
  /** The Markdown body, without front matter. */
  content: string;
  hash: string;
  outline: { address: string; level: number; heading: string; offset: number }[];
  backlinks: { id: string; title: string; subtitle: string }[];
}

export type InlineAction = 'improve' | 'shorten' | 'fix' | 'summarize' | 'list' | 'tasks' | 'continue' | 'custom';

export interface InlineRequest {
  /** The page's id for this request, echoed on each `inlineText`. */
  requestId: string;
  action: InlineAction;
  /** For `custom`: what to do, in the person's words. */
  instruction?: string;
  selection: string;
  before: string;
  after: string;
}

export interface RelatedNote {
  id: string;
  title: string;
  subtitle: string;
  /** Why it's suggested, in words: "Similar in meaning", "Also links to Plan", "Also tagged #work". */
  reason: string;
  kind: 'meaning' | 'links' | 'tags';
}

export type NoteSaveResult =
  | { ok: true; note: NoteListItem; hash: string }
  | { ok: false; conflict: true; content: string; hash: string };

export interface NotesChanged {
  /** Ids whose files changed on disk — the open one reloads if it's among them. */
  ids: string[];
}

export type NotesImportKind = 'markdown' | 'obsidian' | 'bear';

export type { UiBrowseFoldersResult, UiWorkspacesResult } from '@heapcode/web-host/protocol';
