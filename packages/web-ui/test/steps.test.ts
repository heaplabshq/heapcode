import { describe, expect, it } from 'vitest';
import type { Item } from '../src/transcript.js';
import { describeWork } from '../src/steps.js';

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

  it('says when steps failed', () => {
    expect(describeWork([tool('search'), tool('search', {}, { isError: true })], false)).toBe('Searched twice · 1 failed');
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
