import type { Item } from './transcript.js';

type ToolItem = Extract<Item, { kind: 'tool' }>;

/**
 * What a tool call counts as on the folded line. Bookkeeping (`todo_write`,
 * `finish`, `ask_user`) counts as nothing: the plan has its own card, and the
 * question was answered on screen.
 */
const KIND: Record<string, Kind | null> = {
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

type Kind = 'web' | 'page' | 'search' | 'read' | 'change' | 'run' | 'make' | 'delegate' | 'remember' | 'other';

const NOW: Record<Kind, string> = {
  web: 'Searching the web…',
  page: 'Reading a web page…',
  search: 'Searching…',
  read: 'Reading…',
  change: 'Editing files…',
  run: 'Running a command…',
  make: 'Making a document…',
  delegate: 'Working on a sub-task…',
  remember: 'Saving to memory…',
  other: 'Working…',
};

const kindOf = (t: ToolItem): Kind | null => (t.name in KIND ? KIND[t.name]! : 'other');

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The one line a turn's folded steps show in Heap Code and Heap Chat: what
 * the assistant did, in words — "Searched the web 9 times · made a document".
 * While it is still working, what it is doing now.
 *
 * The same idea as Heapnotes' line (notes-ui/steps.ts), over the tools these
 * two products have. Files are counted once however often they were opened.
 */
export function describeWork(items: Item[], live: boolean): string {
  const tools = items.filter((i): i is ToolItem => i.kind === 'tool' && !i.parent);

  if (live) {
    const now = [...tools].reverse().find((t) => !t.done && kindOf(t) !== null);
    const last = items.at(-1);
    if (now) return NOW[kindOf(now)!];
    if (!last || last.kind === 'reasoning') return 'Thinking…';
    return 'Working…';
  }

  const of = (k: Kind): ToolItem[] => tools.filter((t) => kindOf(t) === k);
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
  const other = of('other').length;
  if (other) parts.push(count(other, 'other step'));
  const failed = tools.filter((t) => t.isError).length;
  if (failed) parts.push(`${failed} failed`);

  if (parts.length === 0) return 'Thought it through';
  const line = parts.join(' · ');
  return line[0]!.toUpperCase() + line.slice(1);
}
