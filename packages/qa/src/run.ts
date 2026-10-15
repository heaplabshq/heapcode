import type { Fingerprint } from '@heapcode/page/fingerprint';
import { formatOutline } from '@heapcode/page/outline';
import type { DomTree } from '@heapcode/page/tree';
import { describeAttempts, locate, probesOf, type Attempt, type ConsoleLine, type Driver, type FailedRequest, type Target } from './driver.js';
import type { Expectation, Flow, Locator, Step } from './flow.js';
import type { HealOutcome, Healer } from './heal.js';
import type { SavedFingerprints } from './record.js';
import type { Filled, Templates } from './template.js';
import { join } from 'node:path';
import { checkSnapshot } from './visual.js';

/**
 * Playing a flow back: no model, no guessing — every step does exactly what
 * the file says, waits for the page as long as the timeout allows, and stops
 * the flow at the first step that fails. What it records is the evidence a
 * report needs: which strategy found each element, what the console said and
 * which requests failed during the step, and a screenshot.
 *
 * When every strategy of a step's locator fails, a `Healer` (if given) looks
 * for the element again — see heal.ts. A healed step carries on with the
 * element found and records a *proposal* for the new locator; the flow file
 * is never changed by a run. A passing run also refreshes each element's
 * fingerprint, so healing compares against the app as it last worked.
 */

/** Which file a step came from: the flow itself, or a reusable step it used. */
export interface StepSource {
  kind: 'flow' | 'step';
  id: string;
}

/** A healed step's new locator, for a person to accept into the file. */
export interface HealProposal {
  source: StepSource;
  /** 1-based position of the step in its file. */
  step: number;
  /** Where in this run: "3", "2.4". */
  path: string;
  previous: Locator;
  locator: Locator;
  fingerprint?: Fingerprint;
  via: 'similarity' | 'agent';
  score?: number;
  reason?: string;
}

/** An element as it looked in a passing run, to save as its fingerprint. */
export interface FingerprintRefresh {
  source: StepSource;
  step: number;
  locator: Locator;
  fingerprint: Fingerprint;
}

export type StepStatus = 'passed' | 'failed' | 'skipped';

export interface StepResult {
  /** Position, nested for reusable steps: "3", "4.2". */
  path: string;
  depth: number;
  kind: Step['kind'];
  /** What the step did, in words, with secrets shown as «secret:NAME». */
  label: string;
  intent?: string;
  status: StepStatus;
  durationMs: number;
  file?: string;
  line?: number;
  /** Which strategy found the element, when the step had one. */
  strategy?: string;
  /** Found by healing, not by its locator. */
  healed?: { via: 'similarity' | 'agent'; score?: number; reason?: string; locator: Locator };
  /** Healing looked and decided the element is gone — a bug in the app, not drift. */
  bug?: boolean;
  /** The page when the step failed: its address and outline (secrets redacted). */
  page?: { url: string; outline: string };
  /** A screenshot check's outcome; `diff` is a PNG of what changed. */
  visual?: { name: string; status: 'created' | 'updated' | 'matched' | 'differs'; diffPercent: number; diff?: Uint8Array };
  attempts?: Attempt[];
  error?: string;
  console: ConsoleLine[];
  failedRequests: FailedRequest[];
  /** PNG, when screenshots are on. The caller decides where it goes. */
  screenshot?: Uint8Array;
}

export interface FlowResult {
  /** File name without extension. */
  id: string;
  name: string;
  file?: string;
  status: 'passed' | 'failed';
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  /** The first failure, in one line. */
  error?: string;
  /** Path of the saved trace, when the flow failed and the driver can trace. */
  trace?: string;
  /** Locators healing found, proposed for the files. */
  heals: HealProposal[];
  /** Fingerprints from this run — worth saving only if it passed. */
  refreshed: FingerprintRefresh[];
  /** The whole page at the failing step, secrets redacted — for the report and for "fix this". */
  failurePage?: DomTree;
  /** Filled in after the run by a model, when one is asked: a guess at why it failed. */
  diagnosis?: Diagnosis;
}

export interface Diagnosis {
  /** Where the fault most likely is. */
  kind: 'app' | 'test' | 'environment' | 'unknown';
  /** Two or three sentences — a guess, and labelled as one wherever it is shown. */
  text: string;
  model: string;
}

