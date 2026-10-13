import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  Templates,
  createRunDir,
  formatErrors,
  initWorkspace,
  loadWorkspace,
  newRunId,
  runFlow,
  saveFlow,
  selectFlows,
  tracePathFor,
  writeRunSummary,
  type RunSummary,
  type StepResult,
} from '@heapcode/qa';
import { BrowserMissingError, PlaywrightDriver, installChromium } from '@heapcode/qa-playwright';

/**
 * `heapcode qa …` — Heap QA from the terminal.
 *
 * Works on a folder, the same way Heap Code and Heap Chat do: the one given
 * with --dir, else the current directory. That folder holds heapqa.yaml,
 * flows/, steps/ and results/ (see docs/QA_PLAN.md §6).
 *
 * Exit codes are for CI: 0 every flow passed, 1 a flow failed, 2 the run
 * could not start (bad files, no browser, unknown flow).
 */
export async function runQa(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'run':
      return qaRun(rest);
    case 'check':
      return qaCheck(rest);
    case 'init':
      return qaInit(rest);
    case 'install':
      return qaInstall();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printQaHelp();
      return 0;
    default:
      console.error(`Unknown command \`heapcode qa ${sub}\`.\n`);
      printQaHelp();
      return 2;
  }
}

function printQaHelp(): void {
  console.log(`heapcode qa — test your web app by its flows (Heap QA)

Usage:
  heapcode qa init [folder] [--base-url URL]   Start a test folder: heapqa.yaml, flows/, steps/, .gitignore
  heapcode qa check [--dir D]                  Check every flow and step file for mistakes, without a browser
  heapcode qa run [flow…] [flags]              Play flows back (all of them, or the ones named) and save the results
  heapcode qa install                          Download Heap QA's own Chromium — only needed with no Chrome or Edge installed

Run flags:
  --dir D            The test folder (default: the current directory)
  --base-url URL     Where relative \`goto:\` addresses point — overrides heapqa.yaml
  --headed           Show the browser while it runs
  --browser NAME     chrome (default), msedge or chromium
  --json             Print the run summary as JSON instead of text
  --no-trace         Do not save traces of failed flows

Results go to <folder>/results/<run>/: run.json, a screenshot per step, and a
trace of each failed flow (open with \`npx playwright show-trace <file>\`).
Secrets are hidden in run.json and the terminal, but a trace records the page
exactly as it was, typed passwords included — keep results/ out of commits
and shared artifacts (the starter .gitignore does), or use --no-trace.
Exit code: 0 all passed, 1 a flow failed, 2 the run could not start.`);
}

interface Flags {
  dir: string;
  positional: string[];
  baseUrl?: string;
  headed: boolean;
  json: boolean;
  trace: boolean;
  browser?: 'chrome' | 'msedge' | 'chromium';
}

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = { dir: process.cwd(), positional: [], headed: false, json: false, trace: true };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value = (): string | undefined => args[++i];
    switch (arg) {
      case '--dir': {
        const v = value();
        if (!v) return '--dir takes a folder.';
        flags.dir = resolve(v);
        break;
      }
      case '--base-url': {
        const v = value();
        if (!v) return '--base-url takes an address, e.g. http://localhost:5173';
        flags.baseUrl = v;
        break;
      }
      case '--browser': {
        const v = value();
        if (v !== 'chrome' && v !== 'msedge' && v !== 'chromium') return '--browser is chrome, msedge or chromium.';
        flags.browser = v;
        break;
      }
      case '--headed':
        flags.headed = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--no-trace':
        flags.trace = false;
        break;
      default:
        if (arg.startsWith('-')) return `Unknown flag ${arg}.`;
        flags.positional.push(arg);
    }
  }
  return flags;
}

function qaInit(args: string[]): number {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  const dir = flags.positional[0] ? resolve(flags.positional[0]) : flags.dir;
  const created = initWorkspace(dir, { baseUrl: flags.baseUrl });
  const where = shown(dir) || '.';
  if (created.length === 0) console.log(`${where} already has everything — nothing to create.`);
  else console.log(`Created in ${where}:\n${created.map((f) => `  ${f}`).join('\n')}\n\nNext: start your app, then \`heapcode qa run${where === '.' ? '' : ` --dir ${where}`}\`.`);
  return 0;
}

function qaCheck(args: string[]): number {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  const ws = loadWorkspace(flags.dir);
  if (ws.errors.length) {
    console.error(formatErrors(ws.errors));
    return 2;
  }
  console.log(`OK — ${ws.flows.size} flow${ws.flows.size === 1 ? '' : 's'}, ${ws.steps.size} reusable step${ws.steps.size === 1 ? '' : 's'}.`);
  return 0;
}

