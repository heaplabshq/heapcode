import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { ChatMessage, Provider } from '../providers/types.js';
import type { ToolCall, ToolDefinition } from '../agent/tools.js';
import {
  REPORT_FINDINGS_TOOL,
  REPORT_VERDICTS_TOOL,
  SEVERITY_DEFINITIONS,
  aiDisclosure,
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
  type PrInfo,
  type RejectedFinding,
  type ReviewClient,
  type ReviewNotes,
} from './prReviewFormat.js';

// Per-batch diff budget in characters, sized to the active model's real
// context window (see reviewCurrentPr) between this floor and ceiling. The
// floor covers small/unknown context windows; the ceiling keeps a
// huge-context model from spending its entire budget on diff text and
// leaving nothing for the read-only tool round-trips each phase relies on.
const MIN_DIFF_CHARS = 40_000;
const MAX_DIFF_CHARS_CEILING = 200_000;
// Reserve the rest of the context window for system/tool overhead, the
// read-only tool loop's own round-trips, and the model's final response.
const DIFF_CONTEXT_FRACTION = 0.4;
// Bounds the total cost of a huge PR: at most this many review batches run;
// files beyond that are reported as unreviewed rather than silently skipped.
const MAX_BATCHES = 6;
// Tool-loop iterations per phase call in deep mode (each batch review, and
// the verify pass). Fast mode uses the smaller budget — its whole point is
// staying close to "one pass over the diff" latency.
const MAX_TOOL_ITERATIONS_DEEP = 8;
const MAX_TOOL_ITERATIONS_FAST = 5;
// Consecutive protocol slips (plain-text answers / rejected terminal calls)
// before giving up on structured output. A model that has ignored the
// protocol twice in a row essentially never recovers on the third nudge —
// burning the remaining iterations on it was the single biggest time sink
// observed live (two full 8-round phases spent nudging a model that was
// never going to call the tool).
const MAX_PROTOCOL_SLIPS = 2;
// Below this batch size, an empty findings array is credible without a retry
// nudge (a truly small diff can genuinely be clean).
const NUDGE_EMPTY_MIN_CHARS = 20_000;
// Findings JSON and multi-batch output need real room — a low profile
// maxTokens (tuned for chat) starves the findings list mid-array.
const MIN_MAX_TOKENS = 8_192;

interface GhResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs `gh` directly (no shell) — an explicit argument array, never string-interpolated, so nothing here can be an injection surface. */
function runGh(args: string[], cwd: string, stdin?: string): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.on('error', (err) => resolve({ stdout: '', stderr: String(err), code: -1 }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/** Same contract as `runGh`, for the local-checkout fallback. */
function runGit(args: string[], cwd: string): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.on('error', (err) => resolve({ stdout: '', stderr: String(err), code: -1 }));
  });
}

/** One file as the pulls/N/files endpoint describes it. */
interface PrFileEntry {
  filename: string;
  previous_filename?: string;
  status?: string;
  patch?: string;
}

/**
 * The PR's diff, from whichever endpoint will actually give it to us.
 *
 * `gh pr diff` is the obvious way and it has a hard ceiling: GitHub refuses the
 * `.diff` media type above 20,000 lines with `406 Sorry, the diff exceeded the
 * maximum number of lines`. That is not an exotic size -- a branch that adds a
 * feature reaches it -- and the failure landed as "no changes, or gh failed",
 * which sends the user to check their `gh` install for a problem that is not
 * there.
 *
 * `pulls/{n}/files` has no such ceiling: it paginates, and it returns each
 * file's patch separately. That is also the shape this reviewer wants, since it
 * batches per file anyway -- so the fallback is closer to the natural source
 * than the primary was. The entries are reassembled into a unified diff because
 * everything downstream (`splitDiffByFile`, `parseDiffHunkRanges`, and the line
 * anchoring that depends on them) reads `diff --git` and `+++ b/` headers.
 *
 * A file with no `patch` is binary, or one the API stopped computing partway
 * through a large PR -- the latter come back as `+0/-0 added`, which reads as
 * an empty change and is not one. Those are asked of the local checkout, which
 * is the head of this branch anyway. Whatever is still missing after that is
 * reported to the user rather than passed over, for the same reason a batch
 * that could not be reached is.
 */