export interface RunOptions {
  driver: Driver;
  /** Reusable steps, by name — `Workspace.steps`. */
  library: Map<string, Flow>;
  templates: Templates;
  /** Resolves relative `goto`s. The flow's own `baseUrl` is used when this is unset. */
  baseUrl?: string;
  /** How long a step may wait for the page, in ms. */
  timeout: number;
  screenshots: 'every-step' | 'on-failure' | 'none';
  /** Where to save a trace if the flow fails; undefined discards it. */
  tracePath?: string;
  onStep?: (result: StepResult) => void;
  /** Looks for an element whose locator stopped working. Without one, that step fails. */
  healer?: Healer;
  /** Saved fingerprints of the flow and of the reusable steps it uses. */
  fingerprints?: (source: StepSource) => SavedFingerprints | undefined;
  /** Record each element's fingerprint as the run finds it. Default false. */
  refreshFingerprints?: boolean;
  /** Read the page when a step fails, for the report. Default true. */
  captureFailure?: boolean;
  /**
   * Where screenshot checks keep their pictures (`<dir>/<flow or step>/<name>.png`),
   * and whether to replace them with what the page looks like now.
   */
  snapshots?: { dir: string; update: boolean };
}

export async function runFlow(id: string, flow: Flow, options: RunOptions): Promise<FlowResult> {
  const started = Date.now();
  const steps: StepResult[] = [];
  const consoleSoFar: ConsoleLine[] = [];
  const traced = Boolean(options.driver.startTrace && options.tracePath);
  if (traced) await options.driver.startTrace!();

  const baseUrl = options.baseUrl ?? (flow.baseUrl ? options.templates.fill(flow.baseUrl).value : undefined);
  const ctx: Ctx = { ...options, baseUrl, steps, consoleSoFar, requestsSoFar: [], failed: false, heals: [], refreshed: [] };
  // Drop anything left over from a previous flow on the same page.
  options.driver.drainConsole();
  options.driver.drainFailedRequests();

  await runSteps(flow.steps, options.templates, ctx, '', 0, { kind: 'flow', id });

  const failedStep = steps.find((s) => s.status === 'failed');
  let trace: string | undefined;
  if (traced) {
    const keep = failedStep && options.tracePath;
    await options.driver.stopTrace!(keep ? options.tracePath : undefined).catch(() => {});
    if (keep) trace = options.tracePath;
  }
  return {
    id,
    name: flow.name,
    file: flow.file,
    status: failedStep ? 'failed' : 'passed',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    steps,
    ...(failedStep ? { error: `Step ${failedStep.path} (${failedStep.label}): ${failedStep.error}` } : {}),
    ...(trace ? { trace } : {}),
    heals: ctx.heals,
    refreshed: failedStep ? [] : ctx.refreshed,
    ...(ctx.failurePage ? { failurePage: ctx.failurePage } : {}),
  };
}

interface Ctx extends RunOptions {
  baseUrl: string | undefined;
  steps: StepResult[];
  consoleSoFar: ConsoleLine[];
  requestsSoFar: FailedRequest[];
  failed: boolean;
  heals: HealProposal[];
  refreshed: FingerprintRefresh[];
  failurePage?: DomTree;
}

async function runSteps(list: Step[], templates: Templates, ctx: Ctx, prefix: string, depth: number, source: StepSource): Promise<void> {
  for (let i = 0; i < list.length; i += 1) {
    const step = list[i]!;
    const path = `${prefix}${i + 1}`;
    if (ctx.failed) {
      record(ctx, { path, depth, kind: step.kind, label: safeLabel(step, templates), status: 'skipped', durationMs: 0, ...where(step), console: [], failedRequests: [] });
      continue;
    }
    if (step.kind === 'use') {
      await runUse(step, templates, ctx, path, depth);
      continue;
    }
    await runOne(step, templates, ctx, path, depth, { source, index: i });
  }
}