async function qaInstall(): Promise<number> {
  console.log('Downloading Chromium for Heap QA…');
  try {
    await installChromium((line) => console.log(`  ${line}`));
    console.log('Done.');
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

async function qaRun(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  if (!existsSync(flags.dir)) return fail(`${flags.dir} does not exist.`);
  const ws = loadWorkspace(flags.dir);
  if (ws.errors.length) return fail(formatErrors(ws.errors));
  const { flows, unknown } = selectFlows(ws, flags.positional);
  if (unknown.length) return fail(`No flow named ${unknown.join(', ')}. Flows: ${[...ws.flows.keys()].join(', ') || 'none — add one to flows/'}.`);
  if (flows.length === 0) return fail('No flows to run — add a .yaml file to flows/ (`heapcode qa init` makes an example).');

  const runId = newRunId();
  const env = process.env;
  const baseTemplates = new Templates({ inputs: {}, secret: ws.secret, env, runId });
  let baseUrl: string | undefined;
  try {
    const raw = flags.baseUrl ?? ws.config.baseUrl;
    baseUrl = raw === undefined ? undefined : baseTemplates.fill(raw).value;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  let driver: PlaywrightDriver;
  try {
    driver = await PlaywrightDriver.launch({
      channel: flags.browser ?? ws.config.browser.channel,
      headless: flags.headed ? false : (ws.config.browser.headless ?? true),
      timeout: ws.config.timeout,
      targets: ws.config.targets,
    });
  } catch (err) {
    return fail(err instanceof BrowserMissingError || err instanceof Error ? err.message : String(err));
  }

  const runDir = createRunDir(ws.dir, runId);
  const started = Date.now();
  const summary: RunSummary = { runId, startedAt: new Date(started).toISOString(), durationMs: 0, dir: runDir, ...(baseUrl ? { baseUrl } : {}), passed: 0, failed: 0, flows: [] };
  const say = flags.json ? () => {} : (line: string) => console.log(line);
  say(`Running ${flows.length} flow${flows.length === 1 ? '' : 's'}${baseUrl ? ` against ${baseUrl}` : ''}\n`);

  try {
    for (const [id, flow] of flows) {
      say(`${flow.name}  (${flow.file})`);
      const result = await runFlow(id, flow, {
        driver,
        library: ws.steps,
        templates: baseTemplates.withInputs(flow.inputs),
        baseUrl,
        timeout: ws.config.timeout,
        screenshots: 'every-step',
        ...(flags.trace ? { tracePath: tracePathFor(runDir, id) } : {}),
        onStep: (step) => say(stepLine(step)),
      });
      summary.flows.push(saveFlow(runDir, result));
      if (result.status === 'passed') summary.passed += 1;
      else summary.failed += 1;
      say(result.status === 'passed' ? `  ✓ passed in ${seconds(result.durationMs)}\n` : `  ✗ failed — ${result.error}\n`);
    }
  } finally {
    await driver.close();
  }

  summary.durationMs = Date.now() - started;
  const file = writeRunSummary(summary);
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const total = summary.passed + summary.failed;
    console.log(`${summary.failed ? '✗' : '✓'} ${summary.passed}/${total} passed in ${seconds(summary.durationMs)}`);
    console.log(`Results: ${shown(file)}`);
    for (const f of summary.flows) if (f.trace) console.log(`Trace (${f.id}): npx playwright show-trace ${shown(resolve(runDir, f.trace))}`);
  }
  return summary.failed ? 1 : 0;
}

function stepLine(step: StepResult): string {
  // A reusable step's own row is printed before its children run, so its
  // final status is not known yet; the children carry the outcome.
  const mark = step.kind === 'use' ? '↳' : step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '·';
  const indent = '  '.repeat(step.depth + 1);
  const timing = step.status === 'skipped' || step.kind === 'use' ? '' : `  ${seconds(step.durationMs)}`;
  const errors = step.console.filter((l) => l.level === 'error').length;
  const note = [errors ? `${errors} console error${errors === 1 ? '' : 's'}` : '', step.failedRequests.length ? `${step.failedRequests.length} failed request${step.failedRequests.length === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(', ');
  const head = `${indent}${mark} ${step.path}  ${step.label}${timing}${note ? `  (${note})` : ''}`;
  return step.status === 'failed' && step.error && step.kind !== 'use' ? `${head}\n${indent}    ${step.error}` : head;
}

/** Relative when that is shorter and inside the current directory, else absolute. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function usage(message: string): number {
  console.error(`${message}\nSee \`heapcode qa --help\`.`);
  return 2;
}

function fail(message: string): number {
  console.error(message);
  return 2;
}
