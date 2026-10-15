import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import { serializeFlow } from '../src/serialize.js';
import { applyUses, extractSteps, findUses, parseRange, sameElement } from '../src/teach.js';
import type { Flow } from '../src/flow.js';
import type { SavedFingerprints } from '../src/record.js';

function flow(yaml: string): Flow {
  const r = parseFlow(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

const CHECKOUT = flow(`name: checkout
inputs:
  emailAddress: a@b.test
  item: laptop
steps:
  - goto: /login
  - type: { into: { label: Email }, text: "{{emailAddress}}" }
  - type: { into: { label: Password }, text: "{{secret:PASSWORD}}" }
  - click: { role: button, name: Log in }
  - type: { into: { label: Search }, text: "{{item}}" }
  - click: Buy
`);

const fp = (steps: number[]): SavedFingerprints => ({
  version: 1,
  steps: steps.map((step) => ({ step, locator: { css: `#s${step}` }, fingerprint: { tag: 'x', classes: [], attrs: {}, path: `p${step}` } })),
});

describe('extractSteps', () => {
  it('moves a range into a reusable step and leaves a use: that behaves the same', () => {
    const out = extractSteps(CHECKOUT, fp([2, 3, 4, 5, 6]), 1, 4, 'log-in', 'log in');
    expect(serializeFlow(out.step)).toBe(`name: log in
inputs:
  emailAddress: a@b.test
steps:
  - goto: /login
  - type: { into: { label: Email }, text: "{{emailAddress}}" }
  - type: { into: { label: Password }, text: "{{secret:PASSWORD}}" }
  - click: { role: button, name: Log in }
`);
    expect(serializeFlow(out.flow)).toBe(`name: checkout
inputs:
  emailAddress: a@b.test
  item: laptop
steps:
  - use: log-in
    with: { emailAddress: "{{emailAddress}}" }
    intent: log in
  - type: { into: { label: Search }, text: "{{item}}" }
  - click: Buy
`);
    expect(out.stepFingerprints.steps.map((s) => [s.step, s.fingerprint.path])).toEqual([[2, 'p2'], [3, 'p3'], [4, 'p4']]);
    expect(out.flowFingerprints.steps.map((s) => [s.step, s.fingerprint.path])).toEqual([[2, 'p5'], [3, 'p6']]);
  });

  it('refuses a range outside the flow', () => {
    expect(() => extractSteps(CHECKOUT, undefined, 5, 9, 'x', 'x')).toThrow(/it has 6 steps/);
    expect(() => extractSteps(CHECKOUT, undefined, 3, 2, 'x', 'x')).toThrow();
  });
});

describe('findUses / applyUses', () => {
  const library = new Map([['log-in', extractSteps(CHECKOUT, undefined, 1, 4, 'log-in', 'log in').step]]);

  it('recognises the steps of a known reusable step, binding what was typed', () => {
    const recorded = flow(`name: profile
inputs: { email: other@b.test }
steps:
  - goto: /login
  - type: { into: { label: Email, placeholder: you@x }, text: "{{email}}" }
  - type: { into: { label: Password }, text: "{{secret:PW}}" }
  - click: { testId: login, role: button, name: Log in }
  - click: Profile
`);
    const matches = findUses(recorded.steps, library, recorded.inputs);
    expect(matches).toEqual([{ from: 1, to: 4, use: 'log-in', inputs: { emailAddress: '{{email}}' }, secrets: [['PW', 'PASSWORD']] }]);
    const applied = applyUses(recorded, fp([2, 3, 4, 5]), matches);
    expect(applied.flow.steps.map((s) => s.kind)).toEqual(['use', 'click']);
    expect(applied.flow.inputs).toEqual({ email: 'other@b.test' });
    expect(applied.fingerprints.steps.map((s) => [s.step, s.fingerprint.path])).toEqual([[2, 'p5']]);
  });

  it('does not match different elements, a different order, or a hard-coded value that differs', () => {
    const wrongButton = flow('name: a\nsteps:\n  - goto: /login\n  - type: { into: { label: Email }, text: x }\n  - type: { into: { label: Password }, text: "{{secret:P}}" }\n  - click: Sign up\n');
    expect(findUses(wrongButton.steps, library)).toEqual([]);
    const literal = new Map([['go-home', flow('name: g\nsteps:\n  - goto: /\n  - type: { into: { label: Q }, text: shoes }\n')]]);
    expect(findUses(flow('name: b\nsteps:\n  - goto: /\n  - type: { into: { label: Q }, text: hats }\n').steps, literal)).toEqual([]);
    expect(findUses(flow('name: b\ninputs: { q: shoes }\nsteps:\n  - goto: /\n  - type: { into: { label: Q }, text: "{{q}}" }\n').steps, literal, { q: 'shoes' })).toHaveLength(1);
  });

  it('finds several non-overlapping uses', () => {
    const twice = flow('name: t\nsteps:\n  - goto: /login\n  - type: { into: { label: Email }, text: a }\n  - type: { into: { label: Password }, text: "{{secret:P}}" }\n  - click: { role: button, name: Log in }\n  - goto: /login\n  - type: { into: { label: Email }, text: b }\n  - type: { into: { label: Password }, text: "{{secret:P}}" }\n  - click: { role: button, name: Log in }\n');
    expect(findUses(twice.steps, library).map((m) => [m.from, m.to, m.inputs.emailAddress])).toEqual([[1, 4, 'a'], [5, 8, 'b']]);
  });
});

describe('helpers', () => {
  it('compares elements by any shared strategy', () => {
    expect(sameElement({ testId: 'a', css: '#x' }, { css: '#x' })).toBe(true);
    expect(sameElement({ role: 'button', name: 'A' }, { role: 'button', name: 'B' })).toBe(false);
  });
  it('reads step ranges', () => {
    expect(parseRange('2-4')).toEqual([2, 4]);
    expect(parseRange('3')).toEqual([3, 3]);
    expect(parseRange('2..5')).toEqual([2, 5]);
    expect(parseRange('x')).toBeUndefined();
  });
});