async function runUse(step: Extract<Step, { kind: 'use' }>, templates: Templates, ctx: Ctx, path: string, depth: number): Promise<void> {
  const started = Date.now();
  const target = ctx.library.get(step.use);
  const base = { path, depth, kind: step.kind, label: `use ${step.use}`, ...where(step), console: [], failedRequests: [] };
  if (!target) {
    ctx.failed = true;
    record(ctx, { ...base, status: 'failed', durationMs: 0, error: `No reusable step \`${step.use}\`.` });
    return;
  }
  let child: Templates;
  try {
    // The caller's values, filled in the caller's context; the step's own
    // defaults for anything it was not given.
    const given: Record<string, Filled> = {};
    for (const [key, value] of Object.entries(step.inputs)) given[key] = templates.fill(value);
    child = templates.withInputs({ ...target.inputs, ...given });
  } catch (err) {
    ctx.failed = true;
    record(ctx, { ...base, status: 'failed', durationMs: 0, error: message(err) });
    return;
  }
  const row: StepResult = { ...base, status: 'passed', durationMs: 0, ...(step.intent ? { intent: step.intent } : {}) };
  record(ctx, row);
  await runSteps(target.steps, child, ctx, `${path}.`, depth + 1, { kind: 'step', id: step.use });
  row.durationMs = Date.now() - started;
  if (ctx.steps.some((s) => s.path.startsWith(`${path}.`) && s.status === 'failed')) row.status = 'failed';
}

interface Place {
  source: StepSource;
  /** 0-based, in its file. */
  index: number;
}

async function runOne(step: Exclude<Step, { kind: 'use' }>, templates: Templates, ctx: Ctx, path: string, depth: number, place: Place): Promise<void> {
  const started = Date.now();
  const result: StepResult = {
    path,
    depth,
    kind: step.kind,
    label: safeLabel(step, templates),
    status: 'passed',
    durationMs: 0,
    ...where(step),
    ...(step.intent ? { intent: step.intent } : {}),
    console: [],
    failedRequests: [],
  };
  try {
    await perform(step, templates, ctx, result, place);
  } catch (err) {
    result.status = 'failed';
    result.error = templates.redact(message(err));
    ctx.failed = true;
    if (ctx.captureFailure !== false) await captureFailure(ctx, result, templates);
  }
  result.durationMs = Date.now() - started;
  result.console = ctx.driver.drainConsole().map((l) => redactLine(l, templates));
  result.failedRequests = ctx.driver.drainFailedRequests().map((r) => ({
    ...r,
    url: templates.redact(r.url),
    ...(r.error ? { error: templates.redact(r.error) } : {}),
  }));
  ctx.consoleSoFar.push(...result.console);
  ctx.requestsSoFar.push(...result.failedRequests);
  if (ctx.screenshots === 'every-step' || (ctx.screenshots === 'on-failure' && result.status === 'failed')) {
    try {
      result.screenshot = await ctx.driver.screenshot();
    } catch {
      // A page that crashed cannot be photographed; the error already says why.
    }
  }
  record(ctx, result);
}

type Find = (locator: Locator, isCheck?: boolean) => Promise<Target>;

/** How long a missing element is waited for before the free similarity match is tried. */
const EARLY_HEAL_MS = 3000;

