import type { ToolDefinition } from '../agent/tools.js';

/**
 * Pure PR-review logic (diff splitting/parsing, finding schemas, verdict
 * application, formatting), separate from prReview.ts's orchestration so it
 * is directly unit-testable without a provider, a `gh` binary, or a host.
 *
 * Nothing here knows which host it renders for — the two host-specific
 * strings (who posted the review, and how to ask for the deep variant) come
 * in as a ReviewClient.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_ICON: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };

/**
 * Shared by both review phases so severity means the same thing everywhere —
 * severity inflation was a real observed failure (documented known
 * limitations reported as CRITICAL), and a written rubric the verifier can
 * hold findings against is the counterweight.
 */
export const SEVERITY_DEFINITIONS =
  'Severity rubric — hold every finding against this, most reviews have NO critical findings:\n' +
  '- critical: exploitable security vulnerability, data loss/corruption, or a crash in normal (not edge-case) use.\n' +
  '- high: a real bug users will plausibly hit in ordinary use, or a security weakness requiring unusual conditions.\n' +
  '- medium: incorrect behavior in edge cases, reliability risks, meaningful performance problems.\n' +
  '- low: maintainability, clarity, missing tests, minor polish. Style belongs here and only when it materially hurts the code.';

/** Set by the verification pass. 'confirmed' = the verifier located the exact code and could demonstrate the failure; 'plausible' = could neither confirm nor clearly refute. Rejected findings are dropped, not labeled. */
export type Verdict = 'confirmed' | 'plausible';

export interface Finding {
  file: string;
  /** 1-based line in the file's current (new) content this finding anchors to (the last line, when a range). */
  line?: number;
  /** Optional range start (must be < line) for multi-line anchors/suggestions. */
  startLine?: number;
  severity: Severity;
  category: string;
  summary: string;
  body: string;
  /** Concrete input/state → wrong outcome. Required in spirit for bug-class findings — the single best false-positive filter. */
  failureScenario?: string;
  /** Exact replacement for the anchored line(s) — rendered as a GitHub ```suggestion block (one-click applicable). */
  suggestion?: string;
  /** Phase-1 self-report: the model confirmed this against the code itself (static only — nothing here is runtime-tested). */
  verified: boolean;
  verdict?: Verdict;
}

export interface RejectedFinding {
  finding: Finding;
  reason: string;
}

export const REPORT_FINDINGS_TOOL: ToolDefinition = {
  name: 'report_findings',
  description:
    'Report your review findings for this batch of files. Call this exactly once when you are done ' +
    'investigating — do not give your final answer as plain text. One entry per specific issue, most severe ' +
    'first. "summary" is a brief overall assessment, never a substitute for itemizing issues in "findings". ' +
    'An empty findings array is acceptable ONLY after you have genuinely read every hunk in the batch and ' +
    'found nothing worth a human reviewer\'s attention — never to save effort.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-4 sentence overall assessment of the reviewed files — not a list of issues, those go in "findings".' },
      findings: {
        type: 'array',
        description: 'One entry per specific issue found, most severe first.',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Repo-relative path.' },
            line: {
              type: 'number',
              description: "1-based line in the file's CURRENT content the finding anchors to (the last line, when a range). Omit only for file-level findings.",
            },
            start_line: {
              type: 'number',
              description: 'Optional range start (must be strictly less than "line") when the finding spans multiple lines.',
            },
            severity: { type: 'string', enum: [...SEVERITIES], description: 'Per the severity rubric you were given. Do not inflate.' },
            category: { type: 'string', description: 'One of: correctness, security, performance, test-coverage, style, docs.' },
            summary: { type: 'string', description: 'One-sentence statement of the issue.' },
            body: { type: 'string', description: 'Full explanation and a concrete suggested fix.' },
            failure_scenario: {
              type: 'string',
              description:
                'REQUIRED for correctness/security/performance findings: the concrete input or state that triggers the ' +
                'problem and the wrong outcome that results. If you cannot construct one, it is not a finding.',
            },
            suggestion: {
              type: 'string',
              description:
                'Optional: exact replacement code for the anchored line(s) — only when you are confident it is correct ' +
                'and complete as-is (it becomes a one-click-applicable GitHub suggestion). Must replace exactly the ' +
                'line range the finding anchors to.',
            },
            verified: {
              type: 'boolean',
              description:
                'true only if you confirmed the claim against the actual code with read_file/search in THIS session. ' +
                'This is static verification only — you cannot run code, so never treat inferred runtime behavior as verified.',
            },
          },
          required: ['file', 'severity', 'category', 'summary', 'body', 'verified'],
        },
      },
    },
    required: ['summary', 'findings'],
  },
  permission: 'read',
};

