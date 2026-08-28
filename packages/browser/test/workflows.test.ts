import { describe, expect, it } from 'vitest';
import { describeWorkflow, parseWorkflow } from '../src/agent/learn.js';
import { slugFor } from '../src/shared/tasks.js';

/**
 * Reading back what the model says a run did.
 *
 * The model is asked for JSON and told to reply with nothing else, and it will
 * fence it in a code block and add a sentence anyway. Losing a saved workflow
 * to a stray backtick would be a silly way to lose one.
 */
describe('reading a learned workflow', () => {
  const good = '{"name":"phone prices","varies":"the product to search for","steps":["search for the product","sort by price","read the top few"]}';

  it('reads the shape it asked for', () => {
    const w = parseWorkflow(good)!;
    expect(w.name).toBe('phone prices');
    expect(w.varies).toBe('the product to search for');
    expect(w.steps).toHaveLength(3);
  });

  it('digs it out of a code fence and an apology', () => {
    expect(parseWorkflow('Sure! Here you go:\n```json\n' + good + '\n```')?.name).toBe('phone prices');
  });

  /** "null" arrives as the string as often as the value. */
  it('treats a null varies as nothing varying', () => {
    expect(parseWorkflow('{"name":"x","varies":null,"steps":["a"]}')?.varies).toBeUndefined();
    expect(parseWorkflow('{"name":"x","varies":"null","steps":["a"]}')?.varies).toBeUndefined();
  });

  it('refuses a workflow with no steps rather than saving an empty one', () => {
    expect(parseWorkflow('{"name":"x","steps":[]}')).toBeUndefined();
    expect(parseWorkflow('not json at all')).toBeUndefined();
    expect(parseWorkflow('{"steps":"nope"}')).toBeUndefined();
  });

  it('caps the steps, because a workflow nobody reads is not guidance', () => {
    const many = JSON.stringify({ name: 'x', steps: Array.from({ length: 30 }, (_, i) => `step ${i}`) });
    expect(parseWorkflow(many)!.steps.length).toBeLessThanOrEqual(8);
  });
});

/**
 * How it reaches the next run. Worded as history, not orders: a plan given as
 * orders gets followed past the point where the page stopped matching it.
 */
describe('handing a workflow to the next run', () => {
  it('says it may be stale and what to do about that', () => {
    const text = describeWorkflow({ steps: ['search for the product'], learnedAt: 0 });
    expect(text).toMatch(/starting point, not as orders/);
    expect(text).toMatch(/page may have changed/);
  });

  it('names what varied, when something did', () => {
    const text = describeWorkflow({ steps: ['a'], varies: 'the month', learnedAt: 0 });
    expect(text).toContain('the month');
  });
});

describe('the name a workflow is typed as', () => {
  it('is something a person can type after a slash', () => {
    expect(slugFor('Phone prices on Amazon')).toBe('phone-prices-on-amazon');
    expect(slugFor('  Weekly  Report!!  ')).toBe('weekly-report');
  });

  it('never comes back empty, however unusable the name', () => {
    expect(slugFor('!!!')).toBe('workflow');
    expect(slugFor('')).toBe('workflow');
  });
});
