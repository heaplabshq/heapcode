// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { snapshotFromAxTree, type AxNode } from '../src/agent/axTree.js';
import { classifyClick, classifyPress } from '../src/agent/destructive.js';
import { mayOfferAlwaysAllow } from '../src/agent/originPolicy.js';
import { matchProfileField } from '../src/shared/profile.js';
import type { Control } from '../src/shared/snapshot.js';
import type { PageFacts } from '../src/agent/domFacts.js';

/**
 * The guarantees have to hold on whichever driver is in front.
 *
 * heapbrowse drives pages two ways -- CDP by default, the content script when
 * Chrome takes the debugger away -- and for a long while the safety layer was
 * written entirely against the second one. `submits`, `checkout` and
 * `sensitive` are markup facts with no accessibility equivalent, so the CDP
 * snapshot simply never set them, and three escalations that read those fields
 * answered "no" on every page. Nothing failed. The credential refusal, the
 * form-submit escalation and the payment-landmark escalation were all just
 * quietly absent on the path almost everybody is on.
 *
 * These tests are about the shape of that bug rather than about any one field:
 * a signal the driver could not compute must never be indistinguishable from a
 * signal that came back negative.
 */

function axNodes(): AxNode[] {
  return [
    {
      nodeId: '1',
      role: { value: 'button' },
      name: { value: 'Continue' },
      backendDOMNodeId: 100,
    },
    {
      nodeId: '2',
      role: { value: 'textbox' },
      name: { value: 'Card number' },
      backendDOMNodeId: 200,
    },
  ];
}

function build(facts?: PageFacts) {
  return snapshotFromAxTree({
    nodes: axNodes(),
    url: 'https://shop.example.com/checkout',
    title: 'Checkout',
    viewport: { width: 1000, height: 800, scrollY: 0, scrollHeight: 2000 },
    generation: 1,
    facts,
    register: (node) => node.backendDOMNodeId as number,
  });
}

describe('a CDP snapshot that could read the markup', () => {
  const facts: PageFacts = {
    for: (backendNodeId) =>
      backendNodeId === 100
        ? { submits: true, checkout: 'it sits inside "checkout", and it contains card fields' }
        : { sensitive: true, autocomplete: 'cc-number' },
    knows: () => true,
  };

  it('carries the signals the accessibility tree does not have', () => {
    const snapshot = build(facts);
    const button = snapshot.controls.find((c) => c.handle === 100)!;
    const field = snapshot.controls.find((c) => c.handle === 200)!;

    expect(button.submits).toBe(true);
    expect(button.checkout).toBeTruthy();
    expect(field.sensitive).toBe(true);
    expect(snapshot.signals).toBe('full');
  });

  it('escalates a checkout "Continue" that the wording alone would have waved through', () => {
    // The exact miss this was written for: COMMITTING does not match
    // "Continue", so on the old CDP path this was a plain write, and a
    // trusted host or auto-approve took it without asking.
    const button = build(facts).controls.find((c) => c.handle === 100)!;
    expect(classifyClick(button).permission).toBe('destructive');
  });
});

describe('a CDP snapshot that could not read the markup', () => {
  it('says so, rather than presenting the page as having nothing dangerous on it', () => {
    const snapshot = build(undefined);
    expect(snapshot.signals).toBe('partial');
  });

  it('treats an unproven button as a commit, not as a routine write', () => {
    const snapshot = build(undefined);
    const button = snapshot.controls.find((c) => c.handle === 100)!;

    expect(classifyClick(button, 'full').permission).toBe('write');
    expect(classifyClick(button, snapshot.signals).permission).toBe('destructive');
  });

  it('treats Enter as a possible submit', () => {
    expect(classifyPress('Enter', undefined, [], 'partial').permission).toBe('destructive');
  });

  it('does not offer "always allow on this site" for a verdict it could not compute', () => {
    expect(mayOfferAlwaysAllow('write', 'shop.example.com', 'full')).toBe(true);
    expect(mayOfferAlwaysAllow('write', 'shop.example.com', 'partial')).toBe(false);
  });

  it('still refuses a credential field on its name alone', () => {
    // The one signal that survives a failed markup read is what the control is
    // called, so it has to be enough on its own.
    const field = build(undefined).controls.find((c) => c.handle === 200)!;
    expect(field.sensitive).toBe(true);
  });
});

describe('saved details are never offered to a credential field', () => {
  const profile = { email: 'victim@example.com', fullName: 'A Person' };

  it('refuses on the flag', () => {
    const control: Control = {
      handle: 1, role: 'input', name: 'Email address', score: 1,
      sensitive: true, autocomplete: 'email',
    };
    expect(matchProfileField(control, profile)).toBeUndefined();
  });

  it('refuses on the name even when the flag is absent', () => {
    // A frame-reported control carries whatever flags that frame chose to send,
    // and a driver that could not read the markup sets none at all. The label
    // is checked independently for both reasons.
    const control: Control = {
      handle: 1, role: 'input', name: 'Password', score: 1,
      autocomplete: 'email',
    };
    expect(matchProfileField(control, profile)).toBeUndefined();
  });

  it('still fills an ordinary field', () => {
    const control: Control = {
      handle: 1, role: 'input', name: 'Email address', score: 1, autocomplete: 'email',
    };
    expect(matchProfileField(control, profile)).toBe('email');
  });
});

describe('a control the markup snapshot never reached', () => {
  // An out-of-process iframe is absent from `DOMSnapshot.captureSnapshot`
  // entirely, and an embedded checkout is exactly the thing that lives in one.
  // Most of the page having been read is not a reason to treat the unread part
  // as ordinary.
  const partialFacts: PageFacts = { for: () => undefined, knows: () => false };

  it('is marked as unknown rather than as unremarkable', () => {
    const button = build(partialFacts).controls.find((c) => c.handle === 100)!;
    expect(button.unknownSignals).toBe(true);
  });

  it('escalates even though the rest of the page was read fine', () => {
    const snapshot = build(partialFacts);
    const button = snapshot.controls.find((c) => c.handle === 100)!;
    expect(snapshot.signals).toBe('full');
    expect(classifyClick(button, snapshot.signals).permission).toBe('destructive');
  });

  it('does not escalate a control the snapshot did reach and found ordinary', () => {
    const known: PageFacts = { for: () => undefined, knows: () => true };
    const button = build(known).controls.find((c) => c.handle === 100)!;
    expect(button.unknownSignals).toBeUndefined();
    expect(classifyClick(button, 'full').permission).toBe('write');
  });
});