export async function fetchPrDiff(
  number: number,
  cwd: string,
  baseRef?: string,
): Promise<{ diff: string; unreviewable: string[]; reason?: string; gitRoot?: string }> {
  const topLevelEarly = await runGit(['rev-parse', '--show-toplevel'], cwd);
  const root =
    topLevelEarly.code === 0 && topLevelEarly.stdout.trim() ? topLevelEarly.stdout.trim() : undefined;

  const direct = await runGh(['pr', 'diff', String(number)], cwd);
  if (direct.code === 0 && direct.stdout.trim()) {
    return { diff: direct.stdout, unreviewable: [], gitRoot: root };
  }

  const listed = await runGh(
    [
      'api',
      `repos/{owner}/{repo}/pulls/${number}/files`,
      '--paginate',
      '--jq',
      '.[] | {filename, previous_filename, status, patch}',
    ],
    cwd,
  );
  if (listed.code !== 0) {
    // Whichever error is real. `gh` explains itself well -- "the diff exceeded
    // the maximum number of lines (20000)" is actionable and was being thrown
    // away -- so it is passed through rather than replaced with a guess.
    const detail = (listed.stderr.trim() || direct.stderr.trim() || '').split('\n')[0];
    return {
      diff: '',
      unreviewable: [],
      reason: detail || 'gh could not list the changed files',
      gitRoot: root,
    };
  }
  if (!listed.stdout.trim()) {
    // The endpoint answered and had nothing to say. Distinguished from the
    // branch above on purpose: "the PR is empty" and "the call failed" are
    // different problems, and reporting the first as the second is how the
    // original message sent someone to check their `gh` install.
    return { diff: '', unreviewable: [], reason: 'it has no changes', gitRoot: root };
  }

  // The paths the API reports are relative to the repository root, and a
  // pathspec is resolved against the process's working directory -- which is
  // wherever the host happened to be started, not necessarily the root. Asking
  // git for the root once and diffing from there is what makes the fallback
  // independent of that. (`gh` needs no equivalent: it walks up to find the
  // repo on its own, which is why the first two tiers worked from a
  // subdirectory while this one silently matched nothing.)
  const gitRoot = root ?? cwd;

  const parts: string[] = [];
  const unreviewable: string[] = [];
  for (const line of listed.stdout.split('\n')) {
    if (!line.trim()) continue;
    let entry: PrFileEntry;
    try {
      entry = JSON.parse(line) as PrFileEntry;
    } catch {
      continue;
    }
    if (!entry.filename) continue;
    if (!entry.patch) {
      // GitHub omits the patch for binary files, and *also* stops computing
      // them partway through a very large PR -- those come back as `+0/-0`
      // with no patch, which looks like an empty change and is not one. The
      // working tree is the head of this branch, so ask git for the ones the
      // API gave up on rather than reporting a source file as unreviewable
      // when its diff is sitting on disk.
      const local = baseRef
        ? await runGit(
            ['diff', '--no-color', `origin/${baseRef}...HEAD`, '--', entry.filename],
            gitRoot,
          )
        : undefined;
      if (local?.code === 0 && local.stdout.includes('@@')) {
        parts.push(local.stdout.endsWith('\n') ? local.stdout.slice(0, -1) : local.stdout);
      } else {
        unreviewable.push(entry.filename);
      }
      continue;
    }

    const before =
      entry.status === 'added' ? undefined : (entry.previous_filename ?? entry.filename);
    const after = entry.status === 'removed' ? undefined : entry.filename;
    parts.push(
      `diff --git a/${before ?? entry.filename} b/${after ?? entry.filename}`,
      `--- ${before ? `a/${before}` : '/dev/null'}`,
      `+++ ${after ? `b/${after}` : '/dev/null'}`,
      entry.patch.endsWith('\n') ? entry.patch.slice(0, -1) : entry.patch,
    );
  }

  if (parts.length === 0) {
    return {
      diff: '',
      unreviewable,
      reason: unreviewable.length > 0 ? 'every changed file is binary or too large' : 'it has no changes',
      gitRoot: root,
    };
  }
  return { diff: `${parts.join('\n')}\n`, unreviewable, gitRoot: root };
}

/**
 * The minimum a host's tool executor has to provide for the review's
 * read-only investigation loop — deliberately structural rather than a
 * shared base class, since the CLI and the extension each have their own
 * WorkspaceToolExecutor and both already satisfy this.
 */
export interface PrReviewToolExecutor {
  describe(call: ToolCall): string;
  execute(call: ToolCall, signal?: AbortSignal): Promise<{ content: string }>;
}

