import type { PermissionClass } from '@heapcode/core/agent';
import type { Control, PageSnapshot } from '../shared/snapshot.js';

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

/**
 * Wording that moves through a flow rather than completing one.
 *
 * A multi-step form -- a job application, a booking, a signup -- submits the
 * form on every step just to advance, so treating a bare form-submit as
 * irreversible put a confirmation in front of every "Next". Found in real use:
 * applying for a job meant approving every page of the wizard, which is exactly
 * the fatigue that makes the confirmations at the end worthless.
 *
 * This only ever de-escalates a *bare* submit. Committing language and checkout
 * landmarks are checked first and are unaffected: "Submit application" still
 * matches `submit`, and "Continue" inside a payment area is still destructive.
 */
const CONTINUATION =
  /^(next|continue|proceed|forward|skip|back|previous|review|preview|start|begin|save)\b/i;

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
 *
 * Two of the three are markup facts, so a driver that could not read the markup
 * has them both absent -- and absent is indistinguishable from false unless
 * somebody says so. `signals` is that somebody: on `partial` every click is
 * treated as a commit, because a button that cannot be shown not to submit has
 * to be assumed to. That over-asks, which is the direction this module is
 * deliberately wrong in, and it only happens when a read genuinely failed.
 */
export function classifyClick(
  control: Control,
  signals?: PageSnapshot['signals'],
): Classification {
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
      reason: `"${name}" looks like it takes payment — ${control.checkout}`,
    };
  }

  // Matched as a prefix, not exactly: real buttons read "Continue to next step"
  // and "Save and continue", not "Continue". Safe as a prefix because committing
  // language is checked first, so "Continue to payment" has already escalated.
  if (control.submits && !CONTINUATION.test(name.trim())) {
    return {
      permission: 'destructive',
      reason: `"${name}" submits a form, which is usually not reversible`,
    };
  }

  // Deliberately without the CONTINUATION de-escalation the bare-submit rule
  // gets. That rule reads "this submits, but it is only a wizard step"; here
  // there is no "this submits" to soften, and "Continue" on a checkout page is
  // precisely the click this whole finding was about. Unproven means asked.
  if (control.unknownSignals) {
    return {
      permission: 'destructive',
      reason:
        `"${name}" is inside an embedded frame whose markup could not be read, so whether it ` +
        `submits a form or sits in a payment area is unknown`,
    };
  }

  if (signals === 'partial') {
    return {
      permission: 'destructive',
      reason:
        `the page markup could not be read, so whether "${name}" submits a form or sits in a ` +
        `payment area is unknown`,
    };
  }

  return { permission: 'write' };
}

/** Typing is a write, unless the field is one we refuse outright elsewhere. */
export function classifyType(control: Control): Classification {
  if (control.checkout) {
    return {
      permission: 'destructive',
      reason: `"${control.name}" looks like a payment field — ${control.checkout}`,
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

/**
 * Pressing a key, which can be a commit in disguise.
 *
 * Enter in a text field is a form submit on most of the web, so it inherits the
 * click classification of whatever it is submitting rather than being waved
 * through as an ordinary write. With no target given, the fallback is the page:
 * if anything on it looks like checkout, Enter there is treated as destructive.
 * That over-asks on a search box next to a payment form, which is the direction
 * this whole module is deliberately wrong in.
 */
export function classifyPress(
  key: string,
  target: Control | undefined,
  page: Control[],
  signals?: PageSnapshot['signals'],
): Classification {
  if (key !== 'Enter') return { permission: 'write' };

  // Enter is a submit on most of the web, and `submits` is exactly the field a
  // partial read does not have. Unknown is not "no".
  if (signals === 'partial') {
    return {
      permission: 'destructive',
      reason:
        'the page markup could not be read, so whether Enter submits a form here is unknown',
    };
  }

  if (target) {
    if (target.unknownSignals) {
      return {
        permission: 'destructive',
        reason:
          `"${target.name}" is inside an embedded frame whose markup could not be read, so ` +
          `whether Enter submits a form there is unknown`,
      };
    }
    if (target.checkout) {
      return {
        permission: 'destructive',
        reason: `Enter in "${target.name}" would submit a payment form — ${target.checkout}`,
      };
    }
    if (target.submits) {
      return {
        permission: 'destructive',
        reason: `Enter in "${target.name}" submits a form, which is usually not reversible`,
      };
    }
    return { permission: 'write' };
  }

  const checkout = page.find((control) => control.checkout);
  if (checkout) {
    return {
      permission: 'destructive',
      reason: `this page has a payment area (${checkout.checkout}), and Enter may submit it`,
    };
  }
  return { permission: 'write' };
}

/** The most dangerous of several classifications — how a batch is judged. */
export function worstOf(classifications: Classification[]): Classification {
  const rank = (permission: PermissionClass): number =>
    permission === 'destructive' ? 3 : permission === 'execute' ? 2 : permission === 'write' ? 1 : 0;
  return classifications.reduce<Classification>(
    (worst, candidate) => (rank(candidate.permission) > rank(worst.permission) ? candidate : worst),
    { permission: 'write' },
  );
}
