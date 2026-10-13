import type { Flow, Locator, Step } from './flow.js';
import type { SavedFingerprints } from './record.js';

/**
 * Reusable steps: teaching one from part of a flow, and recognising one when
 * a flow repeats it.
 *
 * Teaching moves steps `from`–`to` into `steps/<name>.yaml` and puts a single
 * `use:` in their place. Any flow input those steps typed becomes an input of
 * the new step, with the flow's value as its default, and the `use:` passes
 * the flow's own input through — so the flow behaves exactly as before.
 *
 * Recognising is the same in reverse: a run of steps that does what a known
 * step does (the same actions on the same elements) can become a `use:` of
 * it, with whatever the run typed passed in as that step's inputs.
 */

export interface Extracted {
  /** The new reusable step. */
  step: Flow;
  stepFingerprints: SavedFingerprints;
  /** The flow, with the range replaced by one `use:`. */
  flow: Flow;
  flowFingerprints: SavedFingerprints;
}

const INPUT_REF = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

/** Flow inputs (not secrets, not runId) a step refers to, in order of appearance. */
export function inputsUsed(steps: Step[]): string[] {
  const out: string[] = [];
  const add = (text: string | undefined): void => {
    if (!text) return;
    for (const m of text.matchAll(INPUT_REF)) if (m[1] !== 'runId' && !out.includes(m[1]!)) out.push(m[1]!);
  };
  for (const step of steps) {
    switch (step.kind) {
      case 'goto':
        add(step.url);
        break;
      case 'type':
        add(step.text);
        break;
      case 'select':
        add(step.option);
        break;
      case 'use':
        for (const v of Object.values(step.inputs)) add(v);
        break;
      case 'expect':
        if (step.expect.kind === 'text') {
          add(step.expect.equals);
          add(step.expect.contains);
        } else if (step.expect.kind === 'url') {
          add(step.expect.equals);
          add(step.expect.contains);
        }
        break;
    }
  }
  return out;
}

/** Steps `from`–`to` (1-based, inclusive) of `flow` → a reusable step called `name`, stored as `id`. */
export function extractSteps(flow: Flow, fingerprints: SavedFingerprints | undefined, from: number, to: number, id: string, name: string): Extracted {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > flow.steps.length || from > to) {
    throw new Error(`Steps ${from}–${to} are not in this flow — it has ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}.`);
  }
  const taken = flow.steps.slice(from - 1, to);
  const names = inputsUsed(taken);
  const inputs = Object.fromEntries(names.map((n) => [n, flow.inputs[n] ?? '']));
  const step: Flow = { name, inputs, steps: taken.map(stripSource) };
  const use: Step = { kind: 'use', use: id, inputs: Object.fromEntries(names.map((n) => [n, `{{${n}}}`])), intent: name };

  const steps = [...flow.steps.slice(0, from - 1), use, ...flow.steps.slice(to)];
  return {
    step,
    stepFingerprints: { version: 1, steps: (fingerprints?.steps ?? []).filter((f) => f.step >= from && f.step <= to).map((f) => ({ ...f, step: f.step - from + 1 })) },
    flow: { ...flow, steps },
    flowFingerprints: { version: 1, steps: shift(fingerprints, [{ from, to }]) },
  };
}

export interface UseMatch {
  /** 1-based, inclusive. */
  from: number;
  to: number;
  /** The reusable step's name (file name). */
  use: string;
  /** What to pass it, so it types what the matched steps typed. */
  inputs: Record<string, string>;
  /** Secrets the step types under another name than the matched steps did: [ours, the step's]. */
  secrets: [string, string][];
}

/**
 * Runs of `steps` that do what a reusable step does. Longest steps first,
 * never overlapping, at least two steps long — one step "matching" a
 * one-step reusable step is not worth a `use:`.
 */
export function findUses(steps: Step[], library: Map<string, Flow>, flowInputs: Record<string, string> = {}): UseMatch[] {
  const candidates = [...library].filter(([, s]) => s.steps.length >= 2).sort((a, b) => b[1].steps.length - a[1].steps.length);
  const claimed = new Set<number>();
  const matches: UseMatch[] = [];
  for (const [name, reusable] of candidates) {
    const n = reusable.steps.length;
    for (let i = 0; i + n <= steps.length; i += 1) {
      if (Array.from({ length: n }, (_, k) => i + k).some((k) => claimed.has(k))) continue;
      const bound = matchRun(steps.slice(i, i + n), reusable, flowInputs);
      if (!bound) continue;
      for (let k = i; k < i + n; k += 1) claimed.add(k);
      matches.push({ from: i + 1, to: i + n, use: name, ...bound });
      i += n - 1;
    }
  }
  return matches.sort((a, b) => a.from - b.from);
}

/** Replace each match with a `use:`; fingerprints follow their steps. */
export function applyUses(flow: Flow, fingerprints: SavedFingerprints | undefined, matches: UseMatch[]): { flow: Flow; fingerprints: SavedFingerprints } {
  const ordered = [...matches].sort((a, b) => a.from - b.from);
  const steps: Step[] = [];
  let next = 1;
  for (const m of ordered) {
    steps.push(...flow.steps.slice(next - 1, m.from - 1));
    steps.push({ kind: 'use', use: m.use, inputs: m.inputs, intent: m.use.replace(/-/g, ' ') });
    next = m.to + 1;
  }
  steps.push(...flow.steps.slice(next - 1));
  const used = new Set(inputsUsed(steps));
  const inputs = Object.fromEntries(Object.entries(flow.inputs).filter(([k]) => used.has(k)));
  return { flow: { ...flow, inputs, steps }, fingerprints: { version: 1, steps: shift(fingerprints, ordered) } };
}

