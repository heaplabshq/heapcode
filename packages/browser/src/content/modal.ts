/**
 * When a dialog is open, it is the only thing on the page.
 *
 * Everything behind a modal is inert: the browser blocks clicks on it, and a
 * page that implements its own overlay blocks them with the overlay. Listing
 * those controls anyway gives the model a menu of things that cannot be clicked,
 * mixed in with the ones that can and indistinguishable from them. The observed
 * result was an agent fighting LinkedIn's filter panel, clicking background
 * controls, and reporting that the panel "seems to have closed" -- which it may
 * well have done, since a click on the backdrop is how modals are dismissed.
 *
 * Scoping to the dialog also fixes the budget: a snapshot that spends most of
 * its allowance describing the page underneath has little left for the twenty
 * controls that actually matter.
 */

const MODAL_SELECTOR = 'dialog[open],[role="dialog"][aria-modal="true"],[aria-modal="true"]';

function hasSize(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  // jsdom reports zeroes for everything; treat "no layout at all" as unknown
  // rather than as absent, the same way visibility does.
  const noLayout = rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0;
  return noLayout || (rect.width > 40 && rect.height > 40);
}

function isDisplayed(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return true;
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * The open modal dialog, if there is one.
 *
 * The innermost wins: a dialog opened from within a dialog is the one the user
 * is looking at. Hidden dialogs are ignored, because sites routinely leave
 * closed modal markup in the DOM.
 */
export function openModal(doc: Document): Element | undefined {
  const candidates = [...doc.querySelectorAll(MODAL_SELECTOR)].filter(
    (element) =>
      element.getAttribute('aria-hidden') !== 'true' && isDisplayed(element) && hasSize(element),
  );
  if (candidates.length === 0) return undefined;

  // Innermost: the last one that contains no other candidate.
  return (
    candidates.find((element) => !candidates.some((other) => other !== element && element.contains(other))) ??
    candidates[candidates.length - 1]
  );
}
