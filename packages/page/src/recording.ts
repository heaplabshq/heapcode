import type { Fingerprint } from './fingerprint.js';

// What the in-page recorder sends to Node. DOM-free, so Heap QA's Node side
// reads these types without browser typings. Mirrors `@heapcode/qa`'s Locator
// (this package must not depend on it): the field names are the contract.

export interface RecordedLocator {
  testId?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  css?: string;
  nth?: number;
}

export interface RecordedTarget {
  locator: RecordedLocator;
  fingerprint?: Fingerprint;
  /** How a person would name it: "the Log in button", "the Email field". */
  describe: string;
  /** For a form field: what to call the value typed into it (label, name, placeholder). */
  field?: string;
}

export type RecordedEvent =
  | { kind: 'click'; target: RecordedTarget }
  | { kind: 'fill'; target: RecordedTarget; value: string; sensitive: boolean }
  | { kind: 'select'; target: RecordedTarget; option: string }
  | { kind: 'press'; key: string; target?: RecordedTarget }
  | { kind: 'expect-visible'; target: RecordedTarget }
  | { kind: 'expect-text'; target: RecordedTarget; text: string }
  | { kind: 'done' };

/**
 * Where events go. May answer with the total number of steps recorded so far
 * (across pages), which the toolbar shows — the page alone only knows its own.
 */
export type Sink = (event: RecordedEvent) => unknown;
