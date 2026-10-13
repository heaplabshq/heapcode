import { accessibleName } from './accessibleName.js';
import { fingerprintOf } from './fingerprint.js';
import { inspect } from './inspect.js';
import { roleOf } from './role.js';
import { TEST_ID_ATTRS } from './tree.js';
import type { RecordedEvent, RecordedLocator, RecordedTarget, Sink } from './recording.js';

export type { RecordedEvent, RecordedLocator, RecordedTarget, Sink } from './recording.js';

/**
 * Watching a person use the page, for Heap QA's recorder. Runs in the page.
 *
 * Every action is sent out with *every* way of finding its element again — a
 * test id, role and name, label, placeholder, visible text, a CSS path — and
 * a fingerprint of the element as it is now. Replay tries them most-stable
 * first and healing falls back on the fingerprint, so a recording made today
 * survives tomorrow's renamed id.
 *
 * The event types are in `recording.ts`, DOM-free, for the Node side.
 */

const ACTIONABLE =
  'button, a[href], input, textarea, select, summary, label, [role="button"], [role="link"], [role="checkbox"], ' +
  '[role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [contenteditable="true"]';

const TEXT_INPUT_TYPES = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', '']);

/** What a click on `el` was a click on: the button around the icon, not the icon. */
export function actionableTarget(el: Element): Element {
  return el.closest(ACTIONABLE) ?? el;
}

export function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  return TEXT_INPUT_TYPES.has(((el as HTMLInputElement).getAttribute('type') ?? '').toLowerCase());
}

export function isSensitive(el: Element): boolean {
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  return type === 'password' || autocomplete === 'current-password' || autocomplete === 'new-password' || autocomplete === 'one-time-code';
}

/** Every way to find `el` again, with ambiguous ones narrowed by `nth` where that is all there is. */
export function describeTarget(el: Element, withFingerprint = true): RecordedTarget {
  const doc = el.ownerDocument;
  const locator: RecordedLocator = {};
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) {
      locator.testId = v;
      break;
    }
  }
  const role = roleOf(el);
  const name = accessibleName(el);
  if (role && name && name.length <= 80) {
    locator.role = role;
    locator.name = name;
  }
  const field = isField(el);
  if (field) {
    const label = labelText(el);
    if (label) locator.label = label;
    const placeholder = el.getAttribute('placeholder')?.trim();
    if (placeholder) locator.placeholder = placeholder;
  } else {
    const text = visibleText(el);
    if (text && text.length <= 60) locator.text = text;
  }
  const css = cssPath(el);
  if (css) locator.css = css;

  // When nothing finds it uniquely, remember which of the role+name matches it
  // was — replay uses `nth` only once every strategy turns out ambiguous.
  if (!locator.testId && locator.role && !uniqueEnough(el, locator, doc)) {
    const same = Array.from(doc.querySelectorAll('*')).filter((e) => roleOf(e) === locator.role && accessibleName(e) === locator.name);
    if (same.length > 1) locator.nth = same.indexOf(el);
  }

  const target: RecordedTarget = { locator, describe: describe(el, role, name, field) };
  if (field) target.field = locator.label ?? el.getAttribute('name') ?? locator.placeholder ?? 'value';
  if (withFingerprint) {
    const elements: Element[] = [];
    const tree = inspect(doc, {}, elements);
    const id = elements.indexOf(el);
    if (id >= 0) target.fingerprint = fingerprintOf(tree, id);
  }
  return target;
}

