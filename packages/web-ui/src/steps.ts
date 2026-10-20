import type { Item, ReasoningItem } from './transcript.js';
import { diffStats, isDiffText } from './components/DiffView.js';

type ToolItem = Extract<Item, { kind: 'tool' }>;

/** What a tool call is, for the folded line, the step rows and their icons. */
export type StepKind =
  | 'web'
  | 'page'
  | 'search'
  | 'read'
  | 'change'
  | 'run'
  | 'make'
  | 'delegate'
  | 'remember'
  | 'connector'
  | 'other';

/**
 * Bookkeeping (`todo_write`, `finish`, `ask_user`) is `null`: the plan has its
 * own card, and the question was answered on screen.
 */
const KIND: Record<string, StepKind | null> = {
  web_search: 'web',
  fetch_url: 'page',
  download_file: 'page',
  search: 'search',
  semantic_search: 'search',
  search_history: 'search',
  repo_map: 'search',
  get_symbols: 'search',
  list_dir: 'search',
  list_skills: 'search',
  read_file: 'read',
  load_skill: 'read',
  write_file: 'change',
  edit_file: 'change',
  multi_edit: 'change',
  rename_file: 'change',
  delete_file: 'change',
  create_directory: 'change',
  run_command: 'run',
  run_tests: 'run',
  create_artifact: 'make',
  docx: 'make',
  pdf: 'make',
  delegate_task: 'delegate',
  remember: 'remember',
  todo_write: null,
  finish: null,
  ask_user: null,
};

export function stepKind(name: string): StepKind | null {
  if (name in KIND) return KIND[name]!;
  return connectorOf(name) ? 'connector' : 'other';
}

/** `mcp__kite__get_holdings` → `kite`. */
function connectorOf(name: string): string | undefined {
  return /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name)?.[1];
}

const NOW: Record<StepKind, string> = {
  web: 'Searching the web…',
  page: 'Reading a web page…',
  search: 'Searching…',
  read: 'Reading…',
  change: 'Editing files…',
  run: 'Running a command…',
  make: 'Making a document…',
  delegate: 'Working on a sub-task…',
  remember: 'Saving to memory…',
  connector: 'Working…',
  other: 'Working…',
};

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** `get_holdings` → `get holdings`. */
const words = (s: string): string => s.replace(/[_-]+/g, ' ').trim();

/**
 * The one line a group of steps shows in Heap Code and Heap Chat: what the
 * assistant did, in words — "Searched the web 9 times · made a document".
 * While it is still working, what it is doing now.
 *
 * Failures, time and lines changed are not in this string: the group draws
 * them itself, styled (see `summarizeWork`). Files are counted once however
 * often they were opened.
 */
export function describeWork(items: Item[], live: boolean): string {
  const tools = items.filter((i): i is ToolItem => i.kind === 'tool' && !i.parent);

  if (live) {
    const now = [...tools].reverse().find((t) => !t.done && stepKind(t.name) !== null);
    const last = items.at(-1);
    if (now) {
      const k = stepKind(now.name)!;
      if (k === 'connector') return `Using ${capital(connectorOf(now.name)!)}…`;
      return NOW[k];
    }
    if (!last || last.kind === 'reasoning') return 'Thinking…';
    return 'Working…';
  }

  const of = (k: StepKind): ToolItem[] => tools.filter((t) => stepKind(t.name) === k);
  const files = (list: ToolItem[]): number =>
    new Set(list.map((t) => String(t.args.path ?? t.args.file ?? t.id))).size;

  const parts: string[] = [];
  const web = of('web').length;
  if (web) parts.push(`searched the web ${times(web)}`);
  const search = of('search').length;
  if (search) parts.push(`searched ${times(search)}`);
  const pages = of('page').length;
  if (pages) parts.push(`opened ${count(pages, 'page')}`);
  const read = files(of('read'));
  if (read) parts.push(`read ${count(read, 'file')}`);
  const changed = files(of('change'));
  if (changed) parts.push(`changed ${count(changed, 'file')}`);
  const ran = of('run').length;
  if (ran) parts.push(`ran ${count(ran, 'command')}`);
  const made = of('make').length;
  if (made) parts.push(made === 1 ? 'made a document' : `made ${made} documents`);
  const delegated = of('delegate').length;
  if (delegated) parts.push(count(delegated, 'sub-task'));
  if (of('remember').length) parts.push('saved to memory');
  const servers = [...new Set(of('connector').map((t) => capital(connectorOf(t.name)!)))];
  if (servers.length) parts.push(`used ${servers.join(', ')}`);
  const other = of('other').length;
  if (other) parts.push(count(other, 'other step'));

  if (parts.length === 0) return 'Thought it through';
  return capital(parts.join(' · '));
}

