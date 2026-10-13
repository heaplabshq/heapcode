import type { RecordedEvent } from '@heapcode/page/recording';
import type { DomTree } from '@heapcode/page/tree';
import { LADDER, type Locator, type Strategy } from './flow.js';

/**
 * The one seam between Heap QA and a browser engine.
 *
 * Everything above it — running flows, healing, reports — talks only to this,
 * so it can be tested against a fake and so a second engine (Maestro, for
 * mobile) is a new implementation rather than a rewrite. `@heapcode/qa-playwright`
 * is the web one.
 */
export interface Driver {
  /** Navigate and wait for the page to load. */
  open(url: string): Promise<PageInfo>;
  /** Where the page is now. */
  current(): PageInfo;
  /** The complete DOM — see `@heapcode/page`'s `inspect`. */
  inspect(): Promise<DomTree>;
  /** How many elements one strategy finds. Counts only; does not wait. */
  count(probe: Probe): Promise<number>;
  click(target: Target): Promise<void>;
  type(target: Target, text: string, options: { clear: boolean }): Promise<void>;
  select(target: Target, option: string): Promise<void>;
  /** A key into the focused element, or into `target` when given. */
  press(key: string, target?: Target): Promise<void>;
  textOf(target: Target): Promise<string>;
  isVisible(target: Target): Promise<boolean>;
  /** PNG bytes of the viewport. */
  screenshot(): Promise<Uint8Array>;
  /** Console messages and failed requests since the last call — each call drains. */
  drainConsole(): ConsoleLine[];
  drainFailedRequests(): FailedRequest[];
  close(): Promise<void>;
  /**
   * Optional: record a trace of the flow (Playwright's trace viewer). `stop`
   * with a path keeps it there; without one, throws it away — a passing run's
   * trace is not worth the disk.
   */
  startTrace?(): Promise<void>;
  stopTrace?(path: string | undefined): Promise<void>;
  /**
   * Optional: watch a person use the page (call before `open`). Resolves to a
   * function that stops watching.
   */
  record?(listener: RecordListener): Promise<() => Promise<void>>;
}

export interface RecordListener {
  /** An action in the page. Returns the total steps so far, for the page's toolbar. */
  event(event: RecordedEvent): number;
  /** The main page went to a new address. */
  navigated(url: string): void;
  /** The person closed the browser window. */
  closed(): void;
}

export interface PageInfo {
  url: string;
  title: string;
}

/** A locator reduced to one strategy — what `Driver.count` answers about. */
export type Probe =
  | { strategy: 'testId'; testId: string }
  | { strategy: 'role'; role: string; name?: string }
  | { strategy: 'label'; label: string }
  | { strategy: 'placeholder'; placeholder: string }
  | { strategy: 'text'; text: string }
  | { strategy: 'css'; css: string };

/** One element to act on: the nth match of a probe, or a node picked from an inspection (healing). */
export type Target = { probe: Probe; index: number } | { nodeId: number };

export interface ConsoleLine {
  level: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
}

export interface FailedRequest {
  url: string;
  method: string;
  /** HTTP status, or undefined when the request never got a response. */
  status?: number;
  error?: string;
}

/** The probes a locator offers, in ladder order. */
export function probesOf(locator: Locator): Probe[] {
  const probes: Probe[] = [];
  for (const strategy of LADDER) {
    const probe = probeFor(strategy, locator);
    if (probe) probes.push(probe);
  }
  return probes;
}

function probeFor(strategy: Strategy, l: Locator): Probe | undefined {
  switch (strategy) {
    case 'testId':
      return l.testId === undefined ? undefined : { strategy, testId: l.testId };
    case 'role':
      return l.role === undefined ? undefined : { strategy, role: l.role, ...(l.name !== undefined ? { name: l.name } : {}) };
    case 'label':
      return l.label === undefined ? undefined : { strategy, label: l.label };
    case 'placeholder':
      return l.placeholder === undefined ? undefined : { strategy, placeholder: l.placeholder };
    case 'text':
      return l.text === undefined ? undefined : { strategy, text: l.text };
    case 'css':
      return l.css === undefined ? undefined : { strategy, css: l.css };
  }
}

export interface Attempt {
  strategy: Strategy;
  count: number;
}

export type Located =
  | { found: true; target: Target; strategy: Strategy; attempts: Attempt[] }
  | { found: false; attempts: Attempt[] };

/**
 * Find a locator's element: the first strategy that finds exactly one wins.
 *
 * A strategy that finds several is skipped, not trusted — clicking "the first
 * Save" when there are two is how a test passes while testing the wrong thing.
 * Only when *every* strategy is ambiguous does `nth` decide, and only if the
 * flow says so.
 *
 * `attempts` is the evidence for the report and for healing: which strategies
 * found nothing (the element changed) and which found too much (the page did).
 */
export async function locate(driver: Driver, locator: Locator): Promise<Located> {
  const attempts: Attempt[] = [];
  let firstAmbiguous: { probe: Probe; count: number } | undefined;
  for (const probe of probesOf(locator)) {
    const count = await driver.count(probe);
    attempts.push({ strategy: probe.strategy, count });
    if (count === 1) return { found: true, target: { probe, index: 0 }, strategy: probe.strategy, attempts };
    if (count > 1 && !firstAmbiguous) firstAmbiguous = { probe, count };
  }
  if (firstAmbiguous && locator.nth !== undefined && locator.nth < firstAmbiguous.count) {
    return {
      found: true,
      target: { probe: firstAmbiguous.probe, index: locator.nth },
      strategy: firstAmbiguous.probe.strategy,
      attempts,
    };
  }
  return { found: false, attempts };
}

/** "testId found 0, role found 2" — for errors and reports. */
export function describeAttempts(attempts: Attempt[]): string {
  return attempts.map((a) => `${a.strategy} found ${a.count}`).join(', ');
}
