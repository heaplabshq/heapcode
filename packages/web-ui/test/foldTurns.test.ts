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
  it('keeps everything the assistant writes, folding only the steps between', () => {
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
    expect(shape(foldTurns(items))).toEqual(['u1', 'steps(r1,t1)', 'a1', 'steps(t2)', 'a2', 'u2', 'a3']);
  });

  it('never hides a message the person has to act on behind later steps', () => {
    // The Kite case: a login link, then the agent carries on waiting for it.
    const items = [user('u1'), tool('t1'), said('a1', 'Click this link to log in'), thought('r1'), tool('t2')];
    expect(shape(foldTurns(items, true))).toEqual(['u1', 'steps(t1)', 'a1', 'steps(r1,t2)*']);
  });

  it('shows an answer said twice once — the later copy', () => {
    const items = [
      user('u1'),
      tool('t1'),
      said('a1', 'Nov 14'),
      thought('r1'),
      said('a2', 'Nov 14'),
    ];
    expect(shape(foldTurns(items))).toEqual(['u1', 'steps(t1,r1)', 'a2']);
  });

  it('marks only the last group live, and only during a run', () => {
    const items = [user('u1'), said('a1', 'let me look'), tool('t1')];
    expect(shape(foldTurns(items, true))).toEqual(['u1', 'a1', 'steps(t1)*']);
    expect(shape(foldTurns(items))).toEqual(['u1', 'a1', 'steps(t1)']);
  });

  it('keeps notices visible, outside the fold', () => {
    const items: Item[] = [user('u1'), tool('t1'), { kind: 'notice', id: 'n1', text: 'stopped' }];
    expect(shape(foldTurns(items))).toEqual(['u1', 'steps(t1)', 'n1']);
  });
});
