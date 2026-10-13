import { describeAttempts, locate, probesOf, type Attempt, type ConsoleLine, type Driver, type FailedRequest, type Located } from './driver.js';
import type { Expectation, Flow, Locator, Step } from './flow.js';
import type { Filled, Templates } from './template.js';

/**
 * Playing a flow back: no model, no guessing — every step does exactly what
 * the file says, waits for the page as long as the timeout allows, and stops
 * the flow at the first step that fails. What it records is the evidence a
 * report needs: which strategy found each element, what the console said and
 * which requests failed during the step, and a screenshot.
 *
 * Healing (Q5) will sit where `locate` fails; until then a missing element is
 * a failure, reported with what each strategy found.
 */

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
}

export async function runFlow(id: string, flow: Flow, options: RunOptions): Promise<FlowResult> {
  const started = Date.now();
  const steps: StepResult[] = [];
  const consoleSoFar: ConsoleLine[] = [];
  const traced = Boolean(options.driver.startTrace && options.tracePath);
  if (traced) await options.driver.startTrace!();

  const baseUrl = options.baseUrl ?? (flow.baseUrl ? options.templates.fill(flow.baseUrl).value : undefined);
  const ctx: Ctx = { ...options, baseUrl, steps, consoleSoFar, failed: false };
  // Drop anything left over from a previous flow on the same page.
  options.driver.drainConsole();
  options.driver.drainFailedRequests();

  await runSteps(flow.steps, options.templates, ctx, '', 0);

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
  };
}

interface Ctx extends RunOptions {
  baseUrl: string | undefined;
  steps: StepResult[];
  consoleSoFar: ConsoleLine[];
  failed: boolean;
}

async function runSteps(list: Step[], templates: Templates, ctx: Ctx, prefix: string, depth: number): Promise<void> {
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
    await runOne(step, templates, ctx, path, depth);
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
  await runSteps(target.steps, child, ctx, `${path}.`, depth + 1);
  row.durationMs = Date.now() - started;
  if (ctx.steps.some((s) => s.path.startsWith(`${path}.`) && s.status === 'failed')) row.status = 'failed';
}

async function runOne(step: Exclude<Step, { kind: 'use' }>, templates: Templates, ctx: Ctx, path: string, depth: number): Promise<void> {
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
    await perform(step, templates, ctx, result);
  } catch (err) {
    result.status = 'failed';
    result.error = templates.redact(message(err));
    ctx.failed = true;
  }
  result.durationMs = Date.now() - started;
  result.console = ctx.driver.drainConsole().map((l) => redactLine(l, templates));
  result.failedRequests = ctx.driver.drainFailedRequests().map((r) => ({
    ...r,
    url: templates.redact(r.url),
    ...(r.error ? { error: templates.redact(r.error) } : {}),
  }));
  ctx.consoleSoFar.push(...result.console);
  if (ctx.screenshots === 'every-step' || (ctx.screenshots === 'on-failure' && result.status === 'failed')) {
    try {
      result.screenshot = await ctx.driver.screenshot();
    } catch {
      // A page that crashed cannot be photographed; the error already says why.
    }
  }
  record(ctx, result);
}

async function perform(step: Exclude<Step, { kind: 'use' }>, templates: Templates, ctx: Ctx, result: StepResult): Promise<void> {
  const { driver } = ctx;
  const find = async (locator: Locator): Promise<Extract<Located, { found: true }>> => {
    const located = await until(() => locate(driver, locator), (l) => l.found, ctx.timeout);
    result.attempts = located.attempts;
    if (!located.found) throw new Error(`Could not find ${describeLocator(locator)} (${describeAttempts(located.attempts)}).`);
    result.strategy = located.strategy;
    return located;
  };

  switch (step.kind) {
    case 'goto': {
      const url = resolveUrl(templates.fill(step.url).value, ctx.baseUrl);
      await driver.open(url);
      return;
    }
    case 'click':
      await driver.click((await find(step.target)).target);
      return;
    case 'type':
      await driver.type((await find(step.target)).target, templates.fill(step.text).value, { clear: step.clear });
      return;
    case 'select':
      await driver.select((await find(step.target)).target, templates.fill(step.option).value);
      return;
    case 'press':
      await driver.press(step.key, step.target ? (await find(step.target)).target : undefined);
      return;
    case 'wait':
      await sleep(step.ms);
      return;
    case 'expect':
      await check(step.expect, templates, ctx, result);
      return;
  }
}

async function check(expectation: Expectation, templates: Templates, ctx: Ctx, result: StepResult): Promise<void> {
  const { driver } = ctx;
  switch (expectation.kind) {
    case 'visible': {
      const ok = await until(
        async () => {
          const l = await locate(driver, expectation.target);
          result.attempts = l.attempts;
          return l.found && (await driver.isVisible(l.target));
        },
        Boolean,
        ctx.timeout,
      );
      if (!ok) throw new Error(`Expected ${describeLocator(expectation.target)} to be visible, but it ${result.attempts?.some((a) => a.count > 0) ? 'is hidden or ambiguous' : 'is not on the page'} (${describeAttempts(result.attempts ?? [])}).`);
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
      const ok = await until(
        async () => {
          const l = await locate(driver, expectation.target);
          result.attempts = l.attempts;
          if (!l.found) return false;
          last = await driver.textOf(l.target);
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
