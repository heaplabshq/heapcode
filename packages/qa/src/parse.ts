import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml';
import {
  DEFAULT_TIMEOUT,
  type Expectation,
  type Flow,
  type Locator,
  type QaConfig,
  type Step,
} from './flow.js';

/**
 * YAML → `Flow`, with every mistake reported at its line.
 *
 * Hand-validated rather than through a schema library: the errors are the
 * product here. A person who mistyped `clik:` needs "line 7: unknown step
 * `clik` — expected one of click, type, …", not a JSON-pointer into an
 * anonymous object. All errors are collected, not just the first, so one run
 * of the validator fixes a whole file.
 */

export interface ParseError {
  message: string;
  file?: string;
  line?: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] };

export function formatErrors(errors: ParseError[]): string {
  return errors.map((e) => `${e.file ?? ''}${e.line ? `${e.file ? ':' : 'line '}${e.line}` : ''}${e.file || e.line ? ': ' : ''}${e.message}`).join('\n');
}

const STEP_KINDS = ['goto', 'click', 'type', 'select', 'press', 'expect', 'use', 'wait'] as const;
const LOCATOR_KEYS = ['testId', 'role', 'name', 'label', 'placeholder', 'text', 'css', 'nth'] as const;
const EXPECT_KINDS = ['visible', 'hidden', 'text', 'url', 'count', 'noConsoleErrors'] as const;

class Reader {
  readonly errors: ParseError[] = [];
  constructor(
    private readonly lines: LineCounter,
    readonly file: string | undefined,
  ) {}

  line(node: Node | null | undefined): number | undefined {
    const offset = node?.range?.[0];
    return offset === undefined ? undefined : this.lines.linePos(offset).line;
  }

  fail(node: Node | null | undefined, message: string): undefined {
    this.errors.push({ message, file: this.file, line: this.line(node) });
    return undefined;
  }

