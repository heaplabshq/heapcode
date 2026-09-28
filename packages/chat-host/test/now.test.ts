import { describe, expect, it } from 'vitest';
import { nowLine, withNow } from '../src/now.js';
import { chatSystemPrompt } from '../src/prompt.js';

/**
 * Two contracts, and the second is the one that will be broken by accident.
 *
 * The clock has to be *right* — the person's local day, not UTC, which is the
 * bug this repo already shipped once in `core`'s environment block. And it has
 * to stay *out of the system prompt*, because that is the cached prefix: a
 * minute-resolution timestamp there re-prefills the whole conversation every
 * turn. The first is obvious in review; the second looks like a tidy-up.
 */
describe('nowLine', () => {
  it('renders the local date, time, zone and offset', async () => {
    const line = await withZone('Asia/Kolkata', () => nowLine(new Date('2026-09-22T09:02:00Z')));
    // The zone is matched loosely on purpose: ICU resolves `Asia/Kolkata` to
    // its `Asia/Calcutta` alias on some Node builds, and which name a machine
    // reports is not a claim this code makes. The instant is.
    expect(line).toMatch(/^2026-09-22 14:32 \(Asia\/\w+, UTC\+05:30\)$/);
  });

  it("reports the person's calendar day, not UTC's", async () => {
    // 02:30 UTC is still the previous evening in New York.
    const instant = new Date('2026-03-10T02:30:00Z');
    expect(await withZone('America/New_York', () => nowLine(instant))).toContain('2026-03-09');
    expect(instant.toISOString()).toContain('2026-03-10');
  });

  it('writes a western offset with the sign an offset is written with', async () => {
    // getTimezoneOffset is positive west of Greenwich, which is the opposite
    // of how the offset reads. Getting this backwards is silent and plausible.
    const line = await withZone('America/New_York', () => nowLine(new Date('2026-03-10T02:30:00Z')));
    expect(line).toContain('UTC-04:00');
  });

  it('pads every field to a fixed width', async () => {
    const line = await withZone('UTC', () => nowLine(new Date('2026-01-05T03:07:00Z')));
    expect(line).toContain('2026-01-05 03:07');
  });
});

describe('withNow', () => {
  it('marks the clock as heapcode speaking, not the person', () => {
    // `prompts.ts` declares this tag to the model as coming from heapcode
    // itself. Without it the clock reads as something the user typed, and a
    // model that answers it has been derailed by our own plumbing.
    const out = withNow('what does the lease say about notice?');
    expect(out.startsWith('<system-reminder>')).toBe(true);
    expect(out).toContain('</system-reminder>');
  });

  it('leaves the question itself untouched, at the end', () => {
    const task = 'is this invoice overdue?';
    expect(withNow(task).endsWith(task)).toBe(true);
  });

  it('carries the time it was called with', async () => {
    const out = await withZone('Asia/Kolkata', () => withNow('x', new Date('2026-09-22T09:02:00Z')));
    expect(out).toContain('2026-09-22 14:32');
  });
});

describe('the system prompt', () => {
  it('still contains no clock, in either identity', () => {
    // The contract this whole design rests on: the prefix must not change
    // turn to turn. If a date ever appears here, prefix caching is dead and
    // the symptom is a mysterious slowdown, not a failing test — so the test
    // is here instead.
    for (const prompt of [chatSystemPrompt(true), chatSystemPrompt(false)]) {
      expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(prompt).not.toMatch(/Current date and time/);
    }
  });
});

/**
 * Run something with the process in a named zone.
 *
 * `Date`'s local getters read `process.env.TZ`, so pinning it is the only way
 * to assert a local-vs-UTC difference that does not depend on where the test
 * machine is — on a CI box running UTC the two agree and every assertion here
 * would pass vacuously.
 */
async function withZone<T>(timeZone: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return await fn();
  } finally {
    // Assigning undefined to process.env stores the string "undefined".
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