async function perform(step: Exclude<Step, { kind: 'use' }>, templates: Templates, ctx: Ctx, result: StepResult, place: Place): Promise<void> {
  const { driver } = ctx;
  /**
   * The element for `locator`: by its strategies, waiting for the page; else
   * by healing; else a failure that says what each strategy found.
   */
  const find: Find = async (locator, isCheck = false) => {
    const healRequest = (attempts: Attempt[], similarityOnly: boolean) => {
      const fingerprint = savedFingerprint(ctx, place, locator);
      return { locator, ...(step.intent ? { intent: step.intent } : {}), ...(fingerprint ? { fingerprint } : {}), attempts, isCheck, similarityOnly };
    };
    // Waiting the whole timeout for an element that was renamed makes every
    // healed step cost that timeout. So after a short wait the free
    // similarity match gets a try; only past the full timeout does a model.
    const early = Math.min(ctx.timeout, EARLY_HEAL_MS);
    let located = await until(() => locate(driver, locator), (l) => l.found, early);
    if (!located.found && ctx.healer && early < ctx.timeout) {
      const quick = await ctx.healer.heal(driver, healRequest(located.attempts, true));
      if (quick.found) return healedWith(quick, locator);
      located = await until(() => locate(driver, locator), (l) => l.found, ctx.timeout - early);
    }
    result.attempts = located.attempts;
    if (located.found) {
      result.strategy = located.strategy;
      // Before acting: a click may take the page, and the element, away.
      if (ctx.refreshFingerprints && driver.describeTarget) {
        const now = await driver.describeTarget(located.target).catch(() => undefined);
        if (now?.fingerprint) ctx.refreshed.push({ source: place.source, step: place.index + 1, locator, fingerprint: now.fingerprint });
      }
      return located.target;
    }
    const notFound = `Could not find ${describeLocator(locator)} (${describeAttempts(located.attempts)})`;
    if (!ctx.healer) throw new Error(`${notFound}.`);
    const outcome = await ctx.healer.heal(driver, healRequest(located.attempts, false));
    if (!outcome.found) {
      if (outcome.missing) {
        result.bug = true;
        throw new Error(`${notFound}, and it is not on the page any more: ${templates.redact(outcome.reason)}`);
      }
      throw new Error(`${notFound}; healing: ${templates.redact(outcome.reason)}.`);
    }
    return healedWith(outcome, locator);
  };

  function healedWith(outcome: Extract<HealOutcome, { found: true }>, locator: Locator): Target {
    const healed = {
      via: outcome.via,
      ...(outcome.score !== undefined ? { score: outcome.score } : {}),
      ...(outcome.reason ? { reason: templates.redact(outcome.reason) } : {}),
      locator: { ...outcome.target.locator },
    };
    result.healed = healed;
    ctx.heals.push({
      source: place.source,
      step: place.index + 1,
      path: result.path,
      previous: locator,
      ...healed,
      ...(outcome.target.fingerprint ? { fingerprint: outcome.target.fingerprint } : {}),
    });
    return { nodeId: outcome.nodeId };
  }

  switch (step.kind) {
    case 'goto': {
      const url = resolveUrl(templates.fill(step.url).value, ctx.baseUrl);
      await driver.open(url);
      return;
    }
    case 'click':
      await driver.click(await find(step.target));
      return;
    case 'type':
      await driver.type(await find(step.target), templates.fill(step.text).value, { clear: step.clear });
      return;
    case 'select':
      await driver.select(await find(step.target), templates.fill(step.option).value);
      return;
    case 'press':
      await driver.press(step.key, step.target ? await find(step.target) : undefined);
      return;
    case 'wait':
      await sleep(step.ms);
      return;
    case 'expect':
      await check(step.expect, templates, ctx, result, find, place);
      return;
  }
}

/** What the page looked like when the step failed: an outline for the report, the whole tree for later. */
async function captureFailure(ctx: Ctx, result: StepResult, templates: Templates): Promise<void> {
  try {
    const tree = redactTree(await ctx.driver.inspect(), templates);
    result.page = { url: tree.url, outline: formatOutline(tree, { maxChars: 4000 }) };
    ctx.failurePage = tree;
  } catch {
    // A crashed or navigating page cannot be read; the error already says what happened.
  }
}

function redactTree(tree: DomTree, templates: Templates): DomTree {
  const r = (v: string): string => templates.redact(v);
  return {
    ...tree,
    url: r(tree.url),
    nodes: tree.nodes.map((n) => ({
      ...n,
      text: r(n.text),
      attrs: Object.fromEntries(Object.entries(n.attrs).map(([k, v]) => [k, r(v)])),
      ...(n.name !== undefined ? { name: r(n.name) } : {}),
      ...(n.value !== undefined ? { value: r(n.value) } : {}),
    })),
  };
}

/** The fingerprint saved for this step — only if the file's locator is still the one it was saved for. */
function savedFingerprint(ctx: Ctx, place: Place, locator: Locator): Fingerprint | undefined {
  const saved = ctx.fingerprints?.(place.source)?.steps.find((f) => f.step === place.index + 1);
  return saved && JSON.stringify(saved.locator) === JSON.stringify(locator) ? saved.fingerprint : undefined;
}

