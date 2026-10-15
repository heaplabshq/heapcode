import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import { serializeFlow } from '../src/serialize.js';
import type { Flow } from '../src/flow.js';

const strip = (f: Flow): unknown => JSON.parse(JSON.stringify(f, (k, v) => (k === 'line' || k === 'file' ? undefined : v)));

describe('serializeFlow', () => {
  const flow: Flow = {
    name: 'sign up',
    inputs: { email: 'qa+{{runId}}@example.test' },
    steps: [
      { kind: 'goto', url: '/signup', intent: 'open the sign-up page' },
      { kind: 'type', target: { testId: 'email', role: 'textbox', name: 'Email', label: 'Email' }, text: '{{email}}', clear: true, intent: 'enter the email' },
      { kind: 'type', target: { label: 'Password' }, text: '{{secret:PASSWORD}}', clear: false },
      { kind: 'select', target: { label: 'Country' }, option: 'India' },
      { kind: 'click', target: { text: 'Create account' } },
      { kind: 'press', key: 'Enter' },
      { kind: 'press', key: 'Tab', target: { css: '#x' } },
      { kind: 'use', use: 'log-out', inputs: { who: '{{email}}' } },
      { kind: 'wait', ms: 200 },
      { kind: 'expect', expect: { kind: 'visible', target: { role: 'heading', name: 'Welcome: friend' } } },
      { kind: 'expect', expect: { kind: 'text', target: { css: '#who' }, contains: '{{email}}' } },
      { kind: 'expect', expect: { kind: 'url', contains: '/welcome' } },
      { kind: 'expect', expect: { kind: 'url', matches: '^https?://' } },
      { kind: 'expect', expect: { kind: 'count', target: { text: 'Item', nth: 1 }, equals: 3 } },
      { kind: 'expect', expect: { kind: 'noConsoleErrors' } },
    ],
  };

  it('round-trips through the parser', () => {
    const text = serializeFlow(flow);
    const parsed = parseFlow(text);
    if (!parsed.ok) throw new Error(`${text}\n${JSON.stringify(parsed.errors)}`);
    expect(strip(parsed.value)).toEqual(strip(flow));
  });

  it('reads like a hand-written file', () => {
    expect(serializeFlow(flow)).toBe(`name: sign up
inputs:
  email: qa+{{runId}}@example.test
steps:
  - goto: /signup
    intent: open the sign-up page
  - type: { into: { testId: email, role: textbox, name: Email, label: Email }, text: "{{email}}" }
    intent: enter the email
  - type: { into: { label: Password }, text: "{{secret:PASSWORD}}", clear: false }
  - select: { in: { label: Country }, option: India }
  - click: Create account
  - press: Enter
  - press: { key: Tab, on: { css: "#x" } }
  - use: log-out
    with: { who: "{{email}}" }
  - wait: 200
  - expect: { visible: { role: heading, name: "Welcome: friend" } }
  - expect: { text: { in: { css: "#who" }, contains: "{{email}}" } }
  - expect: { url: /welcome }
  - expect: { url: { matches: ^https?:// } }
  - expect: { count: { of: { text: Item, nth: 1 }, equals: 3 } }
  - expect: noConsoleErrors
`);
  });
});