  string(node: Node | null | undefined, what: string): string | undefined {
    if (isScalar(node) && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
    return this.fail(node, `${what} should be text.`);
  }

  number(node: Node | null | undefined, what: string): number | undefined {
    if (isScalar(node) && typeof node.value === 'number' && Number.isFinite(node.value)) return node.value;
    return this.fail(node, `${what} should be a number.`);
  }

  boolean(node: Node | null | undefined, what: string): boolean | undefined {
    if (isScalar(node) && typeof node.value === 'boolean') return node.value;
    return this.fail(node, `${what} should be true or false.`);
  }

  /** A map's entries as [key, value node, key node]. */
  entries(map: YAMLMap): [string, Node | null, Node | null][] {
    return map.items.map((pair) => {
      const key = pair.key as Node | null;
      return [isScalar(key) ? String(key.value) : '', pair.value as Node | null, key];
    });
  }

  strings(node: Node | null | undefined, what: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (node === undefined || node === null) return out;
    if (!isMap(node)) {
      this.fail(node, `${what} should be a list of name: value pairs.`);
      return out;
    }
    for (const [key, value] of this.entries(node)) {
      const s = this.string(value, `${what}.${key}`);
      if (s !== undefined) out[key] = s;
    }
    return out;
  }

  locator(node: Node | null | undefined, what: string): Locator | undefined {
    // Shorthand: `click: Save` means the thing that reads "Save".
    if (isScalar(node) && typeof node.value === 'string') return { text: node.value };
    if (!isMap(node)) return this.fail(node, `${what} should say which element: e.g. { role: button, name: Save } or just its text.`);
    const locator: Locator = {};
    for (const [key, value, keyNode] of this.entries(node)) {
      if (!(LOCATOR_KEYS as readonly string[]).includes(key)) {
        this.fail(keyNode, `Unknown way to find an element: \`${key}\`. Use ${LOCATOR_KEYS.join(', ')}.`);
        continue;
      }
      if (key === 'nth') {
        const n = this.number(value, `${what}.nth`);
        if (n !== undefined) locator.nth = n;
      } else {
        const s = this.string(value, `${what}.${key}`);
        if (s !== undefined) locator[key as Exclude<keyof Locator, 'nth'>] = s;
      }
    }
    if (locator.name !== undefined && locator.role === undefined) {
      this.fail(node, `${what}: \`name\` goes with \`role\` (e.g. role: button, name: Save). For plain text use \`text\`.`);
    }
    const strategies = Object.keys(locator).filter((k) => k !== 'nth' && k !== 'name');
    if (strategies.length === 0) return this.fail(node, `${what} needs at least one of testId, role, label, placeholder, text, css.`);
    return locator;
  }
}

/** Parse a flow (or a reusable step — same shape) from YAML text. */
export function parseFlow(text: string, file?: string): ParseResult<Flow> {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const r = new Reader(lines, file);
  for (const e of doc.errors) r.errors.push({ message: e.message.split('\n')[0]!, file, line: lines.linePos(e.pos[0]).line });
  if (r.errors.length) return { ok: false, errors: r.errors };

  const root = doc.contents as Node | null;
  if (!isMap(root)) return { ok: false, errors: [{ message: 'A flow should start with `name:` and `steps:`.', file, line: 1 }] };

  const flow: Flow = { name: '', inputs: {}, steps: [], file, line: 1 };
  let sawSteps = false;
  for (const [key, value, keyNode] of r.entries(root)) {
    switch (key) {
      case 'name':
        flow.name = r.string(value, 'name') ?? '';
        break;
      case 'baseUrl': {
        const s = r.string(value, 'baseUrl');
        if (s !== undefined) flow.baseUrl = s;
        break;
      }
      case 'inputs':
        flow.inputs = r.strings(value, 'inputs');
        break;
      case 'steps':
        sawSteps = true;
        if (!isSeq(value)) {
          r.fail(value ?? keyNode, '`steps` should be a list, each line starting with `- `.');
          break;
        }
        for (const item of value.items) {
          const step = parseStep(r, item as Node | null);
          if (step) flow.steps.push(step);
        }
        break;
      default:
        r.fail(keyNode, `Unknown setting \`${key}\`. A flow has name, baseUrl, inputs and steps.`);
    }
  }
  if (!flow.name) r.fail(root, 'The flow needs a `name`.');
  if (!sawSteps) r.fail(root, 'The flow needs `steps`.');
  return r.errors.length ? { ok: false, errors: r.errors } : { ok: true, value: flow };
}

function parseStep(r: Reader, node: Node | null): Step | undefined {
  // `- noConsoleErrors` style bare words are not steps; every step is a map.
  if (!isMap(node)) return r.fail(node, `Each step should be one action, e.g. \`- click: Save\`. Actions: ${STEP_KINDS.join(', ')}.`);
  const entries = r.entries(node);
  const actions = entries.filter(([key]) => (STEP_KINDS as readonly string[]).includes(key));
  const line = r.line(node);
  const file = r.file;

  for (const [key, , keyNode] of entries) {
    if (!(STEP_KINDS as readonly string[]).includes(key) && key !== 'intent' && key !== 'with') {
      r.fail(keyNode, `Unknown step \`${key}\`. Expected one of ${STEP_KINDS.join(', ')} (plus optional intent).`);
    }
  }
  if (actions.length !== 1) {
    return actions.length === 0
      ? undefined
      : r.fail(node, `One action per step — this one has ${actions.map(([k]) => k).join(' and ')}.`);
  }

  const intentNode = entries.find(([key]) => key === 'intent')?.[1];
  const intent = intentNode === undefined ? undefined : r.string(intentNode, 'intent');
  const withNode = entries.find(([key]) => key === 'with');
  const [kind, value] = actions[0]!;
  if (withNode && kind !== 'use') r.fail(withNode[2], '`with` only goes on a `use` step.');
  const base = { line, file, ...(intent !== undefined ? { intent } : {}) };

  switch (kind) {
    case 'goto': {
      const url = r.string(value, 'goto');
      return url === undefined ? undefined : { kind, url, ...base };
    }
    case 'click': {
      const target = r.locator(value, 'click');
      return target && { kind, target, ...base };
    }
    case 'type': {
      if (!isMap(value)) return r.fail(value, '`type` needs `into` (the field) and `text`.');
      const fields = Object.fromEntries(r.entries(value).map(([k, v]) => [k, v]));
      for (const [k, , kn] of r.entries(value)) if (!['into', 'text', 'clear'].includes(k)) r.fail(kn, `\`type\` takes into, text and clear — not \`${k}\`.`);
      const target = r.locator(fields.into, 'type.into');
      const text = r.string(fields.text, 'type.text');
      const clear = fields.clear === undefined ? true : r.boolean(fields.clear, 'type.clear');
      return target && text !== undefined && clear !== undefined ? { kind, target, text, clear, ...base } : undefined;
    }
    case 'select': {
      if (!isMap(value)) return r.fail(value, '`select` needs `in` (the dropdown) and `option`.');
      const fields = Object.fromEntries(r.entries(value).map(([k, v]) => [k, v]));
      const target = r.locator(fields.in, 'select.in');
      const option = r.string(fields.option, 'select.option');
      return target && option !== undefined ? { kind, target, option, ...base } : undefined;
    }
    case 'press': {
      if (isScalar(value)) {
        const key = r.string(value, 'press');
        return key === undefined ? undefined : { kind, key, ...base };
      }
      if (!isMap(value)) return r.fail(value, '`press` takes a key, e.g. `press: Enter`.');
      const fields = Object.fromEntries(r.entries(value).map(([k, v]) => [k, v]));
      const key = r.string(fields.key, 'press.key');
      const target = fields.on === undefined ? undefined : r.locator(fields.on, 'press.on');
      return key === undefined ? undefined : { kind, key, ...(target ? { target } : {}), ...base };
    }
    case 'expect': {
      const expectation = parseExpect(r, value);
      return expectation && { kind, expect: expectation, ...base };
    }
    case 'use': {
      const name = r.string(value, 'use');
      const inputs = r.strings(withNode?.[1], 'with');
      return name === undefined ? undefined : { kind, use: name, inputs, ...base };
    }
    case 'wait': {
      const ms = r.number(value, 'wait (milliseconds)');
      return ms === undefined ? undefined : { kind, ms, ...base };
    }
  }
  return undefined;
}

function parseExpect(r: Reader, node: Node | null): Expectation | undefined {
  if (isScalar(node) && node.value === 'noConsoleErrors') return { kind: 'noConsoleErrors' };
  if (!isMap(node) || node.items.length !== 1) {
    return r.fail(node, `\`expect\` takes one check: ${EXPECT_KINDS.join(', ')}.`);
  }
  const [[kind, value, keyNode]] = r.entries(node) as [[string, Node | null, Node | null]];
  switch (kind) {
    case 'visible':
    case 'hidden': {
      const target = r.locator(value, `expect.${kind}`);
      return target && { kind, target };
    }
    case 'text': {
      if (!isMap(value)) return r.fail(value, '`expect.text` needs `in` and `equals` or `contains`.');
      const f = Object.fromEntries(r.entries(value).map(([k, v]) => [k, v]));
      const target = r.locator(f.in, 'expect.text.in');
      const equals = f.equals === undefined ? undefined : r.string(f.equals, 'expect.text.equals');
      const contains = f.contains === undefined ? undefined : r.string(f.contains, 'expect.text.contains');
      if (equals === undefined && contains === undefined) return r.fail(value, '`expect.text` needs `equals` or `contains`.');
      return target && { kind, target, ...(equals !== undefined ? { equals } : {}), ...(contains !== undefined ? { contains } : {}) };
    }
    case 'url': {
      // `url: /welcome` is shorthand for "contains".
      if (isScalar(value)) {
        const contains = r.string(value, 'expect.url');
        return contains === undefined ? undefined : { kind, contains };
      }
      if (!isMap(value)) return r.fail(value, '`expect.url` takes text, or equals / contains / matches.');
      const out: Expectation & { kind: 'url' } = { kind };
      for (const [k, v, kn] of r.entries(value)) {
        if (k !== 'equals' && k !== 'contains' && k !== 'matches') {
          r.fail(kn, `\`expect.url\` takes equals, contains or matches — not \`${k}\`.`);
          continue;
        }
        const s = r.string(v, `expect.url.${k}`);
        if (s !== undefined) out[k] = s;
      }
      if (out.matches !== undefined) {
        try {
          new RegExp(out.matches);
        } catch {
          r.fail(value, `\`expect.url.matches\` is not a valid regular expression.`);
        }
      }
      return out;
    }
    case 'count': {
      if (!isMap(value)) return r.fail(value, '`expect.count` needs `of` and `equals`.');
      const f = Object.fromEntries(r.entries(value).map(([k, v]) => [k, v]));
      const target = r.locator(f.of, 'expect.count.of');
      const equals = r.number(f.equals, 'expect.count.equals');
      return target && equals !== undefined ? { kind, target, equals } : undefined;
    }
    case 'noConsoleErrors':
      return { kind };
    default:
      return r.fail(keyNode, `Unknown check \`${kind}\`. Use ${EXPECT_KINDS.join(', ')}.`);
  }
}

/** Parse `heapqa.yaml`. A missing file is fine — every setting has a default. */
export function parseConfig(text: string | undefined, file = 'heapqa.yaml'): ParseResult<QaConfig> {
  const config: QaConfig = { targets: [], browser: {}, timeout: DEFAULT_TIMEOUT };
  if (text === undefined || text.trim() === '') return { ok: true, value: config };
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const r = new Reader(lines, file);
  for (const e of doc.errors) r.errors.push({ message: e.message.split('\n')[0]!, file, line: lines.linePos(e.pos[0]).line });
  if (r.errors.length) return { ok: false, errors: r.errors };
  const root = doc.contents as Node | null;
  if (!isMap(root)) return { ok: false, errors: [{ message: 'heapqa.yaml should be a list of settings.', file, line: 1 }] };

  for (const [key, value, keyNode] of r.entries(root)) {
    switch (key) {
      case 'baseUrl': {
        const s = r.string(value, 'baseUrl');
        if (s !== undefined) config.baseUrl = s;
        break;
      }
      case 'targets':
        if (!isSeq(value)) {
          r.fail(value, '`targets` should be a list of addresses, e.g. `- https://staging.example.com`.');
          break;
        }
        for (const item of value.items) {
          const s = r.string(item as Node, 'targets');
          if (s === undefined) continue;
          if (!targetPatternValid(s)) r.fail(item as Node, `\`${s}\` is not an address like https://staging.example.com or https://*.vercel.app.`);
          else config.targets.push(s);
        }
        break;
      case 'secretsFile': {
        const s = r.string(value, 'secretsFile');
        if (s !== undefined) config.secretsFile = s;
        break;
      }
      case 'timeout': {
        const n = r.number(value, 'timeout (milliseconds)');
        if (n !== undefined) config.timeout = n;
        break;
      }
      case 'browser': {
        if (!isMap(value)) {
          r.fail(value, '`browser` takes channel and headless.');
          break;
        }
        for (const [k, v, kn] of r.entries(value)) {
          if (k === 'channel') {
            const s = r.string(v, 'browser.channel');
            if (s === 'chrome' || s === 'msedge' || s === 'chromium') config.browser.channel = s;
            else if (s !== undefined) r.fail(v, '`browser.channel` is chrome, msedge or chromium.');
          } else if (k === 'headless') {
            const b = r.boolean(v, 'browser.headless');
            if (b !== undefined) config.browser.headless = b;
          } else r.fail(kn, `\`browser\` takes channel and headless — not \`${k}\`.`);
        }
        break;
      }
      default:
        r.fail(keyNode, `Unknown setting \`${key}\`. heapqa.yaml has baseUrl, targets, secretsFile, timeout and browser.`);
    }
  }
  return r.errors.length ? { ok: false, errors: r.errors } : { ok: true, value: config };
}

function targetPatternValid(pattern: string): boolean {
  return /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?\/?$/i.test(pattern);
}