async function check(expectation: Expectation, templates: Templates, ctx: Ctx, result: StepResult, find: Find, place: Place): Promise<void> {
  const { driver } = ctx;
  switch (expectation.kind) {
    case 'visible': {
      let target: Target;
      try {
        target = await find(expectation.target, true);
      } catch (err) {
        throw new Error(`Expected ${describeLocator(expectation.target)} to be visible, but it ${result.attempts?.some((a) => a.count > 0) ? 'is ambiguous' : 'is not on the page'} (${message(err)})`);
      }
      const ok = await until(() => driver.isVisible(target), Boolean, ctx.timeout);
      if (!ok) throw new Error(`Expected ${describeLocator(expectation.target)} to be visible, but it is hidden.`);
      return;
    }
    case 'hidden': {
      const ok = await until(
        async () => {
          const l = await locate(driver, expectation.target);
          return !l.found || !(await driver.isVisible(l.target));
        },
        Boolean,
        ctx.timeout,
      );
      if (!ok) throw new Error(`Expected ${describeLocator(expectation.target)} to be hidden, but it is still visible.`);
      return;
    }
    case 'text': {
      const want = {
        equals: expectation.equals === undefined ? undefined : templates.fill(expectation.equals),
        contains: expectation.contains === undefined ? undefined : templates.fill(expectation.contains),
      };
      let last = '';
      const target = await find(expectation.target, true);
      const ok = await until(
        async () => {
          last = await driver.textOf(target);
          return (want.equals === undefined || last === want.equals.value) && (want.contains === undefined || last.includes(want.contains.value));
        },
        Boolean,
        ctx.timeout,
      );
      if (!ok) {
        const wanted = want.equals ? `"${want.equals.shown}"` : `text containing "${want.contains!.shown}"`;
        throw new Error(`Expected ${describeLocator(expectation.target)} to show ${wanted}, but it shows "${templates.redact(last)}".`);
      }
      return;
    }
    case 'url': {
      const pattern = expectation.matches === undefined ? undefined : new RegExp(expectation.matches);
      const equals = expectation.equals === undefined ? undefined : templates.fill(expectation.equals).value;
      const contains = expectation.contains === undefined ? undefined : templates.fill(expectation.contains).value;
      const ok = await until(
        async () => {
          const url = driver.current().url;
          return (equals === undefined || url === resolveUrl(equals, ctx.baseUrl)) && (contains === undefined || url.includes(contains)) && (!pattern || pattern.test(url));
        },
        Boolean,
        ctx.timeout,
      );
      if (!ok) throw new Error(`Expected the address to ${equals ? `be ${equals}` : contains ? `contain ${contains}` : `match /${expectation.matches}/`}, but it is ${driver.current().url}.`);
      return;
    }
    case 'count': {
      const probe = probesOf(expectation.target)[0]!;
      let n = 0;
      const ok = await until(
        async () => {
          n = await driver.count(probe);
          return n === expectation.equals;
        },
        Boolean,
        ctx.timeout,
      );
      if (!ok) throw new Error(`Expected ${expectation.equals} of ${describeLocator(expectation.target)}, found ${n}.`);
      return;
    }
    case 'noConsoleErrors': {
      // Includes this step's own: a late error from the last action still counts.
      const now = ctx.driver.drainConsole().map((l) => redactLine(l, templates));
      ctx.consoleSoFar.push(...now);
      result.console.push(...now);
      const errors = ctx.consoleSoFar.filter((l) => l.level === 'error');
      if (errors.length) throw new Error(`The page logged ${errors.length} error${errors.length === 1 ? '' : 's'}: ${errors.slice(0, 3).map((e) => e.message).join(' | ')}`);
      return;
    }
    case 'screenshot': {
      if (!ctx.snapshots) throw new Error('Screenshot checks need a place to keep their pictures — run them from a test folder.');
      if (!driver.capture) throw new Error('This browser driver cannot take screenshots for checks.');
      const target = expectation.target ? await find(expectation.target, true) : undefined;
      await driver.settle?.();
      const now = await driver.capture(target);
      const outcome = checkSnapshot(join(ctx.snapshots.dir, place.source.id, `${expectation.name}.png`), now, {
        maxDiff: expectation.maxDiff ?? 1,
        update: ctx.snapshots.update,
      });
      result.visual = { name: expectation.name, status: outcome.status, diffPercent: outcome.diffPercent, ...(outcome.diff ? { diff: outcome.diff } : {}) };
      if (outcome.status === 'differs') {
        throw new Error(
          `${expectation.target ? describeLocator(expectation.target) : 'The page'} looks different from the saved "${expectation.name}" picture: ` +
            `${outcome.message ?? `${outcome.diffPercent.toFixed(2)}% of pixels changed (allowed ${expectation.maxDiff ?? 1}%)`}. ` +
            'If the change is intended, run again with --update-snapshots.',
        );
      }
      return;
    }
    case 'noServerErrors': {
      // This step's own requests too, read now.
      const now = ctx.driver.drainFailedRequests().map((r) => ({ ...r, url: templates.redact(r.url) }));
      ctx.requestsSoFar.push(...now);
      result.failedRequests.push(...now);
      const bad = ctx.requestsSoFar.filter((r) => r.status === undefined || r.status >= 500);
      if (bad.length) {
        throw new Error(`${bad.length} request${bad.length === 1 ? '' : 's'} failed: ${bad.slice(0, 3).map((r) => `${r.method} ${r.url} → ${r.status ?? r.error}`).join(' | ')}`);
      }
      return;
    }
  }
}

