import { isVisible } from './visibility.js';
import type { PageHealth } from './tree.js';

export type { PageHealth } from './tree.js';

/**
 * What is plainly wrong with a page, read in the page — for Heap QA's
 * explorer, which has no script saying what the page *should* show.
 *
 * Only signals that are wrong on any page: a stack trace or framework error
 * screen in the visible text, a value the code forgot to format (`undefined`,
 * `NaN`, `[object Object]` standing alone), and content wider than the
 * window. Validation messages ("Email is required") are not here on purpose:
 * a form refusing bad input is the form working.
 */
const ERROR_SCREENS =
  /\b(Traceback \(most recent call last\)|Internal Server Error|Unhandled (Runtime )?Error|Application error: a client-side exception|Something went wrong|Uncaught (Type|Reference|Syntax)Error|[A-Z][a-zA-Z]*Exception:|at [\w.$<>]+ \([^)]*:\d+:\d+\)|Cannot read propert(y|ies) of (undefined|null)|is not a function)\b/;
const UNFORMATTED = /^(undefined|null|NaN|\[object Object\]|Invalid Date)$/;

export function pageHealth(doc: Document): PageHealth {
  const errorTexts: string[] = [];
  const seen = new Set<string>();
  const add = (text: string): void => {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (t && !seen.has(t)) {
      seen.add(t);
      errorTexts.push(t);
    }
  };
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node && errorTexts.length < 10; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || !isVisible(parent)) continue;
    const text = node.textContent ?? '';
    if (ERROR_SCREENS.test(text)) add(text);
    // Inside code samples, `undefined` and `null` are code, not a bug.
    else if (UNFORMATTED.test(text.trim()) && !parent.closest('code, pre')) add(`"${text.trim()}" shown on the page (in ${describe(parent)})`);
  }

  const view = doc.defaultView;
  const width = view?.innerWidth ?? 0;
  const scroll = doc.documentElement.scrollWidth;
  const overflowX = width > 0 ? Math.max(0, scroll - width) : 0;
  let overflowCulprit: string | undefined;
  if (overflowX > 1) {
    let widest = 0;
    for (const el of Array.from(doc.body?.querySelectorAll('*') ?? [])) {
      const right = el.getBoundingClientRect().right;
      if (right > width + 1 && right > widest && isVisible(el)) {
        widest = right;
        overflowCulprit = describe(el);
      }
    }
  }
  return { errorTexts, overflowX: overflowX > 1 ? overflowX : 0, ...(overflowCulprit ? { overflowCulprit } : {}) };
}

function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  return `<${el.tagName.toLowerCase()}${id}${cls}>`;
}

/**
 * Counting what the page does after an action — DOM changes — so the
 * explorer can tell a button that did something from one that did nothing.
 * (Network requests and navigations are counted by the driver.)
 */
export class ActivityWatch {
  private observer: MutationObserver | undefined;
  mutations = 0;

  start(doc: Document): void {
    this.stop();
    this.mutations = 0;
    const MO = doc.defaultView?.MutationObserver ?? MutationObserver;
    this.observer = new MO((records) => {
      this.mutations += records.length;
    });
    this.observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  stop(): number {
    this.observer?.disconnect();
    this.observer = undefined;
    return this.mutations;
  }
}