/** The text a person sees — `innerText` where there is layout, `textContent` where there is not (jsdom). */
function visibleText(el: Element): string {
  const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

function isField(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function labelText(el: Element): string | undefined {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const labels = (el as HTMLInputElement).labels;
  const label = labels && labels.length ? labels[0] : el.closest('label');
  const text = label?.textContent?.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function uniqueEnough(el: Element, l: RecordedLocator, doc: Document): boolean {
  if (l.label !== undefined || l.placeholder !== undefined) return true;
  if (l.css && doc.querySelectorAll(l.css).length === 1) return true;
  if (l.text !== undefined) {
    const same = Array.from(doc.querySelectorAll(ACTIONABLE)).filter((e) => visibleText(e) === l.text);
    if (same.length === 1 && same[0] === el) return true;
  }
  return false;
}

/** Ids that look generated — React's `:r1:`, hashes, long numbers — change between builds. */
export function isStableId(id: string): boolean {
  return !/^:|\d{4,}|[a-f0-9]{8,}|^(ember|react|radix|headlessui|mui)[-_]/i.test(id);
}

/** A short CSS path: the id if it is stable and unique, else tag and position under the nearest one. */
export function cssPath(el: Element): string | undefined {
  const doc = el.ownerDocument;
  const esc = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 5; depth += 1) {
    const id = node.getAttribute('id');
    if (id && isStableId(id) && doc.querySelectorAll(`#${esc(id)}`).length === 1) {
      parts.unshift(`#${esc(id)}`);
      return parts.join(' > ');
    }
    const tag = node.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') break;
    const parent: Element | null = node.parentElement;
    const sameTag = parent ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName) : [];
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
    node = parent;
  }
  return parts.length ? parts.join(' > ') : undefined;
}

function describe(el: Element, role: string | undefined, name: string, field: boolean): string {
  const short = name.length > 40 ? `${name.slice(0, 40)}…` : name;
  if (field) return `the ${labelText(el) ?? el.getAttribute('name') ?? el.getAttribute('placeholder') ?? 'input'} field`;
  if (role === 'link') return `the "${short}" link`;
  if (role === 'button') return `the "${short}" button`;
  if (role && short) return `the "${short}" ${role}`;
  return short ? `"${short}"` : `the ${el.tagName.toLowerCase()}`;
}

/**
 * Listen to the document and send what the person does to `sink`.
 *
 * Typing is sent once per field, as its final value — when the field changes,
 * when Enter is pressed in it, when something else is clicked, or when the
 * page is left — not keystroke by keystroke. Clicks into text fields and on
 * `<select>`s are not steps (typing and choosing are). A click on a `<label>`
 * is skipped because the browser sends a second click to its control, and
 * that one is the step.
 */
export class Recorder {
  private pending: HTMLInputElement | HTMLTextAreaElement | undefined;
  private readonly sent = new WeakMap<Element, string>();
  private mode: 'act' | 'expect-visible' | 'expect-text' = 'act';
  private readonly listeners: [string, EventListener][] = [];
  private toolbar: Toolbar | undefined;
  private count = 0;

  constructor(
    private readonly doc: Document,
    private readonly sink: Sink,
  ) {}

  start(options: { toolbar?: boolean } = {}): void {
    const on = (type: string, fn: (e: Event) => void): void => {
      this.doc.addEventListener(type, fn, true);
      this.listeners.push([type, fn]);
    };
    on('click', (e) => this.onClick(e as MouseEvent));
    on('input', (e) => this.onInput(e));
    on('change', (e) => this.onChange(e));
    on('keydown', (e) => this.onKey(e as KeyboardEvent));
    this.doc.defaultView?.addEventListener('pagehide', () => this.flush());
    if (options.toolbar) {
      this.toolbar = new Toolbar(this.doc, {
        onMode: (mode) => {
          this.mode = mode;
        },
        onDone: () => {
          this.flush();
          this.emit({ kind: 'done' });
        },
      });
    }
  }

  stop(): void {
    for (const [type, fn] of this.listeners) this.doc.removeEventListener(type, fn, true);
    this.listeners.length = 0;
    this.toolbar?.remove();
  }

  /** Steps sent from this page so far — shown on the toolbar. */
  get steps(): number {
    return this.count;
  }

  private emit(event: RecordedEvent): void {
    if (event.kind !== 'done') this.count += 1;
    this.toolbar?.setCount(this.count);
    void Promise.resolve(this.sink(event)).then(
      (total) => {
        if (typeof total === 'number') this.toolbar?.setCount(total);
      },
      () => {},
    );
  }

  /** Show a total that includes earlier pages' steps. */
  setTotal(total: number): void {
    this.count = total;
    this.toolbar?.setCount(total);
  }

  private ours(e: Event): boolean {
    return this.toolbar?.contains(e) ?? false;
  }

  private onClick(e: MouseEvent): void {
    if (this.ours(e) || !(e.target instanceof Element)) return;
    const el = actionableTarget(e.target);
    if (this.mode !== 'act') {
      this.flush();
      e.preventDefault();
      e.stopPropagation();
      const target = describeTarget(el);
      if (this.mode === 'expect-visible') this.emit({ kind: 'expect-visible', target });
      else this.emit({ kind: 'expect-text', target, text: visibleText(el) });
      this.mode = 'act';
      this.toolbar?.setMode('act');
      return;
    }
    if (el !== this.pending) this.flush();
    if (isTextField(el) || el.tagName.toLowerCase() === 'select') return;
    // The browser follows a label click with a click on its control.
    if (el.tagName.toLowerCase() === 'label' && (el as HTMLLabelElement).control) return;
    this.emit({ kind: 'click', target: describeTarget(el) });
  }

  private onInput(e: Event): void {
    if (this.ours(e) || !(e.target instanceof Element)) return;
    if (isTextField(e.target)) this.pending = e.target;
  }

  private onChange(e: Event): void {
    if (this.ours(e) || !(e.target instanceof Element)) return;
    const el = e.target;
    if (isTextField(el)) {
      this.pending = el;
      this.flush();
    } else if (el.tagName.toLowerCase() === 'select') {
      // Whatever was being typed elsewhere happened first.
      this.flush();
      const select = el as HTMLSelectElement;
      const option = select.selectedOptions[0];
      this.emit({ kind: 'select', target: describeTarget(el), option: option?.textContent?.trim() || select.value });
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (this.ours(e) || !(e.target instanceof Element)) return;
    if (e.key === 'Escape' && this.mode !== 'act') {
      this.mode = 'act';
      this.toolbar?.setMode('act');
      return;
    }
    if (e.key === 'Enter' && isTextField(e.target) && e.target.tagName.toLowerCase() !== 'textarea') {
      this.pending = e.target;
      this.flush();
      this.emit({ kind: 'press', key: 'Enter', target: describeTarget(e.target, false) });
    } else if (e.key === 'Escape') {
      this.flush();
      this.emit({ kind: 'press', key: 'Escape' });
    }
  }

  /** Send the field being typed into, if its value changed since it was last sent. */
  flush(): void {
    const el = this.pending;
    this.pending = undefined;
    if (!el || !el.isConnected) return;
    if (this.sent.get(el) === el.value) return;
    this.sent.set(el, el.value);
    this.emit({ kind: 'fill', target: describeTarget(el), value: el.value, sensitive: isSensitive(el) });
  }
}

/**
 * The recorder's controls, drawn on the page in a closed shadow root so the
 * page's styles cannot reach in and its scripts cannot read it.
 */
class Toolbar {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly countEl: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();

  constructor(
    doc: Document,
    private readonly handlers: { onMode: (mode: 'act' | 'expect-visible' | 'expect-text') => void; onDone: () => void },
  ) {
    this.host = doc.createElement('heapqa-recorder');
    this.host.setAttribute('style', 'all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;');
    this.root = this.host.attachShadow({ mode: 'closed' });
    this.root.innerHTML = `<style>
      .bar { font: 13px/1.2 system-ui, sans-serif; display: flex; gap: 6px; align-items: center; padding: 8px 10px;
        background: #1b1b1f; color: #f4f4f5; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
      button { font: inherit; color: inherit; background: #2e2e33; border: 1px solid #45454c; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
      button.on { background: #2563eb; border-color: #2563eb; }
      .done { background: #16a34a; border-color: #16a34a; }
    </style>
    <div class="bar" role="toolbar" aria-label="Heap QA recorder">
      <span class="dot"></span><span class="count">Recording · 0 steps</span>
      <button data-mode="expect-visible" title="Click an element to check it is visible">Check visible</button>
      <button data-mode="expect-text" title="Click an element to check its text">Check text</button>
      <button class="done" title="Stop and save the flow">Done</button>
    </div>`;
    this.countEl = this.root.querySelector('.count') as HTMLElement;
    for (const b of Array.from(this.root.querySelectorAll('button[data-mode]'))) {
      const button = b as HTMLButtonElement;
      const mode = button.dataset.mode as 'expect-visible' | 'expect-text';
      this.buttons.set(mode, button);
      button.addEventListener('click', () => {
        const next = button.classList.contains('on') ? 'act' : mode;
        this.setMode(next);
        handlers.onMode(next);
      });
    }
    (this.root.querySelector('.done') as HTMLButtonElement).addEventListener('click', () => handlers.onDone());
    (doc.body ?? doc.documentElement).appendChild(this.host);
  }

  contains(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }

  setMode(mode: 'act' | 'expect-visible' | 'expect-text'): void {
    for (const [m, b] of this.buttons) b.classList.toggle('on', m === mode);
  }

  setCount(n: number): void {
    this.countEl.textContent = `Recording · ${n} step${n === 1 ? '' : 's'}`;
  }

  remove(): void {
    this.host.remove();
  }
}