/** A step row's words: "Searched the web" + "RBI policy date". */
export function stepLabel(tool: ToolItem): { verb: string; detail: string } {
  const s = (k: string): string => (typeof tool.args[k] === 'string' ? (tool.args[k] as string) : '');
  switch (tool.name) {
    case 'web_search':
      return { verb: 'Searched the web', detail: s('query') };
    case 'fetch_url':
      return { verb: 'Read page', detail: shortUrl(s('url')) };
    case 'download_file':
      return { verb: 'Downloaded', detail: shortUrl(s('url')) };
    case 'search':
      return { verb: 'Searched', detail: s('pattern') || s('query') };
    case 'semantic_search':
    case 'search_history':
      return { verb: 'Searched', detail: s('query') };
    case 'repo_map':
      return { verb: 'Mapped the project', detail: s('query') };
    case 'get_symbols':
      return { verb: 'Listed symbols', detail: s('path') };
    case 'list_dir':
      return { verb: 'Listed', detail: s('path') || 'the project folder' };
    case 'list_skills':
      return { verb: 'Listed skills', detail: '' };
    case 'read_file':
      return { verb: 'Read', detail: s('path') };
    case 'load_skill':
      return { verb: 'Loaded skill', detail: s('name') };
    case 'write_file':
      return { verb: 'Wrote', detail: s('path') };
    case 'edit_file':
    case 'multi_edit':
      return { verb: 'Edited', detail: s('path') };
    case 'rename_file':
      return { verb: 'Renamed', detail: `${s('path')} → ${s('newPath')}` };
    case 'delete_file':
      return { verb: 'Deleted', detail: s('path') };
    case 'create_directory':
      return { verb: 'Created folder', detail: s('path') };
    case 'run_command':
      return { verb: 'Ran', detail: s('command') };
    case 'run_tests':
      return { verb: 'Ran tests', detail: s('command') };
    case 'create_artifact':
      return { verb: 'Made', detail: s('title') };
    case 'docx':
    case 'pdf':
      return { verb: `Made a ${tool.name === 'pdf' ? 'PDF' : 'Word document'}`, detail: s('path') || s('title') };
    case 'delegate_task':
      return { verb: 'Sub-task', detail: s('task').slice(0, 120) };
    case 'remember':
      return { verb: 'Saved to memory', detail: s('note') || s('text') };
    default: {
      const server = connectorOf(tool.name);
      const first = Object.values(tool.args).find((v) => typeof v === 'string') as string | undefined;
      if (server) return { verb: capital(server), detail: words(tool.name.slice(`mcp__${server}__`.length)) };
      return { verb: capital(words(tool.name)), detail: first?.slice(0, 120) ?? '' };
    }
  }
}

/** `https://www.rbi.org.in/Scripts/x.aspx?id=1` → `rbi.org.in/Scripts/x.aspx`. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

/** One thing drawn inside an open group. */
export type StepUnit =
  | { kind: 'tool'; tool: ToolItem }
  | { kind: 'bundle'; id: string; step: StepKind; label: string; tools: ToolItem[] }
  | { kind: 'thinking'; id: string; items: ReasoningItem[]; ms?: number; streaming: boolean }
  | { kind: 'item'; item: Item };

/**
 * A group's steps as rows: same-kind steps in a row become one row ("Searched
 * the web 10 times", opening to the queries), back-to-back thinking becomes
 * one "Thought for 6s", and empty thinking and `todo_write` calls are left out.
 */
