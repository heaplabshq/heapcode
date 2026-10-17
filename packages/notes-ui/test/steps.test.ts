import { describe, expect, it } from 'vitest';
import type { Item } from '@heapcode/web-ui/transcript';
import { describeSteps } from '../src/steps.js';

const tool = (
  name: string,
  result?: string,
  extra: Partial<Extract<Item, { kind: 'tool' }>> = {},
): Item => ({
  kind: 'tool',
  id: Math.random().toString(36),
  name,
  args: {},
  done: true,
  ...(result ? { result } : {}),
  ...extra,
});

describe('the steps line', () => {
  it('says what it did, naming the notes it read', () => {
    const items = [
      tool('search_notes'),
      tool('search_by_meaning'),
      tool('read_note', JSON.stringify({ title: 'Launch plan', content: '…' })),
      tool('read_note', JSON.stringify({ title: 'Launch plan', content: '…' })),
    ];
    expect(describeSteps(items, false)).toBe('Searched 2 times · read Launch plan');
  });

  it('counts changes applied against proposed', () => {
    expect(
      describeSteps(
        [tool('edit_note'), tool('append_to_note', undefined, { isError: true })],
        false,
      ),
    ).toBe('1 of 2 changes applied');
  });

  it('says what it is doing while live', () => {
    expect(describeSteps([tool('read_note', undefined, { done: false })], true)).toBe(
      'Reading a note…',
    );
    expect(describeSteps([], true)).toBe('Thinking…');
  });

  it('falls back when there were no tools', () => {
    expect(describeSteps([{ kind: 'reasoning', id: 'r', text: 'x' }], false)).toBe(
      'Thought it through',
    );
  });
});
