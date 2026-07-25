import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_CLIENT,
  applyVerdicts,
  capAtSentence,
  formatInlineCommentBody,
  formatPreviewMarkdown,
  formatReviewBody,
  isAnchorable,
  isRangeAnchorable,
  packBatches,
  parseDiffHunkRanges,
  parseFindings,
  parseVerdicts,
  shouldSkipFile,
  sortFindings,
  splitDiffByFile,
  type Finding,
} from '../src/review/prReviewFormat.js';

const SAMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function foo() {',
  ' line10',
  '+line11 (new)',
  ' line12',
  ' line13',
  'diff --git a/src/b.ts b/src/b.ts',
  'index 333..444 100644',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

describe('parseDiffHunkRanges', () => {
  it('maps each changed file to its new-content line ranges from the hunk headers', () => {
    const ranges = parseDiffHunkRanges(SAMPLE_DIFF);
    expect(ranges.get('src/a.ts')).toEqual([[10, 13]]);
    expect(ranges.get('src/b.ts')).toEqual([[1, 1]]);
  });

  it('handles multiple hunks in the same file as separate ranges', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -5,2 +5,2 @@', ' a', ' b', '@@ -50,1 +50,3 @@', ' c', '+d', '+e'].join('\n');
    expect(parseDiffHunkRanges(diff).get('x.ts')).toEqual([
      [5, 6],
      [50, 52],
    ]);
  });

  it('returns an empty map for a diff with no recognizable hunks', () => {
    expect(parseDiffHunkRanges('not a diff at all').size).toBe(0);
  });
});

describe('isAnchorable', () => {
  const ranges = parseDiffHunkRanges(SAMPLE_DIFF);

  it('is true for a line inside a hunk range', () => {
    expect(isAnchorable(ranges, 'src/a.ts', 11)).toBe(true);
    expect(isAnchorable(ranges, 'src/a.ts', 10)).toBe(true);
    expect(isAnchorable(ranges, 'src/a.ts', 13)).toBe(true);
  });

  it('is false for a line outside every hunk range in that file', () => {
    expect(isAnchorable(ranges, 'src/a.ts', 9)).toBe(false);
    expect(isAnchorable(ranges, 'src/a.ts', 14)).toBe(false);
  });

  it('is false for a file not touched by the diff at all', () => {
    expect(isAnchorable(ranges, 'src/unrelated.ts', 1)).toBe(false);
  });

  it('is false when no line is given', () => {
    expect(isAnchorable(ranges, 'src/a.ts', undefined)).toBe(false);
  });
});

describe('isRangeAnchorable', () => {
  const ranges = parseDiffHunkRanges(SAMPLE_DIFF);
  const base: Finding = {
    file: 'src/a.ts',
    severity: 'medium',
    category: 'correctness',
    summary: 's',
    body: 'b',
    verified: true,
  };

  it('accepts a range fully inside one hunk', () => {
    expect(isRangeAnchorable(ranges, { ...base, startLine: 10, line: 12 })).toBe(true);
  });

  it('rejects a range that leaks outside the hunk', () => {
    expect(isRangeAnchorable(ranges, { ...base, startLine: 9, line: 12 })).toBe(false);
    expect(isRangeAnchorable(ranges, { ...base, startLine: 12, line: 15 })).toBe(false);
  });

  it('rejects when there is no range at all', () => {
    expect(isRangeAnchorable(ranges, { ...base, line: 11 })).toBe(false);
  });
});