export const REPORT_VERDICTS_TOOL: ToolDefinition = {
  name: 'report_verdicts',
  description:
    'Report your adjudication of the candidate findings. Call this exactly once, with one verdict per finding ' +
    'index — do not give your final answer as plain text.',
  parameters: {
    type: 'object',
    properties: {
      overall_summary: { type: 'string', description: '2-4 sentence overall assessment of the PR, written for the PR author.' },
      verdicts: {
        type: 'array',
        description: 'Exactly one entry per candidate finding index.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number', description: 'The finding index being adjudicated.' },
            verdict: { type: 'string', enum: ['confirmed', 'plausible', 'rejected'] },
            reason: { type: 'string', description: 'One sentence: why this verdict.' },
            severity: { type: 'string', enum: [...SEVERITIES], description: 'Optional corrected severity, when the original was inflated/deflated per the rubric.' },
            line: { type: 'number', description: 'Optional corrected line number, when the original was wrong.' },
          },
          required: ['index', 'verdict', 'reason'],
        },
      },
    },
    required: ['verdicts'],
  },
  permission: 'read',
};

/** Normalizes a raw report_findings args object into clean Finding[]s — tolerant of string-typed numbers and a JSON-stringified array (both observed from weaker models live). */
export function parseFindings(raw: unknown): Finding[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const findings: Finding[] = [];
  for (const item of value as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    const file = typeof item.file === 'string' ? item.file : undefined;
    const summary = typeof item.summary === 'string' ? item.summary : undefined;
    const severity = SEVERITIES.includes(item.severity as Severity) ? (item.severity as Severity) : undefined;
    if (!file || !summary || !severity) continue;
    const num = (v: unknown): number | undefined => {
      const n = typeof v === 'string' ? Number(v) : (v as number);
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    };
    const line = num(item.line);
    let startLine = num(item.start_line ?? item.startLine);
    if (startLine !== undefined && (line === undefined || startLine >= line)) startLine = undefined;
    findings.push({
      file,
      line,
      startLine,
      severity,
      category: typeof item.category === 'string' && item.category ? item.category : 'general',
      summary,
      body: typeof item.body === 'string' && item.body ? item.body : summary,
      failureScenario: typeof item.failure_scenario === 'string' && item.failure_scenario ? item.failure_scenario : undefined,
      suggestion: typeof item.suggestion === 'string' && item.suggestion ? item.suggestion : undefined,
      verified: Boolean(item.verified),
    });
  }
  return findings;
}

export interface VerdictEntry {
  index: number;
  verdict: 'confirmed' | 'plausible' | 'rejected';
  reason: string;
  severity?: Severity;
  line?: number;
}

export function parseVerdicts(raw: unknown): { verdicts: VerdictEntry[]; overallSummary?: string } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  let value = obj.verdicts;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const verdicts: VerdictEntry[] = [];
  if (Array.isArray(value)) {
    for (const item of value as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object') continue;
      const index = typeof item.index === 'string' ? Number(item.index) : (item.index as number);
      const verdict = item.verdict;
      if (!Number.isInteger(index) || (verdict !== 'confirmed' && verdict !== 'plausible' && verdict !== 'rejected')) continue;
      verdicts.push({
        index: index as number,
        verdict,
        reason: typeof item.reason === 'string' ? item.reason : '',
        severity: SEVERITIES.includes(item.severity as Severity) ? (item.severity as Severity) : undefined,
        line: typeof item.line === 'number' && Number.isFinite(item.line) && item.line > 0 ? Math.floor(item.line) : undefined,
      });
    }
  }
  return { verdicts, overallSummary: typeof obj.overall_summary === 'string' && obj.overall_summary ? obj.overall_summary : undefined };
}

/**
 * Applies the verification pass's verdicts: rejected findings are dropped
 * (returned separately so the preview can show what was filtered and why —
 * that transparency is what makes the filter trustworthy rather than
 * silent), confirmed/plausible are labeled, and severity/line corrections
 * are applied. A finding the verifier never mentioned stays, as 'plausible'
 * — an incomplete verdict list must not silently discard findings.
 */