export function groupSteps(items: Item[]): StepUnit[] {
  const units: StepUnit[] = [];
  const keyOf = (t: ToolItem): string | undefined => {
    const k = stepKind(t.name);
    if (!k || t.parent || k === 'other' || k === 'delegate') return undefined;
    return k === 'connector' ? `connector:${connectorOf(t.name)}` : k;
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === 'tool' && stepKind(it.name) === null && it.name !== 'ask_user') continue;
    if (it.kind === 'reasoning') {
      if (!it.text.trim() && !it.streaming) continue;
      const prev = units.at(-1);
      const ms = thinkingMs(it, items[i + 1]);
      if (prev?.kind === 'thinking') {
        prev.items.push(it);
        prev.streaming = Boolean(it.streaming);
        if (ms !== undefined) prev.ms = (prev.ms ?? 0) + ms;
      } else {
        units.push({ kind: 'thinking', id: it.id, items: [it], streaming: Boolean(it.streaming), ...(ms !== undefined ? { ms } : {}) });
      }
      continue;
    }
    if (it.kind !== 'tool') {
      units.push({ kind: 'item', item: it });
      continue;
    }
    const key = keyOf(it);
    const prev = units.at(-1);
    if (key && prev?.kind === 'bundle' && keyOf(prev.tools[0]!) === key) {
      prev.tools.push(it);
      prev.label = bundleLabel(prev.tools);
    } else if (key && prev?.kind === 'tool' && keyOf(prev.tool) === key) {
      const tools = [prev.tool, it];
      units[units.length - 1] = { kind: 'bundle', id: prev.tool.id, step: stepKind(it.name)!, label: bundleLabel(tools), tools };
    } else {
      units.push({ kind: 'tool', tool: it });
    }
  }
  return units;
}

/** "Searched the web 10 times", "Read 4 files", "Kite · 3 steps". */
function bundleLabel(tools: ToolItem[]): string {
  const n = tools.length;
  const files = new Set(tools.map((t) => String(t.args.path ?? t.id))).size;
  switch (stepKind(tools[0]!.name)) {
    case 'web':
      return `Searched the web ${times(n)}`;
    case 'page':
      return `Read ${count(n, 'page')}`;
    case 'search':
      return `Searched ${times(n)}`;
    case 'read':
      return `Read ${count(files, 'file')}`;
    case 'change':
      return `Changed ${count(files, 'file')}`;
    case 'run':
      return `Ran ${count(n, 'command')}`;
    case 'make':
      return `Made ${count(n, 'document')}`;
    case 'remember':
      return `Saved to memory ${times(n)}`;
    case 'connector':
      return `${capital(connectorOf(tools[0]!.name)!)} · ${count(n, 'step')}`;
    default:
      return count(n, 'step');
  }
}

/** How long a thought took: to its own end, or until whatever came next began. */
function thinkingMs(it: ReasoningItem, next: Item | undefined): number | undefined {
  if (it.startedAt === undefined) return undefined;
  const nextStart = next && 'startedAt' in next ? next.startedAt : undefined;
  const end = it.endedAt ?? nextStart;
  return end === undefined ? undefined : Math.max(0, end - it.startedAt);
}

/** What a group's line shows beside its words: failures, time taken, lines changed. */
export function summarizeWork(items: Item[]): { failed: number; ms?: number; added: number; removed: number } {
  const tools = items.filter((i): i is ToolItem => i.kind === 'tool');
  const failed = tools.filter((t) => t.isError && !t.parent).length;
  let added = 0;
  let removed = 0;
  for (const t of tools) {
    if (stepKind(t.name) !== 'change' || !t.result || !isDiffText(t.result)) continue;
    const d = diffStats(t.result);
    added += d.added;
    removed += d.removed;
  }
  const starts = items.map((i) => ('startedAt' in i ? i.startedAt : undefined)).filter((n): n is number => n !== undefined);
  const ends = items.map((i) => ('endedAt' in i ? i.endedAt : undefined)).filter((n): n is number => n !== undefined);
  const ms = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : undefined;
  return { failed, added, removed, ...(ms !== undefined && ms > 0 ? { ms } : {}) };
}

/** "6s", "1m 12s". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * The sites an answer drew on: the pages it opened, or — when it only
 * searched — the first few sites its searches returned. At most `limit`, one
 * per site.
 */
export function webSources(items: Item[], limit = 5): { host: string; url: string }[] {
  const tools = items.filter((i): i is ToolItem => i.kind === 'tool' && !i.isError);
  const opened = tools.filter((t) => t.name === 'fetch_url' && typeof t.args.url === 'string').map((t) => t.args.url as string);
  const found = opened.length
    ? opened
    : tools.filter((t) => t.name === 'web_search').flatMap((t) => (t.result ?? '').match(/https?:\/\/[^\s)\]"'<>]+/g) ?? []);
  const out: { host: string; url: string }[] = [];
  for (const url of found) {
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (out.some((s) => s.host === host)) continue;
    out.push({ host, url });
    if (out.length >= limit) break;
  }
  return out;
}