/**
 * Whether `run` does what `reusable` does, and if so, the inputs that make it
 * type the same things. Undefined when it does not match.
 */
function matchRun(run: Step[], reusable: Flow, flowInputs: Record<string, string>): { inputs: Record<string, string>; secrets: [string, string][] } | undefined {
  const inputs: Record<string, string> = {};
  const secrets: [string, string][] = [];
  for (let k = 0; k < run.length; k += 1) {
    const a = run[k]!;
    const b = reusable.steps[k]!;
    if (a.kind !== b.kind) return undefined;
    switch (a.kind) {
      case 'goto':
        if (a.url !== (b as typeof a).url) return undefined;
        break;
      case 'click':
        if (!sameElement(a.target, (b as typeof a).target)) return undefined;
        break;
      case 'select':
        if (!sameElement(a.target, (b as typeof a).target)) return undefined;
        if (!bindValue(a.option, (b as typeof a).option, inputs, flowInputs, secrets)) return undefined;
        break;
      case 'press': {
        const pb = b as typeof a;
        if (a.key !== pb.key) return undefined;
        if (Boolean(a.target) !== Boolean(pb.target) || (a.target && !sameElement(a.target, pb.target!))) return undefined;
        break;
      }
      case 'type':
        if (!sameElement(a.target, (b as typeof a).target)) return undefined;
        if (!bindValue(a.text, (b as typeof a).text, inputs, flowInputs, secrets)) return undefined;
        break;
      case 'expect': {
        const eb = (b as typeof a).expect;
        if (a.expect.kind !== eb.kind) return undefined;
        if ('target' in a.expect && 'target' in eb && !sameElement(a.expect.target, eb.target)) return undefined;
        break;
      }
      case 'wait':
        break;
      case 'use':
        if (a.use !== (b as typeof a).use) return undefined;
        break;
    }
  }
  // Inputs the step has but the run never set keep the step's defaults.
  return { inputs, secrets };
}

/**
 * Bind what the run typed (`ours`) to what the reusable step types (`theirs`).
 * `{{x}}` in the step takes our value; a secret matches any secret (the step
 * names its own); a literal must be what we typed.
 */
function bindValue(ours: string, theirs: string, inputs: Record<string, string>, flowInputs: Record<string, string>, secrets: [string, string][]): boolean {
  const param = /^\{\{\s*([A-Za-z_]\w*)\s*\}\}$/.exec(theirs);
  if (param && param[1] !== 'runId') {
    const prior = inputs[param[1]!];
    if (prior !== undefined && prior !== ours) return false;
    inputs[param[1]!] = ours;
    return true;
  }
  const secretName = (s: string): string | undefined => /^\{\{\s*secret:\s*([^}\s]+)\s*\}\}$/.exec(s)?.[1];
  const theirSecret = secretName(theirs);
  if (theirSecret) {
    const ourSecret = secretName(ours);
    if (!ourSecret) return false;
    if (ourSecret !== theirSecret) secrets.push([ourSecret, theirSecret]);
    return true;
  }
  const resolved = ours.replace(INPUT_REF, (m, n: string) => flowInputs[n] ?? m);
  return resolved === theirs;
}

/** Two locators name the same element when any strategy they share agrees. */
export function sameElement(a: Locator, b: Locator): boolean {
  if (a.testId !== undefined && a.testId === b.testId) return true;
  if (a.role !== undefined && a.role === b.role && a.name === b.name && (a.nth ?? 0) === (b.nth ?? 0)) return true;
  for (const key of ['label', 'placeholder', 'text', 'css'] as const) {
    if (a[key] !== undefined && a[key] === b[key]) return true;
  }
  return false;
}

/** Fingerprint entries outside the replaced ranges, renumbered; inside ones are dropped (the `use:` has none). */
function shift(fingerprints: SavedFingerprints | undefined, ranges: { from: number; to: number }[]): SavedFingerprints['steps'] {
  const out: SavedFingerprints['steps'] = [];
  for (const f of fingerprints?.steps ?? []) {
    if (ranges.some((r) => f.step >= r.from && f.step <= r.to)) continue;
    const removedBefore = ranges.filter((r) => r.to < f.step).reduce((n, r) => n + (r.to - r.from), 0);
    out.push({ ...f, step: f.step - removedBefore });
  }
  return out;
}

function stripSource(step: Step): Step {
  const { line: _line, file: _file, ...rest } = step;
  return rest as Step;
}

/** "2-4", "2..4", "3" → [from, to]. */
export function parseRange(text: string): [number, number] | undefined {
  const m = /^(\d+)(?:\s*(?:-|\.\.|–)\s*(\d+))?$/.exec(text.trim());
  if (!m) return undefined;
  const from = Number(m[1]);
  return [from, m[2] === undefined ? from : Number(m[2])];
}
