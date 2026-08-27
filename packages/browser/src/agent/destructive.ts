import type { PermissionClass } from '@heapcode/core/agent';
import type { Control } from '../shared/snapshot.js';

/**
 * How dangerous is this action, really?
 *
 * Nothing in `click(handle)` says "this was a purchase". heapcode can classify
 * by tool -- `run_command` is execute, `delete_file` is destructive -- because
 * the tool names the intent. In a browser every irreversible action arrives as
 * the same call on a different element, so the class has to be inferred from
 * what the element is (PRD section 6.2).
 *
 * The heuristic is deliberately crude and deliberately biased. A false positive
 * costs the user one extra confirmation; a false negative costs them money, an
 * order, or a deleted account. So it is tuned to over-match, and it should only
 * ever be tuned further in that direction.
 */

/**
 * Words that mean an action is about to commit something.
 *
 * Word-boundary matched, because substring matching turns "Apply filters" into
 * a purchase and "Payment history" into a payment. Both are common enough on a
 * shopping page that the resulting confirmations would train the user to click
 * through without reading -- which is the failure that makes every later
 * confirmation worthless.
 */
const COMMITTING = new RegExp(
  '\\b(' +
    [
      'buy',
      'purchase',
      'order',
      'checkout',
      'pay',
      'payment',
      'subscribe',
      'transfer',
      'send',
      'submit',
      'confirm',
      'delete',
      'remove',
      'cancel',
      'unsubscribe',
      'apply now',
      'place order',
      'sign up',
      'register',
      'book',
      'reserve',
      'bid',
      'donate',
    ].join('|') +
    ')\\b',
  'i',
);

/** Phrases that look committing but are not, checked before the list above. */
const BENIGN = /\b(apply filters?|payment (history|methods?|options?)|order (history|status|details)|delete filters?|remove filter|cancel (filter|search)|confirm(ation)? (email|number|code)?\s*(sent|received)?)\b/i;

export interface Classification {
  permission: PermissionClass;
  /** Why, in the user's words -- shown in the confirmation, not just logged. */
  reason?: string;
}

/**
 * Classify a click, in the safe direction.
 *
 * Three independent signals escalate to `destructive`: committing language in
 * the control's own name, submitting a form, and sitting inside a checkout or
 * payment landmark. Any one is enough.
 */
export function classifyClick(control: Control): Classification {
  const name = control.name ?? '';

  if (!BENIGN.test(name)) {
    const match = COMMITTING.exec(name);
    if (match) {
      return {
        permission: 'destructive',
        reason: `"${name}" looks like it commits something (matched "${match[0]}")`,
      };
    }
  }

  if (control.checkout) {
    return {
      permission: 'destructive',
      reason: `"${name}" is inside a checkout or payment area of the page`,
    };
  }

  if (control.submits) {
    return {
      permission: 'destructive',
      reason: `"${name}" submits a form, which is usually not reversible`,
    };
  }

  return { permission: 'write' };
}

/** Typing is a write, unless the field is one we refuse outright elsewhere. */
export function classifyType(control: Control): Classification {
  if (control.checkout) {
    return {
      permission: 'destructive',
      reason: `"${control.name}" is inside a checkout or payment area of the page`,
    };
  }
  return { permission: 'write' };
}

/**
 * Navigation. Same-origin is an ordinary write; leaving the site is not.
 *
 * A cross-origin navigation is how an agent following a hostile page's
 * instruction ends up somewhere the user never intended, still carrying their
 * session (PRD section 6.2).
 */
export function classifyNavigate(from: string, to: string): Classification {
  let fromOrigin: string;
  let toOrigin: string;
  try {
    fromOrigin = new URL(from).origin;
    toOrigin = new URL(to, from).origin;
  } catch {
    return { permission: 'destructive', reason: `"${to}" is not a URL that can be checked` };
  }

  if (fromOrigin !== toOrigin) {
    return { permission: 'destructive', reason: `leaves ${fromOrigin} for ${toOrigin}` };
  }
  return { permission: 'write' };
}