export function applyVerdicts(findings: Finding[], verdicts: VerdictEntry[]): { kept: Finding[]; rejected: RejectedFinding[] } {
  const byIndex = new Map<number, VerdictEntry>();
  for (const v of verdicts) {
    if (v.index >= 0 && v.index < findings.length && !byIndex.has(v.index)) byIndex.set(v.index, v);
  }
  const kept: Finding[] = [];
  const rejected: RejectedFinding[] = [];
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]!;
    const v = byIndex.get(i);
    if (!v) {
      kept.push({ ...f, verdict: 'plausible' });
      continue;
    }
    if (v.verdict === 'rejected') {
      rejected.push({ finding: f, reason: v.reason || 'rejected by verification' });
      continue;
    }
    kept.push({
      ...f,
      verdict: v.verdict,
      severity: v.severity ?? f.severity,
      line: v.line ?? f.line,
      // A corrected line invalidates any range/suggestion tied to the old one.
      startLine: v.line !== undefined ? undefined : f.startLine,
      suggestion: v.line !== undefined ? undefined : f.suggestion,
    });
  }
  return { kept, rejected };
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

/** Most severe first; within a severity, verifier-confirmed findings before merely-plausible ones. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return (a.verdict === 'confirmed' ? 0 : 1) - (b.verdict === 'confirmed' ? 0 : 1);
  });
}

export function countBySeverity(findings: Finding[]): string {
  return SEVERITIES.map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(' · ');
}

// ---------------------------------------------------------------------------
// Diff splitting & batching — the fix for "truncate at N chars and silently
// review only whatever came first" (a live incident: a 698K-char diff cut at
// 40K meant the model reviewed the plan document and never saw the code).
// Instead: split per file, drop generated/lockfiles, and review every real
// file across as many batches as the budget requires.
// ---------------------------------------------------------------------------

export interface FileDiff {
  file: string;
  content: string;
}

export function splitDiffByFile(diff: string): FileDiff[] {
  const parts: FileDiff[] = [];
  let currentFile: string | undefined;
  let current: string[] = [];
  const flush = (): void => {
    if (currentFile) parts.push({ file: currentFile, content: current.join('\n') });
  };
  for (const line of diff.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      flush();
      currentFile = m[2];
      current = [line];
    } else if (currentFile) {
      current.push(line);
    }
  }
  flush();
  return parts;
}

const SKIP_BASENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'go.sum',
]);
const SKIP_PATH_RE = /(^|\/)(node_modules|dist|build|out|coverage|vendor)\//;
const SKIP_SUFFIX_RE = /\.(min\.js|min\.css|map|wasm|snap)$/i;

/** Lockfiles and generated artifacts — top review tools skip these outright; reviewing them wastes the entire budget on noise no human reviews either. */
export function shouldSkipFile(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return SKIP_BASENAMES.has(base) || SKIP_PATH_RE.test(path) || SKIP_SUFFIX_RE.test(path);
}

/**
 * Greedy-packs per-file diffs into batches of at most `budgetChars` each. A
 * single file bigger than the whole budget is truncated (with an explicit
 * marker) rather than dropped — the only place truncation still exists, and
 * it's per-file and labeled, not silent.
 */
export function packBatches(files: FileDiff[], budgetChars: number): { batches: FileDiff[][]; truncatedFiles: string[] } {
  const truncatedFiles: string[] = [];
  const prepared = files.map((f) => {
    if (f.content.length <= budgetChars) return f;
    truncatedFiles.push(f.file);
    return { file: f.file, content: f.content.slice(0, budgetChars) + '\n… [diff for this file truncated to fit the review budget]' };
  });
  const batches: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let size = 0;
  for (const f of prepared) {
    if (current.length > 0 && size + f.content.length > budgetChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += f.content.length;
  }
  if (current.length > 0) batches.push(current);
  return { batches, truncatedFiles };
}

// ---------------------------------------------------------------------------
// Diff-line anchoring — GitHub's review API only accepts inline comments on
// lines that appear in a diff hunk. Anything else folds into the top-level
// review body instead of being silently dropped or rejected by the API.
// ---------------------------------------------------------------------------

export function parseDiffHunkRanges(diff: string): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  let currentFile: string | undefined;
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of diff.split('\n')) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    const hunkMatch = currentFile ? hunkRe.exec(line) : null;
    if (hunkMatch) {
      const start = Number(hunkMatch[1]);
      const count = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      const list = ranges.get(currentFile!) ?? [];
      list.push([start, start + Math.max(count, 1) - 1]);
      ranges.set(currentFile!, list);
    }
  }
  return ranges;
}