/** What the review asks the user to confirm before anything is posted publicly. */
export interface PrReviewConfirmation {
  pr: PrInfo;
  /** The full markdown the user must be shown before deciding. */
  preview: string;
  findingCount: number;
  /** How many of those will post as line-anchored inline comments. */
  inlineCount: number;
  /** The model never produced structured output — this is its raw text, posted as a plain comment. */
  plainText: boolean;
}

/**
 * Everything the review needs from its host (VS Code notifications + an
 * editor tab, or the CLI transcript + a picker). Keeping this narrow is what
 * lets the whole flow — including every degradation path — be shared rather
 * than reimplemented per host.
 */
export interface PrReviewHost {
  /** A recoverable problem or caveat the user should see. */
  warn(message: string): void;
  /** The review could not complete. */
  error(message: string): void;
  /** Diagnostic line for an output channel / debug log, not the user's main view. */
  log(message: string): void;
  /** Progress while the review runs. */
  progress(message: string): void;
  /** Show `preview` in full and ask whether to post. Returning false cancels — nothing is posted. */
  confirm(confirmation: PrReviewConfirmation): Promise<boolean>;
}

export interface PrReviewOptions {
  /** Repo root — `gh` runs here, so it determines which PR is "current". */
  cwd: string;
  provider: Provider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** The active model's real context window, in tokens — sizes the per-batch diff budget. */
  contextWindow: number;
  /** The host's full tool list; only read-only tools (minus ask_user) are offered to the review. */
  tools: ToolDefinition[];
  executor: PrReviewToolExecutor;
  host: PrReviewHost;
  client: ReviewClient;
  signal: AbortSignal;
  /** Run the independent verification pass — roughly double the wall time and model cost. */
  deep?: boolean;
}

export type PrReviewResult =
  /** Posted successfully; `pr` carries the URL for a host "Open PR" affordance. */
  | { status: 'posted'; pr: PrInfo }
  /** The user declined at the confirm step, or aborted mid-run. */
  | { status: 'cancelled' }
  /** Stopped before producing a review — the reason has already gone to host.warn/error. */
  | { status: 'skipped' };

interface ToolLoopOptions<T> {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  /** The structured-output tool that terminates the loop. */
  terminal: ToolDefinition;
  /** Parse + validate the terminal call's args. `ok: false` sends `feedback` back as the tool result and continues the loop. */
  accept(args: Record<string, unknown>): { ok: true; value: T } | { ok: false; feedback: string };
  tools: ToolDefinition[];
  executor: PrReviewToolExecutor;
  temperature: number | undefined;
  maxTokens: number;
  maxIterations: number;
  signal: AbortSignal;
  host: PrReviewHost;
  label: string;
}

/**
 * A read-only chat-with-tools loop, self-contained (not tied to any live
 * chat transcript) — the model investigates with read-only tools and
 * terminates by calling `terminal` with structured output (the Cline/
 * OpenHands structural-termination pattern: "no tool call" is a protocol
 * slip to nudge about, not an answer to accept). Returns the parsed value,
 * or the model's last plain text when it never cooperated — the caller
 * decides how to degrade.
 */