/** Retry until `done(value)` or the timeout; returns the last value either way. */
export async function until<T>(attempt: () => Promise<T>, done: (value: T) => boolean, timeout: number, interval = 100): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value: T;
    try {
      value = await attempt();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await sleep(interval);
      continue;
    }
    if (done(value) || Date.now() >= deadline) return value;
    await sleep(interval);
  }
}

export function resolveUrl(url: string, baseUrl: string | undefined): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (!baseUrl) throw new Error(`"${url}" is a relative address and there is no baseUrl — set one in heapqa.yaml, the flow, or with --base-url.`);
  return new URL(url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

export function describeLocator(l: Locator): string {
  if (l.role) return `${l.role}${l.name !== undefined ? ` "${l.name}"` : ''}`;
  if (l.label !== undefined) return `the field labelled "${l.label}"`;
  if (l.text !== undefined) return `"${l.text}"`;
  if (l.placeholder !== undefined) return `the field with placeholder "${l.placeholder}"`;
  if (l.testId !== undefined) return `test id "${l.testId}"`;
  return `\`${l.css}\``;
}

/**
 * The step in words. With templates, values are filled in (secrets shown as
 * «secret:NAME»); without, they are shown as written. Never throws: a label is
 * needed even for a step whose template is broken.
 */
export function stepLabel(step: Step, templates?: Templates): string {
  return safeLabel(step, templates);
}

function safeLabel(step: Step, templates: Templates | undefined): string {
  const shown = (text: string): string => {
    if (!templates) return text;
    try {
      return templates.fill(text).shown;
    } catch {
      return text;
    }
  };
  switch (step.kind) {
    case 'goto':
      return `go to ${shown(step.url)}`;
    case 'click':
      return `click ${describeLocator(step.target)}`;
    case 'type':
      return `type "${shown(step.text)}" into ${describeLocator(step.target)}`;
    case 'select':
      return `choose "${shown(step.option)}" in ${describeLocator(step.target)}`;
    case 'press':
      return `press ${step.key}${step.target ? ` on ${describeLocator(step.target)}` : ''}`;
    case 'wait':
      return `wait ${step.ms}ms`;
    case 'use':
      return `use ${step.use}`;
    case 'expect': {
      const e = step.expect;
      switch (e.kind) {
        case 'visible':
        case 'hidden':
          return `expect ${describeLocator(e.target)} ${e.kind}`;
        case 'text':
          return `expect ${describeLocator(e.target)} to show ${e.equals !== undefined ? `"${shown(e.equals)}"` : `"…${shown(e.contains!)}…"`}`;
        case 'url':
          return `expect the address ${e.equals ? `to be ${shown(e.equals)}` : e.contains ? `to contain ${shown(e.contains)}` : `to match /${e.matches}/`}`;
        case 'count':
          return `expect ${e.equals} of ${describeLocator(e.target)}`;
        case 'noConsoleErrors':
          return 'expect no console errors';
        case 'noServerErrors':
          return 'expect no server errors';
        case 'screenshot':
          return `expect ${e.target ? describeLocator(e.target) : 'the page'} to look like "${e.name}"`;
      }
    }
  }
}

function redactLine(line: ConsoleLine, templates: Templates): ConsoleLine {
  return { ...line, message: templates.redact(line.message), ...(line.source ? { source: templates.redact(line.source) } : {}) };
}

function record(ctx: Ctx, result: StepResult): void {
  ctx.steps.push(result);
  ctx.onStep?.(result);
}

function where(step: Step): { file?: string; line?: number } {
  return { ...(step.file ? { file: step.file } : {}), ...(step.line ? { line: step.line } : {}) };
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // Playwright errors carry a multi-line call log; the first line is the error.
  return text.split('\n')[0]!.replace(/^\w+Error: /, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