describe('splitDiffByFile', () => {
  it('splits a multi-file diff into one entry per file, preserving content', () => {
    const parts = splitDiffByFile(SAMPLE_DIFF);
    expect(parts.map((p) => p.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parts[0]!.content).toContain('+line11 (new)');
    expect(parts[0]!.content).not.toContain('+new');
    expect(parts[1]!.content).toContain('+new');
  });

  it('returns empty for non-diff text', () => {
    expect(splitDiffByFile('hello world')).toEqual([]);
  });
});

describe('shouldSkipFile', () => {
  it('skips lockfiles and generated artifacts', () => {
    expect(shouldSkipFile('pnpm-lock.yaml')).toBe(true);
    expect(shouldSkipFile('packages/cli/package-lock.json')).toBe(true);
    expect(shouldSkipFile('dist/bundle.js')).toBe(true);
    expect(shouldSkipFile('web/app.min.js')).toBe(true);
    expect(shouldSkipFile('assets/tree-sitter.wasm')).toBe(true);
  });

  it('keeps real source files', () => {
    expect(shouldSkipFile('src/index.ts')).toBe(false);
    expect(shouldSkipFile('packages/cli/src/cli.tsx')).toBe(false);
    expect(shouldSkipFile('package.json')).toBe(false);
  });
});

describe('packBatches', () => {
  const file = (name: string, size: number) => ({ file: name, content: 'x'.repeat(size) });

  it('packs files greedily under the budget', () => {
    const { batches, truncatedFiles } = packBatches([file('a', 40), file('b', 40), file('c', 40)], 100);
    expect(batches.map((b) => b.map((f) => f.file))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
    expect(truncatedFiles).toEqual([]);
  });

  it('truncates a single file bigger than the whole budget, with an explicit marker', () => {
    const { batches, truncatedFiles } = packBatches([file('huge', 500)], 100);
    expect(truncatedFiles).toEqual(['huge']);
    expect(batches[0]![0]!.content).toContain('[diff for this file truncated');
  });
});

describe('parseFindings', () => {
  it('normalizes a well-formed findings array', () => {
    const parsed = parseFindings([
      { file: 'a.ts', line: 3, severity: 'high', category: 'correctness', summary: 's', body: 'b', verified: true },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ file: 'a.ts', line: 3, severity: 'high', verified: true });
  });

  it('recovers a JSON-stringified array (observed live from weaker models)', () => {
    const parsed = parseFindings(JSON.stringify([{ file: 'a.ts', severity: 'low', category: 'style', summary: 's', body: 'b', verified: false }]));
    expect(parsed).toHaveLength(1);
  });

  it('coerces string-typed line numbers and drops invalid ranges', () => {
    const parsed = parseFindings([
      { file: 'a.ts', line: '7', start_line: '9', severity: 'medium', category: 'x', summary: 's', body: 'b', verified: false },
    ]);
    expect(parsed[0]!.line).toBe(7);
    expect(parsed[0]!.startLine).toBeUndefined(); // 9 >= 7 — not a valid range
  });

  it('drops entries missing file/summary/valid severity instead of crashing', () => {
    expect(parseFindings([{ severity: 'catastrophic', summary: 's' }, null, 'junk', { file: 'a.ts', severity: 'low', summary: 'ok' }])).toHaveLength(1);
  });
});

describe('parseVerdicts + applyVerdicts', () => {
  const findings: Finding[] = [
    { file: 'a.ts', line: 1, severity: 'critical', category: 'security', summary: 'A', body: 'a', verified: true },
    { file: 'b.ts', line: 2, severity: 'low', category: 'style', summary: 'B', body: 'b', verified: false },
    { file: 'c.ts', line: 3, severity: 'high', category: 'correctness', summary: 'C', body: 'c', verified: true },
  ];

  it('drops rejected findings (keeping the reason) and labels the rest', () => {
    const { verdicts } = parseVerdicts({
      verdicts: [
        { index: 0, verdict: 'rejected', reason: 'contradicted by the code' },
        { index: 1, verdict: 'plausible', reason: 'could not confirm' },
        { index: 2, verdict: 'confirmed', reason: 'reproduced from source' },
      ],
    });
    const { kept, rejected } = applyVerdicts(findings, verdicts);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.finding.summary).toBe('A');
    expect(rejected[0]!.reason).toBe('contradicted by the code');
    expect(kept.map((f) => f.verdict)).toEqual(['plausible', 'confirmed']);
  });

  it('applies severity corrections from the verifier', () => {
    const { verdicts } = parseVerdicts({ verdicts: [{ index: 0, verdict: 'confirmed', reason: 'r', severity: 'medium' }] });
    const { kept } = applyVerdicts([findings[0]!], verdicts);
    expect(kept[0]!.severity).toBe('medium');
  });

  it('keeps findings the verifier never mentioned, as plausible — an incomplete verdict list must not silently discard findings', () => {
    const { kept, rejected } = applyVerdicts(findings, [{ index: 0, verdict: 'confirmed', reason: 'r' }]);
    expect(rejected).toHaveLength(0);
    expect(kept[1]!.verdict).toBe('plausible');
    expect(kept[2]!.verdict).toBe('plausible');
  });
});

describe('sortFindings', () => {
  it('orders by severity, and within a severity puts confirmed before plausible', () => {
    const sorted = sortFindings([
      { file: 'a', severity: 'low', category: 'x', summary: 'low-1', body: '', verified: false },
      { file: 'b', severity: 'high', category: 'x', summary: 'high-plausible', body: '', verified: false, verdict: 'plausible' },
      { file: 'c', severity: 'high', category: 'x', summary: 'high-confirmed', body: '', verified: true, verdict: 'confirmed' },
    ]);
    expect(sorted.map((f) => f.summary)).toEqual(['high-confirmed', 'high-plausible', 'low-1']);
  });
});

const CRITICAL_ANCHORED: Finding = {
  file: 'src/a.ts',
  line: 11,
  severity: 'critical',
  category: 'correctness',
  summary: 'Off-by-one in the new line',
  body: 'Detailed explanation and a fix.',
  failureScenario: 'Call max([]) — reads past the end and returns undefined.',
  verified: true,
  verdict: 'confirmed',
};

const LOW_UNANCHORED: Finding = {
  file: 'src/a.ts',
  line: 200, // outside every hunk range
  severity: 'low',
  category: 'style',
  summary: 'Pre-existing style nit noticed while reading for context',
  body: 'Not part of this diff, just noting it.',
  verified: false,
};

describe('formatReviewBody', () => {
  const ranges = parseDiffHunkRanges(SAMPLE_DIFF);

  it('discloses the review is AI-generated and includes the severity breakdown', () => {
    const body = formatReviewBody('Overall looks solid.', [CRITICAL_ANCHORED, LOW_UNANCHORED], ranges);
    expect(body).toContain('AI-generated review');
    expect(body).toContain('1 critical');
    expect(body).toContain('1 low');
  });

  it('folds an unanchored finding into the body in full, but only references the anchored one by count', () => {
    const body = formatReviewBody('Summary.', [CRITICAL_ANCHORED, LOW_UNANCHORED], ranges);
    expect(body).toContain(LOW_UNANCHORED.summary);
    expect(body).toContain(LOW_UNANCHORED.body);
    expect(body).toContain('1 finding(s) posted as inline comments below');
    // The anchored finding's own body text isn't duplicated into the general body — it goes out as its own inline comment instead.
    expect(body).not.toContain(CRITICAL_ANCHORED.body);
  });

  // The retry path after GitHub 422s the inline comments passes an empty range
  // map so nothing counts as anchored. Every finding must then survive into the
  // body in full — the whole point of the retry is not losing the review.
  it('renders every finding in full when there are no anchors (the inline-rejected retry)', () => {
    const body = formatReviewBody('Summary.', [CRITICAL_ANCHORED, LOW_UNANCHORED], new Map());
    expect(body).toContain(CRITICAL_ANCHORED.summary);
    expect(body).toContain(CRITICAL_ANCHORED.body);
    expect(body).toContain(LOW_UNANCHORED.summary);
    expect(body).toContain(LOW_UNANCHORED.body);
    expect(body).not.toContain('posted as inline comments below');
  });

  it('reports skipped and unreviewed files honestly instead of implying they were clean', () => {
    const body = formatReviewBody('S.', [], ranges, {
      skippedFiles: ['pnpm-lock.yaml'],
      unreviewedFiles: ['src/z.ts'],
    });
    expect(body).toContain('pnpm-lock.yaml');
    expect(body).toContain('treat these as unreviewed, not clean');
  });

  it('discloses in the posted body when the verification pass never ran — unvetted findings must not read as vetted', () => {
    const body = formatReviewBody('S.', [CRITICAL_ANCHORED], ranges, { verificationSkipped: true });
    expect(body).toContain('verification pass did not complete');
    expect(body).toContain('may include false positives');
  });

  it('labels a by-design single-pass (fast) review and points at the deep command, without the failure warning', () => {
    const body = formatReviewBody('S.', [CRITICAL_ANCHORED], ranges, { singlePass: true });
    expect(body).toContain('Single-pass review');
    expect(body).toContain(DEFAULT_REVIEW_CLIENT.deepHint);
    expect(body).not.toContain('did not complete');
  });

  // The same review runs in the CLI and the extension, so the two host-specific
  // strings — who posted it, and how to ask for the deep pass here — have to
  // follow the caller rather than being baked into the formatter.
  it('names the calling host in the attribution and the deep-review hint', () => {
    const body = formatReviewBody('S.', [CRITICAL_ANCHORED], ranges, { singlePass: true }, {
      attribution: 'the Heap Code CLI',
      deepHint: 'run "/pr-review deep"',
    });
    expect(body).toContain('posted via the Heap Code CLI');
    expect(body).toContain('run "/pr-review deep"');
    expect(body).not.toContain('VS Code');
  });
});

describe('formatPreviewMarkdown', () => {
  const ranges = parseDiffHunkRanges(SAMPLE_DIFF);
  const pr = { number: 1, title: 'Test PR', url: 'https://x' };

  it('marks each finding with whether it will post as an inline comment or a general note', () => {
    const preview = formatPreviewMarkdown(pr, 'Summary.', [CRITICAL_ANCHORED, LOW_UNANCHORED], ranges);
    expect(preview).toContain('will post as an inline comment');
    expect(preview).toContain('will post in the general summary');
    expect(preview).toContain(CRITICAL_ANCHORED.body);
    expect(preview).toContain(LOW_UNANCHORED.body);
  });

  it('shows what verification filtered out, with reasons, marked as not-posted', () => {
    const preview = formatPreviewMarkdown(pr, 'S.', [CRITICAL_ANCHORED], ranges, [
      { finding: LOW_UNANCHORED, reason: 'contradicted by the code' },
    ]);
    expect(preview).toContain('Filtered out by verification');
    expect(preview).toContain('contradicted by the code');
    expect(preview).toContain('will NOT be posted');
  });
});

describe('capAtSentence', () => {
  it('returns short text unchanged', () => {
    expect(capAtSentence('One. Two.', 100)).toBe('One. Two.');
  });

  it('cuts at the last full sentence instead of mid-word', () => {
    const text = 'First sentence is here. Second sentence is much longer and will be cut somewhere in the middle of it.';
    const capped = capAtSentence(text, 50);
    expect(capped).toBe('First sentence is here.');
  });

  it('falls back to a hard cut with ellipsis when no sentence boundary exists in range', () => {
    const capped = capAtSentence('x'.repeat(300), 100);
    expect(capped.length).toBe(101);
    expect(capped.endsWith('…')).toBe(true);
  });
});

describe('formatInlineCommentBody', () => {
  it('flags an unadjudicated, unverified finding explicitly rather than presenting it as confirmed', () => {
    expect(formatInlineCommentBody(LOW_UNANCHORED)).toContain('unverified — could not confirm');
    expect(formatInlineCommentBody(CRITICAL_ANCHORED)).not.toContain('unverified');
  });

  it('labels verifier-confirmed findings and includes the failure scenario', () => {
    const body = formatInlineCommentBody(CRITICAL_ANCHORED);
    expect(body).toContain('verified in code');
    expect(body).toContain('**Failure scenario:**');
  });

  it('renders a GitHub one-click suggestion block when a suggestion is present', () => {
    const body = formatInlineCommentBody({ ...CRITICAL_ANCHORED, suggestion: 'for (let i = 1; i < nums.length; i++) {' });
    expect(body).toContain('```suggestion\nfor (let i = 1; i < nums.length; i++) {\n```');
  });

  it('omits the suggestion block when the suggestion itself contains a fence (would break rendering)', () => {
    const body = formatInlineCommentBody({ ...CRITICAL_ANCHORED, suggestion: 'a\n```\nb' });
    expect(body).not.toContain('```suggestion');
  });
});
