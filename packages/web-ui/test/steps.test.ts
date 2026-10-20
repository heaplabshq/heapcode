import { describe, expect, it } from 'vitest';
import type { Item } from '../src/transcript.js';
import { describeWork, groupSteps, stepLabel, summarizeWork, webSources } from '../src/steps.js';

const tool = (name: string, args: Record<string, unknown> = {}, extra: Partial<Extract<Item, { kind: 'tool' }>> = {}): Item => ({
  kind: 'tool',
  id: Math.random().toString(36),
  name,
  args,
  done: true,
  ...extra,
});

describe('the folded steps line', () => {
  it('says what a research turn did, in words', () => {
    const items = [
      tool('todo_write'),
      ...Array.from({ length: 9 }, () => tool('web_search')),
      tool('create_artifact'),
      tool('todo_write'),
    ];
    expect(describeWork(items, false)).toBe('Searched the web 9 times · made a document');
  });

  it('counts each file once however often it was opened', () => {
    const items = [
      tool('read_file', { path: 'a.ts' }),
      tool('read_file', { path: 'a.ts' }),
      tool('read_file', { path: 'b.ts' }),
      tool('edit_file', { path: 'a.ts' }),
      tool('edit_file', { path: 'a.ts' }),
      tool('run_command'),
    ];
    expect(describeWork(items, false)).toBe('Read 2 files · changed 1 file · ran 1 command');
  });

  it('names the connectors it used', () => {
    expect(describeWork([tool('mcp__kite__login'), tool('mcp__kite__get_holdings')], false)).toBe('Used Kite');
  });

  it('does not count what a sub-agent did as the turn\'s own steps', () => {
    expect(describeWork([tool('delegate_task'), tool('read_file', { path: 'x' }, { parent: 'd' })], false)).toBe('1 sub-task');
  });

  it('says what it is doing while live, and that it is thinking between steps', () => {
    expect(describeWork([tool('web_search', {}, { done: false })], true)).toBe('Searching the web…');
    expect(describeWork([], true)).toBe('Thinking…');
  });

  it('has a line even for a turn with no tools', () => {
    expect(describeWork([{ kind: 'reasoning', id: 'r', text: 'hm' } as Item], false)).toBe('Thought it through');
  });
});

describe('grouping a stretch of steps', () => {
  const shape = (items: Item[]) =>
    groupSteps(items).map((u) => (u.kind === 'bundle' ? `${u.label}` : u.kind === 'tool' ? u.tool.name : u.kind));

  it('turns runs of the same kind into one row, and leaves out todo_write', () => {
    const items = [tool('todo_write'), tool('web_search'), tool('web_search'), tool('web_search'), tool('fetch_url'), tool('read_file', { path: 'a' })];
    expect(shape(items)).toEqual(['Searched the web 3 times', 'fetch_url', 'read_file']);
  });

  it('merges back-to-back thinking, adds up its time, and drops empty thinking', () => {
    const r = (id: string, text: string, startedAt: number, endedAt: number): Item =>
      ({ kind: 'reasoning', id, text, startedAt, endedAt }) as Item;
    const units = groupSteps([r('1', 'hm', 0, 2_000), r('2', 'ok', 2_000, 6_000), r('3', '  ', 6_000, 7_000), tool('search')]);
    expect(units.map((u) => u.kind)).toEqual(['thinking', 'tool']);
    expect(units[0]).toMatchObject({ kind: 'thinking', ms: 6_000 });
  });

  it('keeps a connector\'s steps together under its name', () => {
    expect(shape([tool('mcp__kite__login'), tool('mcp__kite__get_holdings')])).toEqual(['Kite · 2 steps']);
  });

  it('describes each step in words', () => {
    const label = (name: string, args: Record<string, unknown>) => stepLabel(tool(name, args) as never);
    expect(label('fetch_url', { url: 'https://www.rbi.org.in/press?id=1' })).toEqual({ verb: 'Read page', detail: 'rbi.org.in/press' });
    expect(label('edit_file', { path: 'src/a.ts' })).toEqual({ verb: 'Edited', detail: 'src/a.ts' });
    expect(label('mcp__kite__get_holdings', {})).toEqual({ verb: 'Kite', detail: 'get holdings' });
  });

  it('adds up failures, time and lines changed', () => {
    const diff = '@@ -1 +1,2 @@\n-a\n+b\n+c\n';
    expect(
      summarizeWork([
        tool('edit_file', { path: 'x' }, { result: diff, startedAt: 10, endedAt: 20 }),
        tool('run_command', {}, { isError: true, startedAt: 20, endedAt: 5_010 }),
      ]),
    ).toEqual({ failed: 1, added: 2, removed: 1, ms: 5_000 });
  });

  it('finds the sites an answer used: pages opened first, else what searches found', () => {
    expect(webSources([tool('fetch_url', { url: 'https://www.a.com/x' }), tool('fetch_url', { url: 'https://a.com/y' })])).toEqual([
      { host: 'a.com', url: 'https://www.a.com/x' },
    ]);
    expect(webSources([tool('web_search', {}, { result: 'see https://b.org/1 and https://c.net/2' })]).map((s) => s.host)).toEqual([
      'b.org',
      'c.net',
    ]);
  });
});
