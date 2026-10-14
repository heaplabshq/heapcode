import { describe, expect, it } from 'vitest';
import { exportPlaywright, locator, template, EXPORT_HEADER } from '../src/exportPlaywright.js';
import { parseFlow } from '../src/parse.js';
import type { Flow } from '../src/flow.js';

const flow = (y: string): Flow => {
  const r = parseFlow(y);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
};

describe('exportPlaywright', () => {
  it('uses the most stable strategy, exact like replay', () => {
    expect(locator({ testId: 't', role: 'button', name: 'Go' })).toBe("page.getByTestId('t')");
    expect(locator({ role: 'button', name: "Don't", css: '#x' })).toBe("page.getByRole('button', { name: 'Don\\'t', exact: true })");
    expect(locator({ text: 'Add', nth: 1 })).toBe("page.getByText('Add', { exact: true }).nth(1)");
    expect(locator({ css: 'form > button' })).toBe("page.locator('form > button')");
  });

  it('turns templates into safe template literals', () => {
    expect(template('plain', 'inputs')).toBe("'plain'");
    expect(template('qa+{{runId}}@x.test', 'inputs')).toBe('`qa+${runId}@x.test`');
    expect(template('{{secret:PW}}', 'inputs')).toBe("`${process.env['PW'] ?? ''}`");
    expect(template('${HOST:-localhost}/a', 'inputs')).toBe("`${process.env['HOST'] ?? 'localhost'}/a`");
    // Backticks and ${ in literal text cannot break out of the literal.
    expect(template('a`b${1} {{who}}', 'inputs')).toBe("`a\\`b\\${1} ${inputs['who']}`");
  });

  it('writes reusable steps as helpers, checks as expects, and a header that marks the file as generated', () => {
    const lib = new Map([['log-in', flow('name: log in\ninputs: { who: nobody }\nsteps:\n  - type: { into: { label: Email }, text: "{{who}}" }\n')]]);
    const spec = exportPlaywright(
      'f',
      flow(`name: checkout
inputs: { email: a@b.test }
steps:
  - use: log-in
    with: { who: "{{email}}" }
  - press: Enter
  - expect: { text: { in: { css: "#t" }, contains: Total } }
  - expect: { url: { matches: ^.*/done$ } }
  - expect: noServerErrors
`),
      lib,
      { baseUrl: 'http://localhost:5173' },
    );
    expect(spec.startsWith(EXPORT_HEADER)).toBe(true);
    expect(spec).toContain("const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';");
    expect(spec).toContain('async function step_logIn(page: Page, given: Record<string, string> = {}): Promise<void> {');
    expect(spec).toContain("  inputs['who'] ??= 'nobody';");
    expect(spec).toContain("  await step_logIn(page, { 'who': `${inputs['email']}` });");
    expect(spec).toContain("  await page.keyboard.press('Enter');");
    expect(spec).toContain("  await expect(page.locator('#t')).toContainText('Total');");
    expect(spec).toContain("  await expect(page).toHaveURL(new RegExp('^.*/done$'));");
    expect(spec).toContain('  watch(page);');
    expect(spec).toContain('expect(seen.server, "requests failed").toEqual([]);');
  });
});
