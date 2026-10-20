import { describe, expect, it } from 'vitest';
import { foldTurns, type Item } from '../src/transcript.js';

const user = (id: string, text = 'q'): Item => ({ kind: 'text', id, role: 'user', text });
const said = (id: string, text: string): Item => ({ kind: 'text', id, role: 'assistant', text });
const tool = (id: string, name = 'search_notes'): Item => ({
  kind: 'tool',
  id,
  name,
  args: {},
  done: true,
});
const thought = (id: string): Item => ({ kind: 'reasoning', id, text: 'hmm' });

const shape = (rows: ReturnType<typeof foldTurns>) =>
  rows.map((r) =>
    r.kind === 'steps'
      ? `steps(${r.items.map((i) => i.id).join(',')})${r.live ? '*' : ''}`
      : r.item.id,
  );

describe('foldTurns', () => {
  it('puts each turn as: question, its steps, its answer', () => {
    const items = [
      user('u1'),
      thought('r1'),
      tool('t1'),
      said('a1', 'looking'),
      tool('t2'),
      said('a2', 'answer'),
      user('u2'),
      said('a3', 'hi'),
    ];
    expect(shape(foldTurns(items))).toEqual(['u1', 'steps(r1,t1,a1,t2)', 'a2', 'u2', 'a3']);
  });

  it('shows an answer said twice once — the first copy is a step', () => {
    const items = [
      user('u1'),
      tool('t1'),
      said('a1', 'Nov 14'),
      thought('r1'),
      said('a2', 'Nov 14'),
    ];
    expect(shape(foldTurns(items))).toEqual(['u1', 'steps(t1,a1,r1)', 'a2']);
  });

  it('has no answer yet while the last thing is a tool, and marks the live turn', () => {
    const items = [user('u1'), said('a1', 'let me look'), tool('t1')];
    expect(shape(foldTurns(items, true))).toEqual(['u1', 'steps(a1,t1)*']);
  });

  it('keeps notices visible, outside the fold', () => {
    const items: Item[] = [user('u1'), tool('t1'), { kind: 'notice', id: 'n1', text: 'stopped' }];
    expect(shape(foldTurns(items))).toEqual(['u1', 'steps(t1)', 'n1']);
  });
});
