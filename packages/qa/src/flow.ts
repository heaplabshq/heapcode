/**
 * A flow: one test, as the person reads and edits it.
 *
 * Every step that touches an element carries two things. The **locator** is
 * how replay finds it — fast, exact, no model. The **intent** is what the step
 * is *for*, in words, and is how healing finds it again when the locator stops
 * working. heapbrowse keeps only the intent, because for a shopping assistant
 * "the third result" next week is a different product; a test needs the exact
 * replay too. Keeping both is the core idea of Heap QA (see docs/QA_PLAN.md §4.3).
 */

/** Where in the YAML a thing came from, for errors a person can act on. */
export interface Source {
  file?: string;
  line?: number;
}

/**
 * How to find an element. Strategies are tried in the order of `LADDER`; the
 * first that finds exactly one element wins. A recording fills in every
 * strategy that applies, so losing one (a renamed test id) is not losing the
 * element.
 */
export interface Locator {
  testId?: string;
  role?: string;
  /** Accessible name — used with `role`. */
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  css?: string;
  /** Pick the nth match (0-based) when the rest still match several. A last resort. */
  nth?: number;
}

/** Strategies in preference order: the most stable first. */
export const LADDER = ['testId', 'role', 'label', 'placeholder', 'text', 'css'] as const;
export type Strategy = (typeof LADDER)[number];

interface StepBase extends Source {
  /** What this step is for, in words. Required for healing; recorder fills it in. */
  intent?: string;
}

export interface GotoStep extends StepBase {
  kind: 'goto';
  url: string;
}
export interface ClickStep extends StepBase {
  kind: 'click';
  target: Locator;
}
export interface TypeStep extends StepBase {
  kind: 'type';
  target: Locator;
  text: string;
  /** Replace what is in the field. Default true. */
  clear: boolean;
}
export interface SelectStep extends StepBase {
  kind: 'select';
  target: Locator;
  option: string;
}
export interface PressStep extends StepBase {
  kind: 'press';
  key: string;
  target?: Locator;
}
export interface ExpectStep extends StepBase {
  kind: 'expect';
  expect: Expectation;
}
export interface UseStep extends StepBase {
  kind: 'use';
  /** Name of a reusable step in `steps/`. */
  use: string;
  inputs: Record<string, string>;
}
export interface WaitStep extends StepBase {
  kind: 'wait';
  ms: number;
}

export type Step = GotoStep | ClickStep | TypeStep | SelectStep | PressStep | ExpectStep | UseStep | WaitStep;

export type Expectation =
  | { kind: 'visible'; target: Locator }
  | { kind: 'hidden'; target: Locator }
  | { kind: 'text'; target: Locator; equals?: string; contains?: string }
  | { kind: 'url'; equals?: string; contains?: string; matches?: string }
  | { kind: 'count'; target: Locator; equals: number }
  | { kind: 'noConsoleErrors' };

export interface Flow extends Source {
  name: string;
  /** Overrides the config's base URL. May use `${ENV}`. */
  baseUrl?: string;
  /** Values the steps refer to as `{{name}}`. For a reusable step, its parameters' defaults. */
  inputs: Record<string, string>;
  steps: Step[];
}

/** `heapqa.yaml` — the settings of the folder opened in Heap QA. */
export interface QaConfig {
  baseUrl?: string;
  /**
   * Non-local addresses the tester may drive, as origins: `https://staging.example.com`,
   * or with a leading wildcard host, `https://*.vercel.app`. Local addresses are always allowed.
   */
  targets: string[];
  /** Where `{{secret:NAME}}` values come from, besides the environment. Relative to the folder. */
  secretsFile?: string;
  browser: {
    /** `chrome` / `msedge` use the installed browser; `chromium` Playwright's own build. */
    channel?: 'chrome' | 'msedge' | 'chromium';
    headless?: boolean;
  };
  /** Per-step timeout in ms. Default 10 000. */
  timeout: number;
  /**
   * When a step's element cannot be found: `ai` (default) tries a similarity
   * match, then asks the agent model; `similarity` never calls a model; `off`
   * just fails.
   */
  heal: 'ai' | 'similarity' | 'off';
}

export const DEFAULT_TIMEOUT = 10_000;
