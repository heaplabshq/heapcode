import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeWorkflow, parseWorkflow } from '../src/agent/learn.js';
import {
  renameTask,
  saveTask,
  saveWorkflow,
  slugFor,
  type SavedTask,
} from '../src/shared/tasks.js';

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

/**
 * Renaming a workflow.
 *
 * A workflow has two names — the one you read and the one you type — and rename
 * was written before the second existed, so it changed only the first. Renaming
 * "phone prices" to "weekly check" left it answering to `/phone-prices`: a
 * workflow you can no longer find by its own name, with nothing anywhere saying
 * why.
 */
describe('renaming a workflow', () => {
  const store: Record<string, unknown> = {};
  const stub = () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (k: string) => ({ [k]: store[k] })),
          set: vi.fn(async (v: Record<string, unknown>) => Object.assign(store, v)),
        },
      },
    });
  };
  const tasks = () => store['heapbrowse.tasks'] as SavedTask[];

  afterEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.unstubAllGlobals();
  });

  it('moves the shortcut with the name', async () => {
    stub();
    const [saved] = await saveWorkflow({
      name: 'phone prices',
      prompt: 'find phone prices',
      workflow: { steps: ['search'], learnedAt: 1 },
    });
    expect(saved!.slug).toBe('phone-prices');

    await renameTask(saved!.id, 'Weekly check');

    expect(tasks()[0]!.slug).toBe('weekly-check');
  });

  /** Two workflows answering to one shortcut is one of them unreachable. */
  it('will not take a shortcut another workflow is using', async () => {
    stub();
    await saveWorkflow({ name: 'weekly check', prompt: 'a', workflow: { steps: ['x'], learnedAt: 1 } });
    const after = await saveWorkflow({ name: 'phone prices', prompt: 'b', workflow: { steps: ['y'], learnedAt: 2 } });
    const phones = after.find((t) => t.slug === 'phone-prices')!;

    await renameTask(phones.id, 'Weekly check');

    const slugs = tasks().map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('weekly-check-2');
  });

  /** A plain saved task has no shortcut, and renaming must not invent one. */
  it('gives a plain task no shortcut', async () => {
    stub();
    const [plain] = await saveTask('just a prompt');

    await renameTask(plain!.id, 'Something else');

    expect(tasks()[0]!.slug).toBeUndefined();
    expect(tasks()[0]!.name).toBe('Something else');
  });
});
