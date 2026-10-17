import type { Item } from '@heapcode/web-ui/transcript';

const SEARCHES = new Set([
  'search_notes',
  'search_by_meaning',
  'list_notes',
  'search_in_note',
  'list_tags',
  'list_backlinks',
]);
const READS = new Set(['read_note', 'outline_note', 'get_note']);
const CHANGES = new Set([
  'create_note',
  'edit_note',
  'append_to_note',
  'overwrite_note',
  'add_tag',
  'remove_tag',
]);

/**
 * The one line an Ask answer's folded steps show: what the assistant did,
 * in words — "Searched 3 times · read Launch plan, Groceries · 1 change".
 * While it is still working, what it is doing now.
 */
export function describeSteps(items: Item[], live: boolean): string {
  const tools = items.filter((i): i is Extract<Item, { kind: 'tool' }> => i.kind === 'tool');
  if (live) {
    const now = [...tools].reverse().find((t) => !t.done) ?? tools.at(-1);
    if (!now) return 'Thinking…';
    if (SEARCHES.has(now.name)) return 'Searching your notes…';
    if (READS.has(now.name)) return 'Reading a note…';
    if (CHANGES.has(now.name)) return 'Waiting for you to apply a change…';
    return 'Working…';
  }
  const parts: string[] = [];
  const searches = tools.filter((t) => SEARCHES.has(t.name)).length;
  if (searches) parts.push(searches === 1 ? 'Searched once' : `Searched ${searches} times`);
  const titles = [
    ...new Set(
      tools
        .filter((t) => READS.has(t.name))
        .map(titleOf)
        .filter((t): t is string => Boolean(t)),
    ),
  ];
  if (titles.length)
    parts.push(
      `read ${titles.length > 3 ? `${titles.slice(0, 3).join(', ')} and ${titles.length - 3} more` : titles.join(', ')}`,
    );
  const changes = tools.filter((t) => CHANGES.has(t.name));
  if (changes.length) {
    const applied = changes.filter((t) => t.done && !t.isError).length;
    parts.push(`${applied} of ${changes.length} change${changes.length === 1 ? '' : 's'} applied`);
  }
  const other = tools.filter(
    (t) => !SEARCHES.has(t.name) && !READS.has(t.name) && !CHANGES.has(t.name),
  ).length;
  if (other) parts.push(`${other} other step${other === 1 ? '' : 's'}`);
  if (parts.length === 0) return 'Thought it through';
  const line = parts.join(' · ');
  return line[0]!.toUpperCase() + line.slice(1);
}

/** A read tool's note title, out of its JSON result. */
function titleOf(t: { result?: string }): string | undefined {
  try {
    const r = JSON.parse(t.result ?? '') as { title?: unknown };
    return typeof r.title === 'string' && r.title ? r.title : undefined;
  } catch {
    return undefined;
  }
}
