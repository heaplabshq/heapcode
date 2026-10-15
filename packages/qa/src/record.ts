import type { Fingerprint } from '@heapcode/page/fingerprint';
import type { RecordedEvent, RecordedTarget } from '@heapcode/page/recording';
import type { Flow, Locator, Step } from './flow.js';

/**
 * Turning what a person did in the browser into a flow.
 *
 * The page sends actions (see `@heapcode/page`'s recorder); the driver adds
 * navigations. This decides what becomes a step:
 *
 * - A navigation right after a click or Enter is that click's doing, not a
 *   step of its own. One with no action before it — an address typed, Back —
 *   is a `goto`.
 * - Every typed value becomes a named input at the top of the flow
 *   (`email: qa@example.test`, typed as `{{email}}`), so the flow can be run
 *   with other data without editing its steps.
 * - A password or one-time code becomes `{{secret:NAME}}`. Its value is kept
 *   here only, for the caller to offer to put in the gitignored secrets file —
 *   never in the flow.
 * - Each step gets an intent in plain words, from the element's label. The
 *   healer needs one, and a person reading the file wants one.
 */

export interface RecordedStep {
  step: Step;
  fingerprint?: Fingerprint;
}

export interface RecordingResult {
  flow: Flow;
  fingerprints: SavedFingerprints;
  /** Secrets typed while recording, by name. Not in the flow. */
  secrets: Record<string, string>;
}

/** `flows/<id>.fingerprints.json`: each element step's element as it was recorded. */
export interface SavedFingerprints {
  version: 1;
  steps: { step: number; locator: Locator; fingerprint: Fingerprint; heals?: HealHistory[] }[];
}

/** One accepted heal of a step: when, how, and what its locator was before and after. */
export interface HealHistory {
  at: string;
  via: 'similarity' | 'agent';
  from: Locator;
  to: Locator;
}

/** A navigation this soon after an action is taken to be caused by it. */
const CAUSED_MS = 3000;

export class Recording {
  private readonly recorded: RecordedStep[] = [];
  private readonly inputs: Record<string, string> = {};
  private readonly secrets: Record<string, string> = {};
  private lastActionAt = -Infinity;
  private currentUrl: string | undefined;

  constructor(private readonly baseUrl?: string) {}

  get stepCount(): number {
    return this.recorded.length;
  }

  /** The steps so far, and the values typed so far — for spotting a known reusable step mid-recording. */
  peek(): { steps: Step[]; inputs: Record<string, string> } {
    return { steps: this.recorded.map((r) => r.step), inputs: { ...this.inputs } };
  }

  /** Where recording began. Always the first step. */
  start(url: string, at = Date.now()): Step {
    this.currentUrl = url;
    this.lastActionAt = at;
    return this.push({ kind: 'goto', url: this.relative(url), intent: `open ${this.relative(url)}` });
  }

  /**
   * Carry on from a page already open — a follow-up to an earlier task in the
   * same browser. No step for it: the earlier recording already got here.
   */
  resume(url: string, at = Date.now()): void {
    this.currentUrl = url;
    this.lastActionAt = at;
  }

  navigated(url: string, at = Date.now()): Step | undefined {
    // Before `start`, the opening load itself — already the first step.
    if (this.currentUrl === undefined) return undefined;
    if (url === this.currentUrl || url === 'about:blank') return undefined;
    this.currentUrl = url;
    if (at - this.lastActionAt < CAUSED_MS) return undefined;
    this.lastActionAt = at;
    return this.push({ kind: 'goto', url: this.relative(url), intent: `open ${this.relative(url)}` });
  }

  /** A navigation someone asked for (the AI's `goto`), recorded whatever came before it. */
  goto(url: string, at = Date.now()): Step {
    this.currentUrl = url;
    this.lastActionAt = at;
    return this.push({ kind: 'goto', url: this.relative(url), intent: `open ${this.relative(url)}` });
  }

  /** Typing a secret the run already has a name for (`{{secret:NAME}}` in the AI's text). */
  typeSecret(target: RecordedTarget, name: string, value: string): Step {
    this.secrets[name] = value;
    return this.push({ kind: 'type', target: locator(target), text: `{{secret:${name}}}`, clear: true, intent: `enter the ${(target.field ?? 'value').toLowerCase()}` }, target.fingerprint);
  }

  add(event: RecordedEvent, at = Date.now()): Step | undefined {
    switch (event.kind) {
      case 'done':
        return undefined;
      case 'click':
        this.lastActionAt = at;
        return this.push(
          { kind: 'click', target: locator(event.target), intent: `${event.target.locator.role === 'link' ? 'follow' : 'click'} ${event.target.describe}` },
          event.target.fingerprint,
        );
      case 'fill':
        return this.fill(event.target, event.value, event.sensitive);
      case 'select':
        this.lastActionAt = at;
        return this.push({ kind: 'select', target: locator(event.target), option: event.option, intent: `choose "${event.option}" in ${event.target.describe}` }, event.target.fingerprint);
      case 'press':
        this.lastActionAt = at;
        return this.push({
          kind: 'press',
          key: event.key,
          ...(event.target ? { target: locator(event.target) } : {}),
          intent: event.key === 'Enter' ? 'submit with Enter' : `press ${event.key}`,
        });
      case 'expect-visible':
        return this.push({ kind: 'expect', expect: { kind: 'visible', target: locator(event.target) } }, event.target.fingerprint);
      case 'expect-text':
        return this.push({ kind: 'expect', expect: { kind: 'text', target: locator(event.target), equals: event.text } }, event.target.fingerprint);
    }
  }

