import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordedTarget } from '@heapcode/page/recording';
import { Recording, camelName, constName, flowId } from '../src/record.js';
import { serializeFlow } from '../src/serialize.js';
import { parseFlow } from '../src/parse.js';
import { saveSecrets } from '../src/store.js';
import { parseEnvFile } from '../src/template.js';

const field = (label: string, extra: Partial<RecordedTarget> = {}): RecordedTarget => ({
  locator: { role: 'textbox', name: label, label },
  describe: `the ${label} field`,
  field: label,
  fingerprint: { tag: 'input', classes: [], attrs: {}, path: 'html/body[1]/input[1]', name: label },
  ...extra,
});
const button = (name: string, role = 'button'): RecordedTarget => ({
  locator: { role, name, text: name },
  describe: role === 'link' ? `the "${name}" link` : `the "${name}" button`,
  fingerprint: { tag: role === 'link' ? 'a' : 'button', classes: [], attrs: {}, path: 'html/body[1]/button[1]', name },
});

describe('Recording', () => {
  it('turns a login into a flow with inputs, a secret and intents', () => {
    const r = new Recording('http://localhost:3000');
    let t = 1000;
    r.start('http://localhost:3000/login', t);
    r.add({ kind: 'fill', target: field('Email address'), value: 'a@b.test', sensitive: false }, (t += 500));
    r.add({ kind: 'fill', target: field('Password'), value: 'hunter2', sensitive: true }, (t += 500));
    r.add({ kind: 'click', target: button('Log in') }, (t += 500));
    // Caused by the click: not a step.
    expect(r.navigated('http://localhost:3000/welcome', (t += 300))).toBeUndefined();
    r.add({ kind: 'expect-text', target: { locator: { role: 'heading', name: 'Welcome' }, describe: 'x' }, text: 'Welcome' }, (t += 5000));
    // Typed by the person, long after any action: a step.
    expect(r.navigated('http://localhost:3000/settings?tab=2', (t += 5000))).toMatchObject({ kind: 'goto', url: '/settings?tab=2' });

    const { flow, fingerprints, secrets } = r.finish('log in');
    expect(secrets).toEqual({ PASSWORD: 'hunter2' });
    expect(serializeFlow(flow)).toBe(`name: log in
inputs:
  emailAddress: a@b.test
steps:
  - goto: /login
    intent: open /login
  - type: { into: { role: textbox, name: Email address, label: Email address }, text: "{{emailAddress}}" }
    intent: enter the email address
  - type: { into: { role: textbox, name: Password, label: Password }, text: "{{secret:PASSWORD}}" }
    intent: enter the password
  - click: { role: button, name: Log in, text: Log in }
    intent: click the "Log in" button
  - expect: { text: { in: { role: heading, name: Welcome }, equals: Welcome } }
  - goto: /settings?tab=2
    intent: open /settings?tab=2
`);
    expect(JSON.stringify(flow)).not.toContain('hunter2');
    expect(parseFlow(serializeFlow(flow)).ok).toBe(true);
    expect(fingerprints.steps.map((s) => s.step)).toEqual([2, 3, 4]);
  });

  it('keeps only the last value typed into a field, and drops inputs that became unused', () => {
    const r = new Recording();
    r.start('https://shop.test/');
    r.add({ kind: 'fill', target: field('Search'), value: 'lap', sensitive: false });
    r.add({ kind: 'fill', target: field('Search'), value: 'laptop', sensitive: false });
    const { flow } = r.finish('search');
    expect(flow.steps).toHaveLength(2);
    expect(flow.inputs).toEqual({ search: 'laptop' });
    expect(flow.steps[0]).toMatchObject({ kind: 'goto', url: 'https://shop.test/' });
  });

  it('names things the way a person would read them', () => {
    expect(camelName('Email address')).toBe('emailAddress');
    expect(camelName('firstName')).toBe('firstName');
    expect(camelName('2nd line')).toBe('value_2ndLine');
    expect(constName('One-time code')).toBe('ONE_TIME_CODE');
    expect(flowId('Log in & check out!', ['log-in-check-out'])).toBe('log-in-check-out2');
  });
});

describe('saveSecrets', () => {
  it('adds new secrets without touching existing ones, quoting so they read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heapqa-sec-'));
    writeFileSync(join(dir, '.env.test'), 'PASSWORD=old');
    expect(saveSecrets(dir, { PASSWORD: 'new', TOKEN: 'a b#"c' , PIN: "it's" })).toEqual(['TOKEN', 'PIN']);
    const env = parseEnvFile(readFileSync(join(dir, '.env.test'), 'utf8'));
    expect(env).toEqual({ PASSWORD: 'old', TOKEN: 'a b#"c', PIN: "it's" });
  });
});
