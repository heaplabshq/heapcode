import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/parse.js';
import { runFlow, resolveUrl, type RunOptions } from '../src/run.js';
import { Templates } from '../src/template.js';
import { loadWorkspace, selectFlows } from '../src/workspace.js';
import { initWorkspace } from '../src/init.js';
import { createRunDir, saveFlow } from '../src/results.js';
import type { Flow } from '../src/flow.js';
import { FakeDriver } from './fakeDriver.js';

function flow(yaml: string): Flow {
  const r = parseFlow(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

const templates = (inputs: Record<string, string> = {}) =>
  new Templates({ inputs, secret: (n) => (n === 'PW' ? 'hunter2' : undefined), env: {}, runId: 'r1' });

function options(driver: FakeDriver, over: Partial<RunOptions> = {}): RunOptions {
  return { driver, library: new Map(), templates: templates(), baseUrl: 'http://localhost:3000', timeout: 150, screenshots: 'none', ...over };
}

describe('runFlow', () => {
  it('plays every step, including a reusable step with inputs, and hides secrets', async () => {
    const driver = new FakeDriver([
      { label: 'Email', role: 'textbox', name: 'Email' },
      { label: 'Password' },
      { role: 'button', name: 'Log in', text: 'Log in' },
      { css: ['#hello'], text: 'Hi qa+r1@x.test' },
    ]);
    const login = flow(`name: log in
inputs: { who: nobody }
steps:
  - type: { into: { label: Email }, text: "{{who}}" }
  - type: { into: { label: Password }, text: "{{secret:PW}}" }
  - click: { role: button, name: Log in }
`);
    const main = flow(`name: main
inputs: { email: "qa+{{runId}}@x.test" }
steps:
  - goto: /login
  - use: log-in
    with: { who: "{{email}}" }
  - expect: { text: { in: { css: "#hello" }, contains: "{{email}}" } }
`);
    const result = await runFlow('main', main, options(driver, { library: new Map([['log-in', login]]), templates: templates(main.inputs) }));
    expect(result.status).toBe('passed');
    expect(driver.actions).toEqual(['open http://localhost:3000/login', 'type qa+r1@x.test into Email', 'type hunter2 into Password', 'click Log in']);
    expect(result.steps.map((s) => s.path)).toEqual(['1', '2', '2.1', '2.2', '2.3', '3']);
    expect(result.steps[3]!.label).toBe('type "«secret:PW»" into the field labelled "Password"');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.steps[2]!.strategy).toBe('label');
  });

  it('fails at a missing element with what each strategy found, and skips the rest', async () => {
    const driver = new FakeDriver([{ role: 'button', name: 'Save' }, { role: 'button', name: 'Save' }]);
    const result = await runFlow('f', flow(`name: f
steps:
  - click: { testId: save, role: button, name: Save }
  - click: Cancel
`), options(driver));
    expect(result.status).toBe('failed');
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(result.steps[0]!.error).toBe('Could not find button "Save" (testId found 0, role found 2).');
    expect(result.error).toMatch(/^Step 1 \(click button "Save"\)/);
  });

  it('checks text and console errors, never showing a secret', async () => {
    const driver = new FakeDriver([{ css: ['#msg'], text: 'Wrong password hunter2' }]);
    const r1 = await runFlow('f', flow(`name: f
steps:
  - expect: { text: { in: { css: "#msg" }, equals: "Welcome" } }
`), options(driver, { templates: (() => { const t = templates(); t.fill('{{secret:PW}}'); return t; })() }));
    expect(r1.steps[0]!.error).toBe('Expected `#msg` to show "Welcome", but it shows "Wrong password «secret:PW»".');

    driver.console = [{ level: 'error', message: 'TypeError: x is undefined' }];
    const r2 = await runFlow('g', flow('name: g\nsteps:\n  - wait: 1\n  - expect: noConsoleErrors\n'), options(driver));
    // The leftover from before this flow is dropped at the start.
    expect(r2.status).toBe('passed');
    driver.console = [];
    const r3 = await runFlow('h', flow('name: h\nsteps:\n  - goto: /\n  - expect: noConsoleErrors\n'), {
      ...options(driver),
      driver: Object.assign(driver, { open: async (url: string) => { driver.console = [{ level: 'error', message: 'boom' }]; return { url, title: '' }; } }),
    });
    expect(r3.steps[1]!.error).toBe('The page logged 1 error: boom');
  });

  it('resolves addresses against the base URL and refuses relative ones without it', () => {
    expect(resolveUrl('/a?b=1', 'http://localhost:3000/app')).toBe('http://localhost:3000/a?b=1');
    expect(resolveUrl('a', 'http://localhost:3000/app')).toBe('http://localhost:3000/app/a');
    expect(resolveUrl('https://x.test/', undefined)).toBe('https://x.test/');
    expect(() => resolveUrl('/a', undefined)).toThrow(/no baseUrl/);
  });
});

describe('workspace', () => {
  it('starts a folder, loads it, and reports bad references and loops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heapqa-'));
    const created = initWorkspace(dir, { baseUrl: 'http://localhost:5173' });
    expect(created).toEqual(['heapqa.yaml', 'flows/home.yaml', 'steps/.gitkeep', '.gitignore']);
    expect(initWorkspace(dir)).toEqual([]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('results/\n.env.test\n');

    writeFileSync(join(dir, '.env.test'), 'PW=hunter2\n');
    writeFileSync(join(dir, 'steps', 'a.yaml'), 'name: a\nsteps:\n  - use: b\n');
    writeFileSync(join(dir, 'steps', 'b.yaml'), 'name: b\nsteps:\n  - use: a\n');
    writeFileSync(join(dir, 'flows', 'x.yaml'), 'name: x\nsteps:\n  - use: missing\n');
    const ws = loadWorkspace(dir, {});
    expect(ws.config.baseUrl).toBe('http://localhost:5173');
    expect(ws.secret('PW')).toBe('hunter2');
    expect([...ws.flows.keys()]).toEqual(['home', 'x']);
    const messages = ws.errors.map((e) => `${e.file}:${e.line} ${e.message}`);
    expect(messages).toContainEqual(expect.stringMatching(/^flows\/x.yaml:3 No reusable step `missing`/));
    expect(messages).toContainEqual(expect.stringMatching(/loop: a → b → a/));
    expect(selectFlows(ws, ['flows/home.yaml', 'nope'])).toMatchObject({ flows: [['home', expect.anything()]], unknown: ['nope'] });
  });

  it('saves screenshots beside the run and keeps bytes out of the summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heapqa-'));
    mkdirSync(dir, { recursive: true });
    const runDir = createRunDir(dir, '2026-10-14_00-00-00');
    const saved = saveFlow(runDir, {
      id: 'home', name: 'home', status: 'passed', startedAt: '', durationMs: 1,
      steps: [{ path: '1', depth: 0, kind: 'goto', label: 'go', status: 'passed', durationMs: 1, console: [], failedRequests: [], screenshot: new Uint8Array([1, 2]) }],
    });
    expect(saved.steps[0]!.screenshot).toBe(join('screenshots', 'home', '1.png'));
    expect(existsSync(join(runDir, 'screenshots', 'home', '1.png'))).toBe(true);
  });
});
