import { describe, expect, it } from 'vitest';
import { Templates, TemplateError, parseEnvFile } from '../src/template.js';
import { isAllowedTarget } from '../src/targets.js';
import { describeAttempts, locate, probesOf } from '../src/driver.js';
import { FakeDriver } from './fakeDriver.js';

describe('Templates', () => {
  const make = () =>
    new Templates({
      inputs: { email: 'qa+{{runId}}@x.test', who: '{{email}}' },
      secret: (name) => (name === 'PW' ? 'hunter2' : undefined),
      env: { BASE: 'http://localhost:3000' },
      runId: 'r1',
    });

  it('fills inputs, nested inputs, env with defaults and the run id', () => {
    const t = make();
    expect(t.fill('{{who}}').value).toBe('qa+r1@x.test');
    expect(t.fill('${BASE}/a').value).toBe('http://localhost:3000/a');
    expect(t.fill('${MISSING:-http://localhost:1}').value).toBe('http://localhost:1');
  });

  it('never shows a secret, and scrubs it from text read back', () => {
    const t = make();
    const filled = t.fill('pw={{secret:PW}}');
    expect(filled).toEqual({ value: 'pw=hunter2', shown: 'pw=«secret:PW»' });
    expect(t.redact('error: wrong password hunter2')).toBe('error: wrong password «secret:PW»');
    // …including inside an address a form submitted it to.
    const spaced = new Templates({ inputs: {}, secret: () => 'a b&c', env: {}, runId: 'r' });
    spaced.fill('{{secret:S}}');
    expect(spaced.redact('/x?pw=a%20b%26c and /y?pw=a+b%26c')).toBe('/x?pw=«secret:S» and /y?pw=«secret:S»');
  });

  it('explains what is missing', () => {
    const t = make();
    expect(() => t.fill('{{secret:NOPE}}')).toThrow(TemplateError);
    expect(() => t.fill('{{nope}}')).toThrow(/not an input of this flow/);
    expect(() => t.fill('${MISSING}')).toThrow(/not set in the environment/);
  });

  it('reads .env files', () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\n\nbad line\nC=\'x\'')).toEqual({ A: '1', B: 'two words', C: 'x' });
  });
});

describe('isAllowedTarget', () => {
  it('allows local addresses and listed ones only', () => {
    expect(isAllowedTarget('http://localhost:5173/x', [])).toBe(true);
    expect(isAllowedTarget('http://app.test/', [])).toBe(true);
    expect(isAllowedTarget('https://staging.example.com/a', [])).toBe(false);
    expect(isAllowedTarget('https://staging.example.com/a', ['https://staging.example.com'])).toBe(true);
    expect(isAllowedTarget('http://staging.example.com/a', ['https://staging.example.com'])).toBe(false);
    expect(isAllowedTarget('https://pr-12.vercel.app/', ['https://*.vercel.app'])).toBe(true);
    expect(isAllowedTarget('https://vercel.app/', ['https://*.vercel.app'])).toBe(false);
    expect(isAllowedTarget('https://staging.example.com:8443/', ['https://staging.example.com'])).toBe(false);
  });
});

describe('locate', () => {
  it('uses the first strategy that finds exactly one', async () => {
    const driver = new FakeDriver([
      { role: 'button', name: 'Save', text: 'Save' },
      { role: 'button', name: 'Save', text: 'Save', testId: 'save-2' },
    ]);
    const found = await locate(driver, { testId: 'save-2', role: 'button', name: 'Save' });
    expect(found).toMatchObject({ found: true, strategy: 'testId' });
  });

  it('skips strategies that find several, and falls through a renamed test id', async () => {
    const driver = new FakeDriver([{ role: 'button', name: 'Save', label: 'Save form' }, { role: 'button', name: 'Save' }]);
    const found = await locate(driver, { testId: 'gone', role: 'button', name: 'Save', label: 'Save form' });
    expect(found).toMatchObject({ found: true, strategy: 'label' });
    expect(describeAttempts(found.attempts)).toBe('testId found 0, role found 2, label found 1');
  });

  it('uses nth only when everything is ambiguous and the flow asks for it', async () => {
    const driver = new FakeDriver([{ text: 'Add' }, { text: 'Add' }]);
    expect((await locate(driver, { text: 'Add' })).found).toBe(false);
    const nth = await locate(driver, { text: 'Add', nth: 1 });
    expect(nth).toMatchObject({ found: true, target: { index: 1 } });
  });

  it('orders probes most stable first', () => {
    expect(probesOf({ css: '.x', text: 't', testId: 'i' }).map((p) => p.strategy)).toEqual(['testId', 'text', 'css']);
  });
});
