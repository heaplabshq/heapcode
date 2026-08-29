/**
 * Is this element inside a part of the page that takes money?
 *
 * A backstop behind the wording check: a button reading "Continue" means
 * something different on a payment page. But it is only a backstop, and it has
 * to be precise, because a false positive here is expensive in a way that is
 * easy to miss -- it puts a red "this cannot be undone" warning on an ordinary
 * button, and a user who sees that on LinkedIn's Apply button learns to ignore
 * the red warning everywhere else.
 *
 * The rules themselves now live in `shared/moneyRules.ts`, because the CDP
 * driver has to reach the same verdict from a flat node snapshot with no
 * elements in it. This file is the DOM walk over those rules; `agent/domFacts.ts`
 * is the other walk. Matching was token-based rather than substring-based for
 * reasons written up there, and they have not changed.
 *
 * `cart` is deliberately not a signal. Adding something to a cart is reversible
 * -- it is the checkout that is not -- and "cart" appears in far too many
 * unrelated class names to be worth its false positives.
 */

import { isPaymentField, moneySegmentOf, namedForMoney } from '../shared/moneyRules.js';

function actionTakesMoney(form: HTMLFormElement): string | undefined {
  const segment = moneySegmentOf(form.getAttribute('action'));
  return segment ? `the form posts to /${segment}` : undefined;
}

/**
 * The reason this element counts as being in a money area, or undefined.
 *
 * A name alone is not enough, and this is the second time proving it: first a
 * generated class put "cannot be undone" on LinkedIn's Apply button, then a
 * token somewhere above the Easy Apply modal did the same to "Continue to next
 * step". Class names are chosen by people who have never heard of this
 * heuristic, and `closest` searches the whole ancestor chain, so a single
 * matching word will always be findable somewhere on a large app.
 *
 * So a naming signal now needs corroboration: the same container must also
 * actually take payment -- a card field inside it, or a form posting to a money
 * endpoint. A real checkout has both by construction; a job board has neither,
 * however its wrappers happen to be named.
 *
 * Returns the reason rather than a boolean so the confirmation can say what it
 * matched. A warning that explains itself is one the user can tell us is wrong,
 * which is how both of these were caught.
 */
export function moneyContext(element: Element): string | undefined {
  let node: Element | null = element;
  while (node) {
    // A form posting to a payment endpoint stands on its own: it is a statement
    // about where the data goes, not about what someone named a div.
    if (node instanceof HTMLFormElement) {
      const reason = actionTakesMoney(node);
      if (reason) return reason;
    }

    const named = namedForMoney((attribute) => node!.getAttribute(attribute));
    if (named && takesPayment(node)) return `${named}, and it contains card fields`;

    node = node.parentElement;
  }
  return undefined;
}

/** Whether this container really takes payment, rather than merely sounding like it. */
function takesPayment(node: Element): boolean {
  for (const input of node.querySelectorAll('input')) {
    if (isPaymentField('INPUT', (attribute) => input.getAttribute(attribute))) return true;
  }
  for (const form of node.querySelectorAll('form')) {
    if (form instanceof HTMLFormElement && actionTakesMoney(form)) return true;
  }
  return node instanceof HTMLFormElement && actionTakesMoney(node) !== undefined;
}
