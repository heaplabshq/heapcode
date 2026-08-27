import type { HandleRegistry } from './registry.js';
import { namesSensitiveField } from '../shared/sensitive.js';

/**
 * Actually doing things to the page.
 *
 * A bare `element.click()` produces an event with `isTrusted: false` and skips
 * the pointer and focus events entirely. Most sites do not care; React's
 * synthetic system, many custom components, and most anti-bot layers do, and
 * the failure is silent -- the call returns, nothing happened, and the agent
 * reports success (PRD section 7.3). So each action dispatches the sequence a
 * real interaction would produce.
 *
 * There is no retry here. When an action verifies as a no-op the loop is told
 * honestly, because retrying blindly on a page that ignored the first click is
 * how an agent orders three of something.
 */

export type ActionResult = { ok: true; note: string } | { ok: false; error: string };

/** The same rule extraction uses -- see shared/sensitive.ts for why it is shared. */
function isSensitiveField(element: Element): boolean {
  if (element instanceof HTMLInputElement && element.type === 'password') return true;
  return namesSensitiveField(
    element.getAttribute('name'),
    element.getAttribute('id'),
    element.getAttribute('autocomplete'),
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
  );
}

/** jsdom has no layout, and a page can replace the method. Neither should throw. */
function bringIntoView(element: Element): void {
  if (element instanceof HTMLElement && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  }
}

function mouseEvent(type: string, target: Element): MouseEvent {
  const rect = target.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };
  try {
    // `view` matters to pages that read it, but the constructor rejects
    // anything it does not consider a real Window -- which includes the view
    // jsdom hands back under a test runner. Fidelity where it works, a
    // functioning event everywhere else.
    return new MouseEvent(type, { ...init, view: target.ownerDocument.defaultView });
  } catch {
    return new MouseEvent(type, init);
  }
}

function pointerEvent(type: string, target: Element): Event {
  // PointerEvent is not constructible everywhere; a bubbling plain Event is a
  // closer approximation than skipping the phase altogether.
  if (typeof PointerEvent === 'function') {
    const rect = target.getBoundingClientRect();
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      isPrimary: true,
    });
  }
  return new Event(type, { bubbles: true, cancelable: true });
}

/**
 * Why an element cannot be acted on, in terms the model can act on.
 *
 * A single "could not click" tells the model nothing about what to try next, so
 * it retries the same call. Each of these implies a different next move: wait,
 * scroll, pick a different control, or give up and say so.
 */
function whyNotActionable(element: Element): string | undefined {
  if (!element.isConnected) return 'That element is no longer on the page. Read the page again.';

  const disabled =
    ('disabled' in element && (element as { disabled?: boolean }).disabled === true) ||
    element.getAttribute('aria-disabled') === 'true' ||
    element.closest('fieldset[disabled]') !== null;
  if (disabled) {
    return 'That control is disabled. Something else on the page probably has to happen first.';
  }

  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) {
    return 'That element is hidden right now. It may need something else opened first.';
  }
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return 'That element is hidden from users, so it cannot be clicked.';
  }

  const rect = element.getBoundingClientRect();
  const hasLayout = rect.width !== 0 || rect.height !== 0 || rect.top !== 0 || rect.left !== 0;
  if (hasLayout && rect.width < 1 && rect.height < 1) {
    return 'That element has no size on screen, so it cannot be clicked.';
  }
  return undefined;
}

/** The full sequence a real click produces, in order. */
export function performClick(element: Element): ActionResult {
  const blocked = whyNotActionable(element);
  if (blocked) return { ok: false, error: blocked };

  bringIntoView(element);

  element.dispatchEvent(pointerEvent('pointerover', element));
  element.dispatchEvent(mouseEvent('mouseover', element));
  element.dispatchEvent(pointerEvent('pointerdown', element));
  element.dispatchEvent(mouseEvent('mousedown', element));
  if (element instanceof HTMLElement) element.focus();
  element.dispatchEvent(pointerEvent('pointerup', element));
  element.dispatchEvent(mouseEvent('mouseup', element));

  // The real click last. `.click()` rather than a synthesized MouseEvent so
  // that default behaviour -- following a link, submitting a form -- still runs.
  if (element instanceof HTMLElement) element.click();
  else element.dispatchEvent(mouseEvent('click', element));

  return { ok: true, note: 'Dispatched a full click sequence.' };
}

/**
 * Type into a field the way a person would.
 *
 * The native value setter is used deliberately: React tracks the last value it
 * wrote and ignores an `input` event whose value it believes it already knows,
 * so assigning `element.value` directly is silently dropped on a React form.
 */
export function performType(element: Element, text: string): ActionResult {
  if (isSensitiveField(element)) {
    // Refused here, at the executor, not by asking the user -- there is no
    // answer to that question that makes it safe (PRD section 6.4).
    return {
      ok: false,
      error:
        'This is a password, one-time code, or payment field. heapbrowse never types into those. ' +
        'Ask the user to fill it themselves.',
    };
  }

  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement) &&
    element.getAttribute('contenteditable') !== 'true'
  ) {
    return { ok: false, error: 'That element is not a text field.' };
  }

  const blocked = whyNotActionable(element);
  if (blocked) return { ok: false, error: blocked };

  bringIntoView(element);
  if (element instanceof HTMLElement) element.focus();

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, text);
    else element.value = text;
  } else {
    element.textContent = text;
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  return { ok: true, note: `Typed ${text.length} characters.` };
}

export function performSelect(element: Element, option: string): ActionResult {
  if (!(element instanceof HTMLSelectElement)) {
    return { ok: false, error: 'That element is not a dropdown.' };
  }

  const wanted = option.trim().toLowerCase();
  const match =
    [...element.options].find((o) => o.text.trim().toLowerCase() === wanted) ??
    [...element.options].find((o) => o.value.trim().toLowerCase() === wanted) ??
    [...element.options].find((o) => o.text.trim().toLowerCase().includes(wanted));

  if (!match) {
    // Listing the real options is what turns a dead end into a retry that works.
    const available = [...element.options].map((o) => o.text.trim()).join(' | ');
    return { ok: false, error: `No option matching "${option}". Available: ${available}` };
  }

  element.value = match.value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, note: `Selected "${match.text.trim()}".` };
}

/**
 * Resolve a handle, or explain why it cannot be used.
 *
 * Every action goes through this. A stale handle is a hard error rather than a
 * best guess, because a list that re-rendered has different things at the same
 * indices and "close enough" means clicking the wrong product (PRD section 4.2).
 */
export function resolveTarget(
  registry: HandleRegistry,
  handle: number,
  generation: number,
): { ok: true; element: Element } | { ok: false; error: string } {
  const found = registry.resolve(handle, generation);
  if (!found.ok) return { ok: false, error: found.reason };
  return { ok: true, element: found.element };
}