export function isAnchorable(ranges: Map<string, Array<[number, number]>>, file: string, line: number | undefined): boolean {
  if (line === undefined) return false;
  const list = ranges.get(file);
  if (!list) return false;
  return list.some(([start, end]) => line >= start && line <= end);
}

/** A range anchor (start_line..line) is only usable when the whole range sits inside one hunk's coverage. */
export function isRangeAnchorable(ranges: Map<string, Array<[number, number]>>, f: Finding): boolean {
  if (f.startLine === undefined || f.line === undefined) return false;
  const list = ranges.get(f.file);
  if (!list) return false;
  return list.some(([start, end]) => f.startLine! >= start && f.line! <= end);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * `gh` posts as whatever account is locally authenticated — there is no
 * separate Heap Code bot identity — so the body itself is the only place a
 * review can be disclosed as AI-generated rather than the user's own writing.
 * Used by both the structured review body and the plain-text fallback comment.
 */
export function aiDisclosure(client: ReviewClient): string {
  return `🤖 *AI-generated review, posted via ${client.attribution}.*`;
}

function verdictLabel(f: Finding): string {
  if (f.verdict === 'confirmed') return 'verified in code';
  if (f.verdict === 'plausible') return 'plausible — not fully confirmed';
  return f.verified ? 'verified' : 'unverified — could not confirm';
}

/** ```suggestion blocks are one-click-applicable in GitHub's UI — but only render sanely when the suggestion itself contains no triple-backtick fence. */
function suggestionBlock(f: Finding, forGitHubInline: boolean): string | undefined {
  if (!f.suggestion || f.suggestion.includes('```')) return undefined;
  const fence = forGitHubInline ? 'suggestion' : '';
  return `\`\`\`${fence}\n${f.suggestion}\n\`\`\``;
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  /** Head commit the review anchors to. Absent in preview-only contexts (tests). */
  headRefOid?: string;
}

/**
 * The two places a rendered review has to name its host: the attribution
 * line on the posted body, and the pointer to the deep variant. Everything
 * else about the output is host-independent.
 */
export interface ReviewClient {
  /** Who posted, e.g. "the Heap Code VS Code extension" or "the Heap Code CLI". */
  attribution: string;
  /** How to ask for the verified pass here, e.g. 'run "Heap Code: Review Current PR (Deep, Verified)"' or 'run "/pr-review deep"'. */
  deepHint: string;
}

export const DEFAULT_REVIEW_CLIENT: ReviewClient = {
  attribution: 'Heap Code',
  deepHint: 'run the deep review command',
};

export interface ReviewNotes {
  skippedFiles?: string[];
  unreviewedFiles?: string[];
  truncatedFiles?: string[];
  /** The verification pass never returned structured verdicts — findings are unadjudicated first-pass output. Disclosed in the posted body, not just the preview: a reader weighing the findings deserves to know no second pass vetted them. */
  verificationSkipped?: boolean;
  /** Fast mode: the verification pass was skipped by design (the default command), not because it failed. */
  singlePass?: boolean;
}

/** Caps `text` at `max` chars, cutting at the last sentence boundary instead of mid-word — a live run posted a summary ending "…a missing try-catch in AuditLog.track, r". */
export function capAtSentence(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
  return lastStop > max * 0.4 ? slice.slice(0, lastStop + 1) : slice + '…';
}

function notesLines(notes: ReviewNotes | undefined, client: ReviewClient): string[] {
  if (!notes) return [];
  const lines: string[] = [];
  if (notes.skippedFiles?.length) lines.push(`_Skipped (lockfiles/generated): ${notes.skippedFiles.join(', ')}_`);
  if (notes.truncatedFiles?.length) lines.push(`_Diff truncated for oversized file(s): ${notes.truncatedFiles.join(', ')}_`);
  if (notes.unreviewedFiles?.length)
    lines.push(`_⚠️ Not reviewed (batch limit reached): ${notes.unreviewedFiles.join(', ')} — treat these as unreviewed, not clean._`);
  if (notes.verificationSkipped)
    lines.push('_⚠️ The verification pass did not complete — findings below are unadjudicated first-pass output and may include false positives._');
  else if (notes.singlePass)
    lines.push(`_Single-pass review. For findings vetted by an independent verification pass, ${client.deepHint}._`);
  return lines;
}

/** The editor-preview doc shown before the confirm dialog — includes which findings will post as inline GitHub comments vs. a general note, plus what verification filtered out and why, so nothing about the posted result is a surprise. */
export function formatPreviewMarkdown(
  pr: PrInfo,
  summary: string,
  findings: Finding[],
  ranges: Map<string, Array<[number, number]>>,
  rejected?: RejectedFinding[],
  notes?: ReviewNotes,
  client: ReviewClient = DEFAULT_REVIEW_CLIENT,
): string {
  const sorted = sortFindings(findings);
  const lines = [`# Review of PR #${pr.number}: ${pr.title}`, pr.url, '', summary.trim(), ''];
  if (findings.length > 0) lines.push(`**Findings:** ${countBySeverity(findings)}`, '');
  lines.push(...notesLines(notes, client));
  for (const f of sorted) {
    const anchored = isAnchorable(ranges, f.file, f.line);
    const where = f.line !== undefined ? `${f.file}:${f.startLine !== undefined ? `${f.startLine}-` : ''}${f.line}` : f.file;
    lines.push(
      `---`,
      '',
      `### ${SEVERITY_ICON[f.severity]} ${f.summary}`,
      `*${where} · ${f.category} · ${verdictLabel(f)} · ` +
        `${anchored ? '📍 will post as an inline comment' : '📄 will post in the general summary (line not in this diff)'}*`,
      '',
      f.body,
    );
    if (f.failureScenario) lines.push('', `**Failure scenario:** ${f.failureScenario}`);
    const block = suggestionBlock(f, false);
    if (block) lines.push('', '**Suggested replacement:**', block);
    lines.push('');
  }
  if (rejected && rejected.length > 0) {
    lines.push('---', '', `## Filtered out by verification (${rejected.length} — will NOT be posted)`, '');
    for (const r of rejected) {
      lines.push(`- ~~${r.finding.summary}~~ (${r.finding.file}${r.finding.line !== undefined ? `:${r.finding.line}` : ''}) — ${r.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** The actual GitHub review body — concise, since anchored findings get their own inline comment; only unanchored ones need full detail here. */
export function formatReviewBody(
  summary: string,
  findings: Finding[],
  ranges: Map<string, Array<[number, number]>>,
  notes?: ReviewNotes,
  client: ReviewClient = DEFAULT_REVIEW_CLIENT,
): string {
  const sorted = sortFindings(findings);
  const anchored = sorted.filter((f) => isAnchorable(ranges, f.file, f.line));
  const unanchored = sorted.filter((f) => !isAnchorable(ranges, f.file, f.line));
  const parts = [aiDisclosure(client), '', '---', '', summary.trim()];
  if (findings.length > 0) parts.push('', `**Findings:** ${countBySeverity(findings)}`);
  const notes_ = notesLines(notes, client);
  if (notes_.length > 0) parts.push('', ...notes_);
  if (anchored.length > 0) {
    parts.push('', `${anchored.length} finding(s) posted as inline comments below.`);
  }
  for (const f of unanchored) {
    const where = f.line !== undefined ? `${f.file}:${f.line} (line not part of this diff)` : f.file;
    parts.push('', '---', '', `### ${SEVERITY_ICON[f.severity]} ${f.summary}`, `*${where} · ${f.category} · ${verdictLabel(f)}*`, '', f.body);
    if (f.failureScenario) parts.push('', `**Failure scenario:** ${f.failureScenario}`);
    const block = suggestionBlock(f, false);
    if (block) parts.push('', '**Suggested replacement:**', block);
  }
  return parts.join('\n');
}

export function formatInlineCommentBody(f: Finding): string {
  const parts = [`🤖 ${SEVERITY_ICON[f.severity]} **${f.summary}** *(${f.category} · ${verdictLabel(f)})*`, '', f.body];
  if (f.failureScenario) parts.push('', `**Failure scenario:** ${f.failureScenario}`);
  const block = suggestionBlock(f, true);
  if (block) parts.push('', block);
  return parts.join('\n');
}