  private fill(target: RecordedTarget, value: string, sensitive: boolean): Step {
    const loc = locator(target);
    const field = target.field ?? 'value';
    // Typing into the same field again replaces what was typed, as it does on the page.
    const last = this.recorded.at(-1)?.step;
    if (last?.kind === 'type' && sameLocator(last.target, loc)) {
      this.recorded.pop();
      // Its name is free again, so the retyped value keeps the field's own name.
      const m = /^\{\{(secret:)?(\w+)\}\}$/.exec(last.text);
      if (m) delete (m[1] ? this.secrets : this.inputs)[m[2]!];
    }

    let text: string;
    if (sensitive) {
      const name = uniqueName(constName(field), (n) => n in this.secrets && this.secrets[n] !== value);
      this.secrets[name] = value;
      text = `{{secret:${name}}}`;
    } else if (value === '') {
      text = '';
    } else {
      const name = uniqueName(camelName(field), (n) => n in this.inputs && this.inputs[n] !== value);
      this.inputs[name] = value;
      text = `{{${name}}}`;
    }
    return this.push({ kind: 'type', target: loc, text, clear: true, intent: `enter the ${field.toLowerCase()}` }, target.fingerprint);
  }

  private push(step: Step, fingerprint?: Fingerprint): Step {
    this.recorded.push({ step, ...(fingerprint ? { fingerprint } : {}) });
    return step;
  }

  /** Same origin as the base URL → a path, so the flow runs against any environment. */
  private relative(url: string): string {
    if (!this.baseUrl) return url;
    try {
      const u = new URL(url);
      const b = new URL(this.baseUrl);
      if (u.origin !== b.origin) return url;
      const basePath = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`;
      const path = `${u.pathname}${u.search}${u.hash}`;
      return basePath !== '/' && path.startsWith(basePath) ? path.slice(basePath.length - 1) : path;
    } catch {
      return url;
    }
  }

  finish(name: string): RecordingResult {
    // Inputs that ended up unused (a field typed into, then retyped) are dropped.
    const used = new Set<string>();
    for (const { step } of this.recorded) if (step.kind === 'type') for (const m of step.text.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1]!);
    const inputs = Object.fromEntries(Object.entries(this.inputs).filter(([k]) => used.has(k)));
    // Text that shows a typed value is data, not a fixed part of the page: a
    // check of it follows the input, and it is no way to find an element.
    const values = Object.entries(inputs).filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
    if (values.length) for (const r of this.recorded) r.step = followInputs(r.step, values);
    const fingerprints: SavedFingerprints = { version: 1, steps: [] };
    this.recorded.forEach(({ step, fingerprint }, i) => {
      const target = stepTarget(step);
      if (fingerprint && target) fingerprints.steps.push({ step: i + 1, locator: target, fingerprint });
    });
    return { flow: { name, inputs, steps: this.recorded.map((r) => r.step) }, fingerprints, secrets: { ...this.secrets } };
  }
}

function followInputs(step: Step, values: [string, string][]): Step {
  const template = (text: string): string => values.reduce((t, [name, value]) => t.split(value).join(`{{${name}}}`), text);
  const shows = (text: string | undefined): boolean => text !== undefined && values.some(([, v]) => text.includes(v));
  const clean = (l: Locator): Locator => {
    const out = { ...l };
    if (shows(out.text)) delete out.text;
    if (shows(out.name)) {
      delete out.name;
      delete out.role;
    }
    // Never strip a locator bare: a dynamic one beats none.
    return Object.keys(out).some((k) => k !== 'nth') ? out : l;
  };
  if (step.kind !== 'expect') return 'target' in step && step.target ? ({ ...step, target: clean(step.target) } as Step) : step;
  const e = step.expect;
  if (e.kind === 'text') {
    return { ...step, expect: { ...e, target: clean(e.target), ...(e.equals !== undefined ? { equals: template(e.equals) } : {}), ...(e.contains !== undefined ? { contains: template(e.contains) } : {}) } };
  }
  return 'target' in e && e.target ? { ...step, expect: { ...e, target: clean(e.target) } as typeof e } : step;
}

function locator(target: RecordedTarget): Locator {
  return { ...target.locator };
}

export function stepTarget(step: Step): Locator | undefined {
  switch (step.kind) {
    case 'click':
    case 'type':
    case 'select':
      return step.target;
    case 'press':
      return step.target;
    case 'expect':
      return 'target' in step.expect ? step.expect.target : undefined;
    default:
      return undefined;
  }
}

/** The step with its element locator replaced (the one `stepTarget` returns). */
export function withTarget(step: Step, locator: Locator): Step {
  switch (step.kind) {
    case 'click':
    case 'type':
    case 'select':
      return { ...step, target: locator };
    case 'press':
      return step.target ? { ...step, target: locator } : step;
    case 'expect':
      return 'target' in step.expect ? { ...step, expect: { ...step.expect, target: locator } as typeof step.expect } : step;
    default:
      return step;
  }
}

function sameLocator(a: Locator, b: Locator): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function words(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
}

/** "Email address" → emailAddress */
export function camelName(field: string): string {
  const w = words(field).map((x) => x.toLowerCase());
  const name = w.map((x, i) => (i === 0 ? x : x[0]!.toUpperCase() + x.slice(1))).join('');
  return /^[a-z]/.test(name) ? name : `value${name ? `_${name}` : ''}`;
}

/** "Password" → PASSWORD, "One-time code" → ONE_TIME_CODE */
export function constName(field: string): string {
  const name = words(field).map((x) => x.toUpperCase()).join('_');
  return /^[A-Z]/.test(name) ? name : `SECRET${name ? `_${name}` : ''}`;
}

function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i += 1) if (!taken(`${base}${i}`)) return `${base}${i}`;
}

/** A file name for a flow called `name`, not clashing with `existing`. */
export function flowId(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'recording';
  return uniqueName(base, (n) => taken.has(n));
}
