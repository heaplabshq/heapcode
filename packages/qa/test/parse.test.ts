import { describe, expect, it } from 'vitest';
import { formatErrors, parseConfig, parseFlow } from '../src/parse.js';

const GOOD = `
name: sign up
baseUrl: \${BASE_URL:-http://localhost:5173}
inputs:
  email: "qa+{{runId}}@example.test"
steps:
  - goto: /signup
  - type:
      into: { testId: signup-email, role: textbox, name: Email }
      text: "{{email}}"
    intent: enter the new user's email
  - click: Create account
  - press: Enter
  - select: { in: { label: Country }, option: India }
  - expect: { visible: { role: heading, name: Welcome } }
  - expect: { url: /welcome }
  - expect: noConsoleErrors
  - use: log-out
    with: { who: "{{email}}" }
  - wait: 200
`;

describe('parseFlow', () => {
  it('reads every kind of step', () => {
    const result = parseFlow(GOOD, 'flows/signup.yaml');
    if (!result.ok) throw new Error(formatErrors(result.errors));
    const flow = result.value;
    expect(flow.name).toBe('sign up');
    expect(flow.inputs.email).toBe('qa+{{runId}}@example.test');
    expect(flow.steps.map((s) => s.kind)).toEqual(['goto', 'type', 'click', 'press', 'select', 'expect', 'expect', 'expect', 'use', 'wait']);
    expect(flow.steps[1]).toMatchObject({
      kind: 'type',
      target: { testId: 'signup-email', role: 'textbox', name: 'Email' },
      text: '{{email}}',
      clear: true,
      intent: "enter the new user's email",
      line: 8,
    });
    // A bare string finds the element by its text.
    expect(flow.steps[2]).toMatchObject({ kind: 'click', target: { text: 'Create account' } });
    expect(flow.steps[6]).toMatchObject({ kind: 'expect', expect: { kind: 'url', contains: '/welcome' } });
    expect(flow.steps[8]).toMatchObject({ kind: 'use', use: 'log-out', inputs: { who: '{{email}}' } });
  });

  it('reports every mistake with its line', () => {
    const result = parseFlow(
      ['name: broken', 'steps:', '  - clik: Save', '  - click: { rol: button }', '  - click: Save', '    type: { into: x, text: y }', '  - wait: soon'].join('\n'),
      'f.yaml',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = formatErrors(result.errors);
    expect(text).toContain('f.yaml:3: Unknown step `clik`');
    expect(text).toContain('f.yaml:4: Unknown way to find an element: `rol`');
    expect(text).toContain('f.yaml:5: One action per step');
    expect(text).toContain('f.yaml:7: wait (milliseconds) should be a number.');
  });

  it('wants a name and steps, and name only with role', () => {
    const result = parseFlow('steps:\n  - click: { name: Save }\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = formatErrors(result.errors);
    expect(text).toContain('`name` goes with `role`');
    expect(text).toContain('needs a `name`');
  });

  it('reports YAML syntax errors at their line', () => {
    const result = parseFlow('name: x\nsteps:\n  - click: [unclosed\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.line).toBeGreaterThan(0);
  });
});

describe('parseConfig', () => {
  it('defaults everything when the file is missing', () => {
    const result = parseConfig(undefined);
    expect(result).toEqual({ ok: true, value: { targets: [], browser: {}, timeout: 10_000, heal: 'ai' } });
  });

  it('reads targets and browser settings and rejects bad ones', () => {
    const good = parseConfig('baseUrl: http://localhost:3000\ntargets:\n  - https://staging.example.com\n  - https://*.vercel.app\nbrowser: { channel: chrome, headless: false }\ntimeout: 5000\n');
    expect(good).toMatchObject({ ok: true, value: { targets: ['https://staging.example.com', 'https://*.vercel.app'], browser: { channel: 'chrome', headless: false }, timeout: 5000 } });
    const bad = parseConfig('targets:\n  - staging\nbrowser: { channel: firefox }\nnope: 1\n');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });
});
