import { describe, expect, it } from 'vitest';
import {
  buildProvenance,
  formatEvidence,
  isGroundedAnswer,
  parseVerification,
  snippetFor,
  splitHits,
  type Evidence,
} from '../src/grounding.js';

const POLICY: Evidence = {
  source: 'policy.md',
  text: 'The offsite budget is 47,200 for the year. Remote work is allowed 3 days per week.',
};
const INVOICE: Evidence = { source: 'invoice.txt', text: 'Invoice 4821\nTotal due: 318.40 GBP' };

describe('snippetFor', () => {
  it('matches across a thousands separator in either direction', () => {
    expect(snippetFor('the budget is 47,200 total', '47200')).toContain('47,200');
    expect(snippetFor('the budget is 47200 total', '47200')).toContain('47200');
  });

  it('matches across a decimal point — the case heapchat’s original missed', () => {
    // "£318.40" in an answer yields the digits 31840, which cannot reach
    // "318.40" in the source unless `.` is a permitted separator. Without
    // this, the one number an answer is about is the one with no provenance.
    expect(snippetFor(INVOICE.text, '31840')).toContain('318.40');
  });

  it('returns nothing when the digits are simply not there', () => {
    expect(snippetFor(POLICY.text, '99999')).toBeUndefined();
  });

  it('marks where it truncated, so a snippet is never mistaken for the whole line', () => {
    const long = `${'x'.repeat(200)} 47200 ${'y'.repeat(200)}`;
    const snippet = snippetFor(long, '47200')!;
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('does not throw on digits that would form an invalid pattern', () => {
    expect(() => snippetFor('anything', '')).not.toThrow();
  });
});

describe('buildProvenance', () => {
  it('traces a number back to the file it appears in', () => {
    const [entry] = buildProvenance('The budget is 47,200.', [POLICY]);
    expect(entry?.value).toBe('47,200');
    expect(entry?.source).toBe('policy.md');
    expect(entry?.snippet).toContain('47,200');
  });

  it('ignores numbers too small to be distinctive', () => {
    // "3 days" is in the evidence, but tracing every 1- and 2-digit number
    // would fill the panel with noise and make the real figures harder to see.
    expect(buildProvenance('You may work remotely 3 days a week.', [POLICY])).toEqual([]);
  });

  it('leaves a fabricated number untraced — the absence is the signal', () => {
    expect(buildProvenance('The budget is 91,300.', [POLICY])).toEqual([]);
  });

  it('reports each distinct number once, however often the answer repeats it', () => {
    const found = buildProvenance('47,200 — yes, 47200, i.e. 47,200.', [POLICY]);
    expect(found).toHaveLength(1);
  });

  it('attributes to the first source that actually contains the number', () => {
    const [entry] = buildProvenance('Total 318.40', [POLICY, INVOICE]);
    expect(entry?.source).toBe('invoice.txt');
  });
});

describe('splitHits', () => {
  it('gives each semantic-search hit its own source', () => {
    const block =
      '--- policy.md:1-4 (score 0.81) ---\nThe offsite budget is 47,200.\n\n' +
      '--- team.md:2-6 (score 0.55) ---\nPriya is the product designer.';
    const hits = splitHits(block);
    expect(hits.map((h) => h.source)).toEqual(['policy.md', 'team.md']);
    expect(hits[1]?.text).toContain('Priya');
  });

  it('gives each grep hit its own source', () => {
    const block = 'invoice.txt:2:\n> 2\tTotal due: 318.40 GBP\n--\nteam.md:1:\n> 1\tPriya — design';
    expect(splitHits(block).map((h) => h.source)).toEqual(['invoice.txt', 'team.md']);
  });

  it('keeps a number attributed to the one file it came from', () => {
    // The defect this prevents: a block spanning four files carried as one
    // row made every figure in it appear to come from all four, in a feature
    // whose entire job is saying precisely where a figure came from.
    const block =
      '--- policy.md:1-2 (score 0.9) ---\nBudget 47,200.\n\n--- other.md:1-2 (score 0.4) ---\nNothing here.';
    const [entry] = buildProvenance('Budget is 47,200.', splitHits(block));
    expect(entry?.source).toBe('policy.md');
  });

  it('returns nothing for output with no file headers at all', () => {
    expect(splitHits('No matches.')).toEqual([]);
  });
});

describe('parseVerification', () => {
  it('reads a verdict out of a reply wrapped in prose', () => {
    const parsed = parseVerification('Sure — {"verdict":"supported","issues":[],"used":["policy.md"]} done');
    expect(parsed.verdict).toBe('supported');
    expect(parsed.used).toEqual(['policy.md']);
  });

  it('treats an unknown verdict as no opinion rather than as a failure', () => {
    expect(parseVerification('{"verdict":"probably"}').verdict).toBeUndefined();
  });

  it('survives a reply that is not JSON at all', () => {
    expect(parseVerification('I could not check that.')).toEqual({});
  });

  it('caps issues, so one bad reply cannot fill the panel', () => {
    const many = JSON.stringify({ verdict: 'partial', issues: ['a', 'b', 'c', 'd', 'e'] });
    expect(parseVerification(many).issues).toHaveLength(3);
  });
});

describe('isGroundedAnswer', () => {
  it('is false with no evidence, so general knowledge carries no badge', () => {
    // The badge means something only because it is absent sometimes.
    expect(isGroundedAnswer([], [])).toBe(false);
  });

  it('is true once something was actually read', () => {
    expect(isGroundedAnswer([POLICY], [])).toBe(true);
  });
});

describe('formatEvidence', () => {
  it('tags each excerpt with its source, which is what the checker matches on', () => {
    expect(formatEvidence([POLICY])).toContain('[policy.md]');
  });

  it('bounds each excerpt so one large file cannot crowd out the rest', () => {
    const huge: Evidence = { source: 'big.txt', text: 'x'.repeat(5_000) };
    expect(formatEvidence([huge], 100).length).toBeLessThan(200);
  });
});