async function runToolLoop<T>(opts: ToolLoopOptions<T>): Promise<{ value: T } | { rawText: string }> {
  const tools = [...opts.tools, opts.terminal];
  const convo = [...opts.messages];
  let lastText = '';
  let protocolSlips = 0;

  for (let i = 0; i < opts.maxIterations; i++) {
    const finalRound = i === opts.maxIterations - 1;
    if (finalRound) {
      convo.push({ role: 'user', content: `Investigation time has ended. Call ${opts.terminal.name} now with your final result.` });
    }
    const res = await opts.provider.chat({
      model: opts.model,
      messages: convo,
      tools,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
    });
    lastText = res.content || lastText;

    const terminalCall = res.toolCalls?.find((c) => c.name === opts.terminal.name);
    if (terminalCall) {
      if (terminalCall.argsParseError) {
        opts.host.log(`[pr-review] ${opts.label}: ${opts.terminal.name} had invalid JSON: ${terminalCall.argsParseError}`);
        return { rawText: lastText };
      }
      const accepted = opts.accept(terminalCall.args);
      if (accepted.ok) return { value: accepted.value };
      protocolSlips++;
      if (finalRound || protocolSlips > MAX_PROTOCOL_SLIPS) return { rawText: lastText };
      opts.host.log(`[pr-review] ${opts.label}: rejected ${opts.terminal.name} result — ${accepted.feedback.slice(0, 120)}`);
      convo.push({
        role: 'assistant',
        content: res.content,
        toolCalls: [{ id: terminalCall.id, name: terminalCall.name, args: terminalCall.args }],
      });
      convo.push({ role: 'tool', content: accepted.feedback, toolCallId: terminalCall.id });
      continue;
    }

    if (res.toolCalls && res.toolCalls.length > 0) {
      protocolSlips = 0; // cooperating with the tool protocol — reset the strike count
      convo.push({
        role: 'assistant',
        content: res.content,
        toolCalls: res.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });
      for (const call of res.toolCalls) {
        const toolCall = { id: call.id, name: call.name, args: call.args };
        opts.host.log(`[pr-review] ${opts.label}: tool ${opts.executor.describe(toolCall)}`);
        // A failed tool call (model guessed a nonexistent path, etc.) goes
        // back to the model as an error result to self-correct from — same
        // guard the core agent loop has. Unguarded, one ENOENT throw killed
        // entire reviews minutes in (a recurring live failure).
        let result: { content: string };
        try {
          result = call.argsParseError
            ? { content: `Invalid JSON arguments: ${call.argsParseError}` }
            : await opts.executor.execute(toolCall, opts.signal);
        } catch (err) {
          result = { content: `Tool failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        convo.push({ role: 'tool', content: result.content, toolCallId: call.id });
      }
      continue;
    }

    // Plain text, no tool call — nudge back onto the protocol, but only
    // MAX_PROTOCOL_SLIPS times before accepting this model won't cooperate.
    protocolSlips++;
    if (finalRound || protocolSlips > MAX_PROTOCOL_SLIPS) break;
    convo.push({ role: 'assistant', content: res.content });
    convo.push({ role: 'user', content: `Call ${opts.terminal.name} with your result — do not answer in plain text.` });
  }
  return { rawText: lastText };
}

const REVIEW_RULES =
  'Review rules — precision over volume; a small number of real findings beats a long list of maybes:\n' +
  '- Findings are PROBLEMS only. Never report praise, improvements this PR makes, or bugs this PR fixes as findings — if the diff fixes something, that belongs (briefly) in the summary, not in findings.\n' +
  '- Your summary is written for the PR author: describe the reviewed code, never the review process itself (no "batch", no tool names, no mechanics).\n' +
  '- Bugs, security issues, and correctness problems first. Style/maintainability only when it materially hurts the code (severity: low).\n' +
  '- For every correctness/security/performance finding, fill in failure_scenario: the concrete input or state that triggers it and the wrong outcome. If you cannot construct one, it is not a finding — drop it.\n' +
  '- Use read_file/search to check the surrounding code before claiming anything specific (a config field, an exit code, whether something runs in a given case). Never infer codebase facts from documentation, comments, or the diff alone. Mark verified=true only for claims you actually confirmed this way — and remember you cannot run code, so runtime behavior (races, timing, library internals) is never "verified", only plausible.\n' +
  '- Skip issues explicitly documented as known limitations in nearby code comments or docs — rediscovering them is noise.\n' +
  '- Skip pre-existing problems on lines this PR does not touch, unless severe — and then report them file-level (no line number).\n' +
  '- When (and only when) you are confident in an exact fix for the anchored line(s), include `suggestion` with the complete replacement for exactly those lines — it becomes a one-click-applicable GitHub suggestion.\n' +
  '- Do not restate the PR number or title; the reader already sees them.';

function buildBatchPrompt(
  pr: PrInfo,
  batchIndex: number,
  batchCount: number,
  files: Array<{ file: string; content: string }>,
  batchDiff: string,
): string {
  const scope =
    batchCount > 1
      ? `This is batch ${batchIndex + 1} of ${batchCount}; it covers only these files (other batches cover the rest — do not comment on files outside this batch):\n${files.map((f) => `- ${f.file}`).join('\n')}\n\n`
      : '';
  return (
    `You are reviewing pull request #${pr.number} ("${pr.title}") as a precise, high-signal code reviewer.\n\n` +
    scope +
    SEVERITY_DEFINITIONS +
    '\n\n' +
    REVIEW_RULES +
    '\n\nWhen you are done, call report_findings exactly once. Line numbers must refer to each file\'s CURRENT content ' +
    '(use read_file to confirm them — diff hunk headers tell you roughly where you are).\n\n' +
    `\`\`\`diff\n${batchDiff}\n\`\`\``
  );
}

function buildVerifyPrompt(pr: PrInfo, findings: Finding[]): string {
  const items = findings.map((f, i) => ({
    index: i,
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    summary: f.summary,
    body: f.body,
    failure_scenario: f.failureScenario,
    self_reported_verified: f.verified,
  }));
  return (
    `You are the independent verification pass of an automated review of pull request #${pr.number} ("${pr.title}"). ` +
    'The candidate findings below came from a first-pass reviewer. Your job is to kill false positives before ' +
    'they reach a human — a wrong finding costs more trust than a missed one.\n\n' +
    'For EACH finding, re-read the actual code with read_file/search and adjudicate:\n' +
    '- confirmed: you located the exact code and the failure scenario genuinely follows from it.\n' +
    '- plausible: you could neither confirm nor clearly refute it.\n' +
    '- rejected: the claim is contradicted by the code; or it relies on language/library behavior that does not ' +
    'actually happen (check Node.js and library semantics carefully — e.g. an fs mode option applies atomically at ' +
    'creation, not afterward); or it is documented as a known limitation right next to the code; or it duplicates ' +
    'another finding (reject the later one and say which it duplicates); or it is style-level noise dressed up as a bug.\n\n' +
    'Also correct inflated or deflated severities against the rubric, and fix wrong line numbers (verify against the ' +
    "file's current content).\n\n" +
    'Be decisive: after actually reading the code, most findings should end up confirmed or rejected. Reserve ' +
    '"plausible" for cases the code genuinely leaves open — an all-plausible verdict list means you did not really ' +
    'check. It is normal and expected to reject several candidates; also reject anything that is praise or a ' +
    'description of something this PR fixes rather than an actual problem.\n\n' +
    SEVERITY_DEFINITIONS +
    '\n\nCall report_verdicts exactly once, with one verdict per finding index, plus overall_summary: a 2-4 sentence ' +
    'assessment of the PR for its author.\n\n' +
    `Candidate findings:\n\`\`\`json\n${JSON.stringify(items, null, 1)}\n\`\`\``
  );
}

/**
 * Posts a real GitHub PR review (`POST .../pulls/{n}/reviews`) — inline
 * comments (with one-click ```suggestion blocks where the model provided
 * them) for findings anchorable to an actual diff line, everything else
 * folded into the top-level body. Always `event: COMMENT`, never
 * REQUEST_CHANGES — this is advisory input for a human, not an autonomous
 * gatekeeper on the merge.
 */
async function postStructuredReview(
  cwd: string,
  pr: PrInfo,
  summary: string,
  findings: Finding[],
  ranges: Map<string, Array<[number, number]>>,
  notes: ReviewNotes,
  client: ReviewClient,
  /**
   * Pass false to post everything in the body with no inline comments — the
   * retry path when GitHub rejects an anchor. Passing an empty range map makes
   * formatReviewBody treat every finding as unanchored, so each one renders in
   * full detail instead of the one-line "posted as an inline comment" pointer.
   */
  inline = true,
): Promise<GhResult> {
  if (!inline) ranges = new Map();
  const anchored = findings.filter((f) => isAnchorable(ranges, f.file, f.line));
  const payload: Record<string, unknown> = {
    commit_id: pr.headRefOid,
    body: formatReviewBody(summary, findings, ranges, notes, client),
    event: 'COMMENT',
  };
  if (anchored.length > 0) {
    payload.comments = anchored.map((f) => {
      const useRange = isRangeAnchorable(ranges, f);
      return {
        path: f.file,
        line: f.line,
        side: 'RIGHT',
        ...(useRange ? { start_line: f.startLine, start_side: 'RIGHT' } : {}),
        // A suggestion must replace exactly the commented range — a single-line
        // comment with a multi-line-range suggestion posts fine but applies wrong.
        body: formatInlineCommentBody(useRange || f.startLine === undefined ? f : { ...f, suggestion: undefined }),
      };
    });
  }
  return runGh(
    ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${pr.number}/reviews`, '--input', '-'],
    cwd,
    JSON.stringify(payload),
  );
}

/**
 * PLAN.md M13, rebuilt: review the current branch's PR the way the best
 * review tools do — per-file batches instead of blind truncation, a
 * structured findings phase with required failure scenarios, and finally
 * (only with explicit confirmation) a real GitHub review with line-anchored
 * inline comments and one-click suggestions. With `deep: true`, an
 * independent verification pass re-reads the code between those two steps
 * and kills false positives before anything is shown — roughly double the
 * wall time and model cost, which live use showed is too slow to be the
 * default (and on weaker models the pass often fails outright); the fast
 * single-pass default mirrors the quick-vs-deep split every major review
 * tool ships. `gh` handles auth/posting — reusing whatever `gh auth login`
 * session already exists rather than building token storage. The full
 * result (including, in deep mode, what verification filtered out and why)
 * always goes through host.confirm before anything is posted.
 *
 * Host-agnostic on purpose: the VS Code command and the CLI's /pr-review are
 * both thin adapters over this, so the two can never drift in review quality.
 */
export async function reviewCurrentPr(opts: PrReviewOptions): Promise<PrReviewResult> {
  const { cwd, host, signal, client } = opts;
  const deep = opts.deep ?? false;

  const version = await runGh(['--version'], cwd);
  if (version.code !== 0) {
    host.error(
      'the GitHub CLI ("gh") is required for PR review. Install it from https://cli.github.com, run "gh auth login", then try again.',
    );
    return { status: 'skipped' };
  }

  const prView = await runGh(
    ['pr', 'view', '--json', 'number,title,url,headRefOid,baseRefName'],
    cwd,
  );
  if (prView.code !== 0) {
    host.warn(`no pull request found for the current branch (${prView.stderr.trim() || 'gh pr view failed'}).`);
    return { status: 'skipped' };
  }
  let pr: PrInfo;
  try {
    pr = JSON.parse(prView.stdout) as PrInfo;
  } catch {
    host.error('could not parse "gh pr view" output.');
    return { status: 'skipped' };
  }

  const fetched = await fetchPrDiff(pr.number, cwd, pr.baseRefName);
  if (!fetched.diff.trim()) {
    host.warn(`could not fetch a diff for this PR — ${fetched.reason ?? 'it has no changes'}.`);
    return { status: 'skipped' };
  }
  if (fetched.gitRoot && resolve(fetched.gitRoot) !== resolve(cwd)) {
    // Worth saying out loud: every path in the diff is relative to the
    // repository root, and the review's own file-reading tools resolve against
    // the workspace. Started somewhere below the root, the reviewer can read
    // the diff and cannot open a single file it names -- so it reviews from the
    // diff text alone and says nothing about why it got quieter.
    host.warn(
      `the workspace is ${cwd}, which is not the repository root (${fetched.gitRoot}). ` +
        `Paths in the diff are relative to the root, so the review may not be able to open ` +
        `the files it is reviewing. Start heapcode from the repository root for a full review.`,
    );
  }
  if (fetched.unreviewable.length > 0) {
    // Named, not silently dropped: the whole point of the per-file rewrite was
    // that a file nobody reviewed must not read as a file with nothing wrong.
    host.warn(
      `${fetched.unreviewable.length} file(s) carry no reviewable patch (binary, or too large for ` +
        `the API to return): ${fetched.unreviewable.slice(0, 10).join(', ')}` +
        `${fetched.unreviewable.length > 10 ? ', …' : ''}`,
    );
  }
  const fullDiff = fetched.diff;
  const diffRanges = parseDiffHunkRanges(fullDiff);

  // ~4 chars/token is a rough but standard estimate — good enough for sizing
  // a budget, not for exact accounting.
  const diffBudgetChars = Math.min(
    MAX_DIFF_CHARS_CEILING,
    Math.max(MIN_DIFF_CHARS, Math.floor(opts.contextWindow * 4 * DIFF_CONTEXT_FRACTION)),
  );

  const allFiles = splitDiffByFile(fullDiff);
  const skippedFiles = allFiles.filter((f) => shouldSkipFile(f.file)).map((f) => f.file);
  const reviewable = allFiles.filter((f) => !shouldSkipFile(f.file));
  const { batches: allBatches, truncatedFiles } = packBatches(reviewable, diffBudgetChars);
  const batches = allBatches.slice(0, MAX_BATCHES);
  const unreviewedFiles = allBatches
    .slice(MAX_BATCHES)
    .flat()
    .map((f) => f.file);
  const notes: ReviewNotes = { skippedFiles, truncatedFiles, unreviewedFiles };
  if (batches.length === 0) {
    host.warn('nothing reviewable in this PR (only lockfiles/generated files changed).');
    return { status: 'skipped' };
  }

  const maxTokens = Math.max(opts.maxTokens ?? 0, MIN_MAX_TOKENS);
  const readOnlyTools = opts.tools.filter((t) => t.permission === 'read' && t.name !== 'ask_user');

  // ------- Phase 1: per-batch structured review -------
  const candidates: Finding[] = [];
  const batchSummaries: string[] = [];
  const rawTexts: string[] = [];
  for (let b = 0; b < batches.length; b++) {
    if (signal.aborted) return { status: 'cancelled' };
    const batch = batches[b]!;
    const batchDiff = batch.map((f) => f.content).join('\n');
    host.progress(batches.length > 1 ? `reviewing files (batch ${b + 1}/${batches.length})…` : 'reviewing the diff…');
    let nudgedEmpty = false;
    let result: { value: { summary: string; findings: Finding[] } } | { rawText: string };
    try {
      result = await runToolLoop({
        provider: opts.provider,
        model: opts.model,
        messages: [{ role: 'user', content: buildBatchPrompt(pr, b, batches.length, batch, batchDiff) }],
        terminal: REPORT_FINDINGS_TOOL,
        accept: (args) => {
          const findings = parseFindings((args as { findings?: unknown }).findings);
          const summary = typeof args.summary === 'string' ? args.summary : '';
          // A large batch reported spotless on the first try is far more
          // often satisficing than a genuinely clean diff (live incident:
          // an empty findings array posted as a near-empty review) — push
          // back exactly once before believing it.
          if (findings.length === 0 && batchDiff.length > NUDGE_EMPTY_MIN_CHARS && !nudgedEmpty) {
            nudgedEmpty = true;
            return {
              ok: false,
              feedback:
                'Empty findings on a diff this size is rarely right. Go back through each hunk — edge cases, error paths, ' +
                'concurrency, resource cleanup, tests that assert too little — and list each real issue individually. ' +
                'If after that you still find nothing, call report_findings again with an empty array and a summary ' +
                'explaining what you checked.',
            };
          }
          return { ok: true, value: { summary, findings } };
        },
        tools: readOnlyTools,
        executor: opts.executor,
        temperature: opts.temperature,
        maxTokens,
        maxIterations: deep ? MAX_TOOL_ITERATIONS_DEEP : MAX_TOOL_ITERATIONS_FAST,
        signal,
        host,
        label: `batch ${b + 1}/${batches.length}`,
      });
    } catch (err) {
      if (signal.aborted) return { status: 'cancelled' };
      host.error(`review failed — ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'skipped' };
    }
    if ('value' in result) {
      candidates.push(...result.value.findings);
      if (result.value.summary.trim()) batchSummaries.push(result.value.summary.trim());
    } else if (result.rawText.trim()) {
      rawTexts.push(result.rawText.trim());
    }
  }

  // Model never produced structured output at all — degrade to a plain
  // comment rather than failing outright.
  if (candidates.length === 0 && batchSummaries.length === 0) {
    const text = rawTexts.join('\n\n---\n\n').trim();
    if (!text) {
      host.warn('the model returned an empty review.');
      return { status: 'skipped' };
    }
    const preview =
      `# Review of PR #${pr.number}: ${pr.title}\n${pr.url}\n\n` +
      "(The model didn't use structured output — showing its plain-text response as-is.)\n\n---\n\n" +
      text;
    const ok = await host.confirm({ pr, preview, findingCount: 0, inlineCount: 0, plainText: true });
    if (!ok) return { status: 'cancelled' };
    const plainRes = await runGh(
      ['pr', 'comment', String(pr.number), '--body-file', '-'],
      cwd,
      `${aiDisclosure(client)}\n\n---\n\n${text}`,
    );
    if (plainRes.code !== 0) {
      host.error(`failed to post the comment — ${plainRes.stderr.trim() || 'unknown error'}`);
      return { status: 'skipped' };
    }
    return { status: 'posted', pr };
  }

  // ------- Phase 2: independent verification pass (deep mode only) -------
  let kept: Finding[] = candidates;
  let rejected: RejectedFinding[] = [];
  let overallSummary: string | undefined;
  if (!deep) {
    notes.singlePass = true;
  }
  if (deep && candidates.length > 0) {
    if (signal.aborted) return { status: 'cancelled' };
    host.progress(`verifying ${candidates.length} finding(s)…`);
    try {
      const verifyResult = await runToolLoop({
        provider: opts.provider,
        model: opts.model,
        messages: [{ role: 'user', content: buildVerifyPrompt(pr, candidates) }],
        terminal: REPORT_VERDICTS_TOOL,
        accept: (args) => {
          const parsed = parseVerdicts(args);
          if (parsed.verdicts.length === 0) {
            return { ok: false, feedback: 'Empty verdicts array — give exactly one verdict per candidate finding index.' };
          }
          return { ok: true, value: parsed };
        },
        tools: readOnlyTools,
        executor: opts.executor,
        temperature: opts.temperature,
        maxTokens,
        maxIterations: MAX_TOOL_ITERATIONS_DEEP,
        signal,
        host,
        label: 'verify',
      });
      if ('value' in verifyResult) {
        const applied = applyVerdicts(candidates, verifyResult.value.verdicts);
        kept = applied.kept;
        rejected = applied.rejected;
        overallSummary = verifyResult.value.overallSummary;
      } else {
        // Verification never cooperated — keep everything, honestly
        // labeled as unadjudicated rather than silently "confirmed",
        // and say so in the preview, the warning, and the posted body
        // (a log line alone proved invisible in a live run: an
        // unverified review went out looking fully vetted).
        host.log('[pr-review] verification pass returned no structured verdicts — findings kept as plausible.');
        kept = candidates.map((f) => ({ ...f, verdict: 'plausible' as const }));
        notes.verificationSkipped = true;
      }
    } catch (err) {
      if (signal.aborted) return { status: 'cancelled' };
      host.log(`[pr-review] verification pass failed (${err instanceof Error ? err.message : String(err)}) — findings kept as plausible.`);
      kept = candidates.map((f) => ({ ...f, verdict: 'plausible' as const }));
      notes.verificationSkipped = true;
    }
    if (notes.verificationSkipped) {
      host.warn(
        'the verification pass did not complete — findings are unadjudicated first-pass output. Read the preview extra carefully before posting.',
      );
    }
  }

  // Batch summaries are a fallback when there's no verifier
  // overall_summary (fast mode always; deep mode when verification
  // failed) — cap at a sentence boundary so a multi-batch concatenation
  // neither dominates the posted review nor ends mid-word.
  const summary = (overallSummary ?? capAtSentence(batchSummaries.join(' '), 1_200)).trim() || 'Automated review of this PR.';
  const sorted = sortFindings(kept);

  if (sorted.length === 0) {
    host.warn(
      rejected.length > 0
        ? `all ${rejected.length} candidate finding(s) were rejected by the verification pass — review the preview before posting a findings-free review.`
        : 'the review found no findings — check the preview before posting.',
    );
  }

  const inlineCount = sorted.filter((f) => isAnchorable(diffRanges, f.file, f.line)).length;
  const ok = await host.confirm({
    pr,
    preview: formatPreviewMarkdown(pr, summary, sorted, diffRanges, rejected, notes, client),
    findingCount: sorted.length,
    inlineCount,
    plainText: false,
  });
  if (!ok) return { status: 'cancelled' };

  const postRes = await postStructuredReview(cwd, pr, summary, sorted, diffRanges, notes, client);
  if (postRes.code === 0) return { status: 'posted', pr };

  // GitHub's review API is all-or-nothing: one inline comment on a line it
  // doesn't consider part of the diff 422s the entire submission, losing a
  // review that cost minutes of model time. Anchoring is a heuristic over
  // parsed hunk ranges with model-supplied (and verifier-corrected) line
  // numbers, so this will happen eventually — retry once with everything in
  // the body, which needs no anchors and cannot be rejected the same way.
  if (inlineCount > 0) {
    host.log(`[pr-review] inline post failed (${postRes.stderr.trim() || 'unknown error'}) — retrying without inline comments.`);
    host.warn('GitHub rejected the line-anchored comments — reposting with every finding in the review body instead.');
    const retry = await postStructuredReview(cwd, pr, summary, sorted, diffRanges, notes, client, false);
    if (retry.code === 0) return { status: 'posted', pr };
    host.error(`failed to post the review — ${retry.stderr.trim() || 'unknown error'}`);
    return { status: 'skipped' };
  }

  host.error(`failed to post the review — ${postRes.stderr.trim() || 'unknown error'}`);
  return { status: 'skipped' };
}
