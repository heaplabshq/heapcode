import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { relative, resolve } from 'node:path';
import {
  FLOWS_DIR,
  type Finding,
  renderFixBrief,
  writeReports,
  applyHeals,
  type HealProposal,
  applyUses,
  extractSteps,
  findUses,
  parseRange,
  readFingerprints,
  type Flow,
  type UseMatch,
  describeLocator,
  flowId,
  isAllowedTarget,
  notAllowedMessage,
  resolveUrl,
  saveSecrets,
  stepLabel,
  writeFlow,
  formatErrors,
  initWorkspace,
  loadWorkspace,
  selectFlows,
  type StepResult,
} from '@heapcode/qa';
import { BrowserMissingError, PlaywrightDriver, installChromium } from '@heapcode/qa-playwright';
import { ConfigStore, SecretsStore, configFile, secretsFile } from '@heapcode/host';
import {
  RecordingSession,
  aiTask,
  exploreSite,
  findRun,
  launchDriver,
  prepare,
  replayOnce,
  resolveAgentModel,
  runSuite,
  saveFlow,
  type AgentModel,
} from '@heapcode/qa-host';

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
    case 'record':
      return qaRecord(rest);
    case 'extract':
      return qaExtract(rest);
    case 'do':
      return qaDo(rest);
    case 'heals':
      return qaHeals(rest);
    case 'report':
      return qaReport(rest);
    case 'fix':
      return qaFix(rest);
    case 'explore':
      return qaExplore(rest);
    case 'reuse':
      return qaReuse(rest);
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
  heapcode qa record [address] [flags]         Click through your app in a browser; Heap QA writes the flow, then plays it back once
  heapcode qa do "<task>" [--url PATH] [flags]  Let the AI do a task in your app; what worked becomes a flow that replays without it
                                               (uses your agent model — see \`heapcode model\`)
  heapcode qa extract <flow> <from-to> --as NAME [--everywhere]
                                               Make steps from-to of a flow a reusable step (steps/NAME.yaml) used in its place;
                                               --everywhere uses it in every other flow that repeats those steps too
  heapcode qa reuse <step> [flow…]             Use an existing reusable step in every flow (or the ones named) that repeats its steps
  heapcode qa run [flow…] [flags]              Play flows back (all of them, or the ones named) and save the results
  heapcode qa explore [address] [flags]        Find bugs with no script: visit every page, press what is safe, fill forms with odd input
  heapcode qa heals [--run ID] [--accept]      Show the fixes healing proposed in the last run (or run ID); --accept writes them into the files
  heapcode qa report [--run ID] [--open]       Rebuild the HTML report of the last run (or run ID); --open shows it in the browser
  heapcode qa fix <flow> [--run ID] [--repo DIR]
                                               Hand a failed flow to Heap Code with the evidence; with --repo, start it there
                                               (edits allowed, commands still need approval)
  heapcode qa install                          Download Heap QA's own Chromium — only needed with no Chrome or Edge installed

Run flags:
  --dir D            The test folder (default: the current directory)
  --base-url URL     Where relative \`goto:\` addresses point — overrides heapqa.yaml
  --headed           Show the browser while it runs
  --browser NAME     chrome (default), msedge or chromium
  --json             Print the run summary as JSON instead of text
  --no-trace         Do not save traces of failed flows
  --accept-heals     Write the fixes healing found into the flow files after the run
  --no-heal          Fail a step whose element is missing, without trying to find it again
  --no-diagnose      Do not ask the agent model for a likely cause of each failure
  --open             Open the HTML report when the run ends

When a step's element has moved or changed, the run looks for it again: by
similarity to how it last looked (no model), then — with \`heal: ai\`, the default
in heapqa.yaml — by asking your agent model to look at the page. A healed step
passes and its fix is proposed, never written into the file without --accept-heals
or \`heapcode qa heals --accept\`. If the element is truly gone, the step fails
as a bug.

Record flags: --dir, --base-url, --browser as above, and
  --name NAME        What to call the flow (asked for when not given)

Explore flags: --dir, --base-url, --browser, --headed, --open as above, and
  --pages N          Pages to visit at most (default 20)
  --depth N          Link hops from the start (default 3)
  --allow-commits    Also press Delete / Pay / Submit-like buttons — only on data you can lose
  --no-forms, --no-buttons   Skip filling forms / pressing buttons
Explore never presses Log out, never submits a form with a password, and
reports only what is wrong on any page. Exit 1 when it finds something high.

Do flags: --dir, --base-url, --browser, --headed, --name as above, and
  --url PATH         Where to start (default /)
  --yes              Approve actions that commit something (Delete, Pay, Submit…) without asking.
                     Only for apps and data you can afford to lose.

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
  name?: string;
  as?: string;
  everywhere: boolean;
  url?: string;
  yes: boolean;
  acceptHeals: boolean;
  heal: boolean;
  run?: string;
  accept: boolean;
  diagnose: boolean;
  open: boolean;
  repo?: string;
  pages?: number;
  depth?: number;
  allowCommits: boolean;
  forms: boolean;
  buttons: boolean;
}

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = { dir: process.cwd(), positional: [], headed: false, json: false, trace: true, everywhere: false, yes: false, acceptHeals: false, heal: true, accept: false, diagnose: true, open: false, allowCommits: false, forms: true, buttons: true };
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
      case '--name': {
        const v = value();
        if (!v) return '--name takes a name for the flow.';
        flags.name = v;
        break;
      }
      case '--as': {
        const v = value();
        if (!v) return '--as takes a name for the reusable step, e.g. --as "log in"';
        flags.as = v;
        break;
      }
      case '--everywhere':
        flags.everywhere = true;
        break;
      case '--url': {
        const v = value();
        if (!v) return '--url takes where to start, e.g. /login';
        flags.url = v;
        break;
      }
      case '--yes':
        flags.yes = true;
        break;
      case '--accept-heals':
        flags.acceptHeals = true;
        break;
      case '--no-heal':
        flags.heal = false;
        break;
      case '--accept':
        flags.accept = true;
        break;
      case '--no-diagnose':
        flags.diagnose = false;
        break;
      case '--pages':
      case '--depth': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) return `${arg} takes a whole number.`;
        if (arg === '--pages') flags.pages = n;
        else flags.depth = n;
        break;
      }
      case '--allow-commits':
        flags.allowCommits = true;
        break;
      case '--no-forms':
        flags.forms = false;
        break;
      case '--no-buttons':
        flags.buttons = false;
        break;
      case '--open':
        flags.open = true;
        break;
      case '--repo': {
        const v = value();
        if (!v) return '--repo takes the folder of the app\'s code.';
        flags.repo = resolve(v);
        break;
      }
      case '--run': {
        const v = value();
        if (!v) return '--run takes a run id (a folder name in results/).';
        flags.run = v;
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

  let prepared;
  try {
    prepared = prepare(ws, flags.baseUrl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const { runId, templates, baseUrl } = prepared;

  let driver: PlaywrightDriver;
  try {
    driver = await launchDriver(ws, { browser: flags.browser, headless: flags.headed ? false : undefined });
  } catch (err) {
    return fail(err instanceof BrowserMissingError || err instanceof Error ? err.message : String(err));
  }

  // One model for healing and for diagnosis; `heal: similarity` keeps both off it.
  const mode = flags.heal ? ws.config.heal : 'off';
  const model = ws.config.heal === 'ai' && (flags.diagnose || mode === 'ai') ? await agentModel() : undefined;
  const say = flags.json ? () => {} : (line: string) => console.log(line);
  say(`Running ${flows.length} flow${flows.length === 1 ? '' : 's'}${baseUrl ? ` against ${baseUrl}` : ''}\n`);

  let outcome;
  try {
    outcome = await runSuite({
      ws,
      flows,
      runId,
      templates,
      ...(baseUrl ? { baseUrl } : {}),
      driver,
      ...(model ? { model } : {}),
      heal: flags.heal,
      diagnose: flags.diagnose,
      trace: flags.trace,
      events: {
        onFlowStart: (_id, flow) => say(`${flow.name}  (${flow.file})`),
        onStep: (_id, step) => say(stepLine(step)),
        // The step's row prints only when it ends; this says why it is taking a while.
        onHealStart: (_id, req, name) => say(`      … ${describeLocator(req.locator)} has moved or gone — ${name} is looking for it (up to 90s)`),
        onDiagnosis: (_id, guess) => say(`  ? likely cause (a guess): ${guess.text}`),
        onFlowEnd: (_id, result) => say(result.status === 'passed' ? `  ✓ passed in ${seconds(result.durationMs)}\n` : `  ✗ failed — ${result.error}\n`),
      },
    });
  } finally {
    await driver.close();
  }
  const { summary, report, file } = outcome;
  const runDir = summary.dir;
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const total = summary.passed + summary.failed;
    console.log(`${summary.failed ? '✗' : '✓'} ${summary.passed}/${total} passed in ${seconds(summary.durationMs)}`);
    console.log(`Report: ${shown(report)}`);
    console.log(`Results: ${shown(file)}`);
    for (const f of summary.flows) if (f.trace) console.log(`Trace (${f.id}): npx playwright show-trace ${shown(resolve(runDir, f.trace))}`);
  }
  const heals = summary.flows.flatMap((f) => f.heals);
  if (heals.length) {
    if (flags.acceptHeals) {
      reportApplied(applyHeals(ws.dir, heals), flags.json);
    } else if (!flags.json) {
      console.log(`\n${heals.length} step${heals.length === 1 ? ' was' : 's were'} healed. The files still have the old locators.`);
      console.log(`Review: heapcode qa heals${flags.dir === process.cwd() ? '' : ` --dir ${shown(flags.dir)}`}    Accept: add --accept`);
    }
  }
  if (flags.open) openFile(report);
  if (summary.failed && !flags.json) console.log(`Hand a failure to Heap Code: heapcode qa fix <flow> --repo <your app's folder>`);
  return summary.failed ? 1 : 0;
}

async function qaExplore(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  if (!existsSync(flags.dir)) return fail(`${flags.dir} does not exist. Start a test folder with \`heapcode qa init\`.`);
  const ws = loadWorkspace(flags.dir);
  const configErrors = ws.errors.filter((e) => e.file === 'heapqa.yaml');
  if (configErrors.length) return fail(formatErrors(configErrors));
  let prepared;
  let start: string;
  try {
    prepared = prepare(ws, flags.baseUrl);
    start = resolveUrl(flags.positional[0] ?? '/', prepared.baseUrl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!isAllowedTarget(start, ws.config.targets)) return fail(notAllowedMessage(start));

  let driver: PlaywrightDriver;
  try {
    driver = await launchDriver(ws, { browser: flags.browser, headless: !flags.headed, timeout: Math.min(ws.config.timeout, 5000) });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const say = flags.json ? () => {} : (line: string) => console.log(line);
  say(`Exploring from ${start}${flags.allowCommits ? ' — pressing commit-like buttons too' : ''}\n`);
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.once('SIGINT', onSigint);
  let explored;
  try {
    explored = await exploreSite({
      ws,
      runId: prepared.runId,
      templates: prepared.templates,
      ...(prepared.baseUrl ? { baseUrl: prepared.baseUrl } : {}),
      start,
      driver,
      ...(flags.pages !== undefined ? { maxPages: flags.pages } : {}),
      ...(flags.depth !== undefined ? { maxDepth: flags.depth } : {}),
      forms: flags.forms,
      buttons: flags.buttons,
      allowCommits: flags.allowCommits,
      onPage: (url, i) => say(`  ${i}. ${url.replace(new URL(start).origin, '') || '/'}`),
      onFinding: (f) => say(`     ${f.severity === 'high' ? '✗' : f.severity === 'medium' ? '!' : '·'} ${f.title}`),
      signal: abort.signal,
    });
  } finally {
    process.off('SIGINT', onSigint);
    await driver.close();
  }
  const { result, dir, report } = explored;
  const high = result.findings.filter((f: Finding) => f.severity === 'high').length;
  if (flags.json) {
    console.log(readFileSync(join(dir, 'explore.json'), 'utf8'));
  } else {
    console.log(`\n${result.findings.length ? `${result.findings.length} finding${result.findings.length === 1 ? '' : 's'} (${high} high)` : 'Nothing plainly wrong'} on ${result.pages.length} page${result.pages.length === 1 ? '' : 's'}${result.skipped.length ? `; ${result.skipped.length} thing${result.skipped.length === 1 ? '' : 's'} not tried on purpose (see the report)` : ''}.`);
    console.log(`Report: ${shown(report)}`);
    if (result.findings.some((f: Finding) => f.repro)) console.log(`Repro flows: ${shown(join(dir, 'repros'))} — copy one into flows/ to keep checking for that bug.`);
  }
  if (flags.open) openFile(report);
  return high ? 1 : 0;
}

function qaReport(args: string[]): number {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  const found = findRun(flags.dir, flags.run);
  if (typeof found === 'string') return fail(found);
  const report = writeReports(found.summary);
  console.log(`Report: ${shown(report)}`);
  if (flags.open) openFile(report);
  return 0;
}

async function qaFix(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  const found = findRun(flags.dir, flags.run);
  if (typeof found === 'string') return fail(found);
  const failed = found.summary.flows.filter((f) => f.status === 'failed');
  if (!failed.length) return fail(`Nothing failed in run ${found.runId}.`);
  const name = flags.positional[0];
  const flow = name ? failed.find((f) => f.id === name || f.file === name || f.file?.endsWith(`/${name}.yaml`)) : failed.length === 1 ? failed[0] : undefined;
  if (!flow) return fail(`Which flow? Failed in run ${found.runId}: ${failed.map((f) => f.id).join(', ')}.`);

  const brief = renderFixBrief(flow, found.summary);
  const briefFile = join(found.summary.dir, `fix-${flow.id}.md`);
  writeFileSync(briefFile, brief);
  if (!flags.repo) {
    console.log(brief);
    console.log(`\nSaved to ${shown(briefFile)}. To hand it to Heap Code in your app's folder:\n  heapcode qa fix ${flow.id} --repo <app folder>`);
    return 0;
  }
  if (!existsSync(flags.repo)) return fail(`${flags.repo} does not exist.`);
  // Heap Code itself, headless, in the app's folder: edits apply, commands still ask (and so are refused).
  console.log(`Starting Heap Code in ${shown(flags.repo)} with the evidence from ${flow.id}…\n`);
  const child = spawn(process.execPath, [process.argv[1]!, '-p', brief, '--permission-mode', 'auto-edit'], { cwd: flags.repo, stdio: 'inherit' });
  return new Promise((done) => child.on('exit', (code) => done(code ?? 1)));
}

function openFile(path: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** The agent role's model, ready to call — or undefined when none is set up. */
function agentModel(): Promise<AgentModel | undefined> {
  return resolveAgentModel(new ConfigStore(configFile()), new SecretsStore(secretsFile()));
}

function describeHeal(h: HealProposal): string {
  const how = h.via === 'similarity' ? `similarity ${Math.round((h.score ?? 0) * 100)}%` : `the AI${h.reason ? ` — ${h.reason}` : ''}`;
  return `${h.source.kind === 'flow' ? 'flows' : 'steps'}/${h.source.id}.yaml step ${h.step}: ${describeLocator(h.previous)} → ${describeLocator(h.locator)}  (${how})`;
}

function reportApplied(applied: ReturnType<typeof applyHeals>, json: boolean): void {
  if (json) return;
  for (const a of applied) console.log(`${a.applied ? '✓ updated' : '· skipped'} ${describeHeal(a.proposal)}${a.reason ? ` — ${a.reason}` : ''}${a.commentsLost ? ' (its comments were not kept)' : ''}`);
}

async function qaHeals(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  const found = findRun(flags.dir, flags.run);
  if (typeof found === 'string') return fail(found);
  const { runId, summary } = found;
  const heals = summary.flows.flatMap((f) => f.heals ?? []);
  if (!heals.length) {
    console.log(`Run ${runId} healed nothing.`);
    return 0;
  }
  if (flags.accept) {
    reportApplied(applyHeals(flags.dir, heals), false);
    return 0;
  }
  console.log(`Run ${runId} healed ${heals.length} step${heals.length === 1 ? '' : 's'}:`);
  for (const h of heals) console.log(`  ${describeHeal(h)}`);
  console.log(`\nAccept: heapcode qa heals${flags.run ? ` --run ${runId}` : ''}${flags.dir === process.cwd() ? '' : ` --dir ${shown(flags.dir)}`} --accept`);
  return 0;
}

async function qaRecord(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  if (!existsSync(flags.dir)) return fail(`${flags.dir} does not exist. Start a test folder with \`heapcode qa init\`.`);
  const ws = loadWorkspace(flags.dir);
  // A broken flow elsewhere does not stop a new one being recorded; broken settings do.
  const configErrors = ws.errors.filter((e) => e.file === 'heapqa.yaml');
  if (configErrors.length) return fail(formatErrors(configErrors));

  let baseUrl: string | undefined;
  let start: string;
  try {
    baseUrl = prepare(ws, flags.baseUrl).baseUrl;
    start = resolveUrl(flags.positional[0] ?? '/', baseUrl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!isAllowedTarget(start, ws.config.targets)) return fail(notAllowedMessage(start));

  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const onSigint = (): void => finish();
  process.once('SIGINT', onSigint);
  let session: RecordingSession;
  try {
    session = await RecordingSession.start(
      ws,
      { start, ...(baseUrl ? { baseUrl } : {}), ...(flags.browser ? { browser: flags.browser } : {}) },
      {
        onStep: (step, n) => console.log(`  + ${n}  ${stepLabel(step)}`),
        // A known reusable step, just done by hand: say so now, offer it at the end.
        onKnownStep: (m) => console.log(`    ↳ steps ${m.from}–${m.to} are your reusable step \`${m.use}\` — you'll be offered it when you finish`),
        onFinished: () => finish(),
      },
    );
  } catch (err) {
    process.off('SIGINT', onSigint);
    return fail(err instanceof Error ? err.message : String(err));
  }
  console.log(
    '\nRecording in the browser window. Use the page as a person would; the bar at the bottom right adds checks.\n' +
      'Finish with Done on that bar, by closing the window, or with Ctrl+C here.\n',
  );
  await finished;
  process.off('SIGINT', onSigint);
  await session.stop();

  if (session.stepCount <= 1) {
    console.log('Nothing was recorded — no flow saved.');
    return 0;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const suggested = session.title.trim().toLowerCase() || 'recording';
    const name = flags.name ?? ((await rl?.question(`\nName this flow [${suggested}]: `))?.trim() || suggested);
    const { flow, fingerprints, secrets, known } = session.finish(name);
    const accepted: UseMatch[] = [];
    for (const m of known) {
      const answer = rl ? (await rl.question(`Steps ${m.from}–${m.to} are your reusable step \`${m.use}\`. Use it instead? [Y/n]: `)).trim().toLowerCase() : 'n';
      if (answer === '' || answer === 'y' || answer === 'yes') {
        accepted.push(m);
        for (const [ours, theirs] of m.secrets) console.log(`  Note: \`${m.use}\` types secret ${theirs} where you typed ${ours}.`);
      }
    }
    if (!accepted.length && known.length && !rl) console.log(`Steps ${known.map((m) => `${m.from}–${m.to} (${m.use})`).join(', ')} repeat reusable steps; edit the flow to \`use:\` them.`);
    const saved = saveFlow(ws, flow, fingerprints, accepted);
    console.log(`Saved ${shown(saved.file)} — ${saved.flow.steps.length} steps.`);

    const secretNames = Object.keys(secrets);
    if (secretNames.length) {
      const secretsFile = ws.config.secretsFile ?? '.env.test';
      const answer = rl ? (await rl.question(`Save the typed ${secretNames.join(', ')} to ${secretsFile} so the flow can replay? (it stays out of git) [Y/n]: `)).trim().toLowerCase() : 'n';
      if (answer === '' || answer === 'y' || answer === 'yes') {
        const added = saveSecrets(ws.dir, secrets, secretsFile);
        if (added.length) console.log(`Added ${added.join(', ')} to ${secretsFile}.`);
      } else {
        console.log(`Not saved. Before running this flow, set ${secretNames.join(', ')} in ${secretsFile} or the environment.`);
      }
    }

    // Prove it: play it back once, with nobody at the keyboard.
    console.log('\nPlaying it back once…');
    const result = await replayOnce(ws, saved.id, saved.flow, { ...(baseUrl ? { baseUrl } : {}), ...(flags.browser ? { browser: flags.browser } : {}), secrets });
    if (result.status === 'passed') {
      console.log(`✓ It plays back. Run it any time with \`heapcode qa run ${saved.id}\`.`);
      return 0;
    }
    console.log(`✗ Playback failed — ${result.error}\nThe flow is saved; edit ${shown(saved.file)} or record it again.`);
    return 1;
  } finally {
    rl?.close();
  }
}

async function qaDo(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  const task = flags.positional.join(' ').trim();
  if (!task) return usage('Usage: heapcode qa do "<what to do in the app>" [--url /start]');
  if (!existsSync(flags.dir)) return fail(`${flags.dir} does not exist. Start a test folder with \`heapcode qa init\`.`);
  const ws = loadWorkspace(flags.dir);
  const configErrors = ws.errors.filter((e) => e.file === 'heapqa.yaml');
  if (configErrors.length) return fail(formatErrors(configErrors));

  // The agent role, as Heap Code's agent uses it — one setting for both.
  const model = await agentModel();
  if (!model) {
    return fail('No model is set up. Add a connection with `heapcode connection add`, then `heapcode model set agent <connection> <model>`.');
  }
  let prepared;
  try {
    prepared = prepare(ws, flags.baseUrl);
    resolveUrl(flags.url ?? '/', prepared.baseUrl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  console.log(`${model.model} is doing: ${task}\n`);
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.once('SIGINT', onSigint);
  let done;
  try {
    done = await aiTask({
      ws,
      model,
      task,
      start: flags.url ?? '/',
      ...(prepared.baseUrl ? { baseUrl: prepared.baseUrl } : {}),
      templates: prepared.templates,
      ...(flags.name ? { name: flags.name } : {}),
      ...(flags.browser ? { browser: flags.browser } : {}),
      headless: !flags.headed,
      confirm: async (what) => {
        if (flags.yes) return true;
        if (!rl) {
          console.log(`  ✗ needs approval, refused (no terminal to ask in; --yes approves): ${what}`);
          return false;
        }
        const answer = (await rl.question(`  ? ${what} — this looks like it commits something. Allow? [y/N]: `)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      },
      onAction: (line) => console.log(`  • ${line}`),
      signal: abort.signal,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    process.off('SIGINT', onSigint);
    rl?.close();
  }
  console.log(`\n${done.summary || `(the run ended: ${done.outcome})`}`);
  if (done.notSaved) {
    console.log(done.notSaved);
    return 1;
  }
  if (done.draft) {
    console.log(`✗ It did not replay — ${done.draft.error}\nSaved as a draft to look at: ${shown(done.draft.file)} (not run by \`heapcode qa run\`).`);
    return 1;
  }
  const saved = done.saved!;
  const hasChecks = saved.flow.steps.some((s) => s.kind === 'expect');
  console.log(`✓ Saved ${shown(saved.file)} — ${saved.flow.steps.length} steps, and it replays.${hasChecks ? '' : ' It has no checks yet; add an `expect` so it can fail when the app is wrong.'}`);
  return 0;
}

function qaExtract(args: string[]): number {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  const [flowName, rangeText] = flags.positional;
  if (!flowName || !rangeText || !flags.as) return usage('Usage: heapcode qa extract <flow> <from-to> --as NAME');
  const range = parseRange(rangeText);
  if (!range) return usage(`"${rangeText}" is not a step range — e.g. 2-4.`);
  const ws = loadWorkspace(flags.dir);
  if (ws.errors.length) return fail(`Fix these first:\n${formatErrors(ws.errors)}`);
  const { flows, unknown } = selectFlows(ws, [flowName]);
  if (unknown.length || !flows[0]) return fail(`No flow named ${flowName}. Flows: ${[...ws.flows.keys()].join(', ') || 'none'}.`);
  const [flowKey, flow] = flows[0];

  const id = flowId(flags.as, []);
  if (ws.steps.has(id)) return fail(`steps/${id}.yaml already exists. Pick another name, or \`use: ${id}\` in the flow yourself.`);

  let extracted;
  try {
    extracted = extractSteps(flow, readFingerprints(ws.dir, flowKey), range[0], range[1], id, flags.as);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  // Rewriting a file drops its comments; say so rather than lose them quietly.
  const hadComments = (key: string): boolean => /^\s*#/m.test(readFileSync(join(ws.dir, FLOWS_DIR, `${key}.yaml`), 'utf8'));
  const flowComments = hadComments(flowKey);
  const stepFile = writeFlow(ws.dir, id, extracted.step, extracted.stepFingerprints, 'step');
  writeFlow(ws.dir, flowKey, extracted.flow, extracted.flowFingerprints);
  console.log(`Created ${shown(stepFile)} (${extracted.step.steps.length} steps${Object.keys(extracted.step.inputs).length ? `, inputs: ${Object.keys(extracted.step.inputs).join(', ')}` : ''}).`);
  console.log(`${flowKey}: steps ${range[0]}–${range[1]} are now \`use: ${id}\`.${flowComments ? ' (Comments in that file were not kept.)' : ''}`);

  // Every other flow that repeats those steps.
  const others = reuseIn(ws, id, extracted.step, [...ws.flows.keys()].filter((k) => k !== flowKey), flags.everywhere);
  if (others && !flags.everywhere) console.log(`To use it there too: heapcode qa reuse ${id}${flags.dir === process.cwd() ? '' : ` --dir ${shown(flags.dir)}`}`);

  const after = loadWorkspace(flags.dir);
  if (after.errors.length) {
    console.error(`The folder now has problems:\n${formatErrors(after.errors)}`);
    return 2;
  }
  return 0;
}

function qaReuse(args: string[]): number {
  const flags = parseFlags(args);
  if (typeof flags === 'string') return usage(flags);
  const [stepName, ...flowNames] = flags.positional;
  if (!stepName) return usage('Usage: heapcode qa reuse <step> [flow…]');
  const ws = loadWorkspace(flags.dir);
  if (ws.errors.length) return fail(`Fix these first:\n${formatErrors(ws.errors)}`);
  const step = ws.steps.get(stepName);
  if (!step) return fail(`No reusable step ${stepName}. Steps: ${[...ws.steps.keys()].join(', ') || 'none'}.`);
  const { flows, unknown } = selectFlows(ws, flowNames);
  if (unknown.length) return fail(`No flow named ${unknown.join(', ')}.`);
  const changed = reuseIn(ws, stepName, step, flows.map(([k]) => k), true);
  if (!changed) console.log(`No flow repeats the steps of ${stepName}.`);
  const after = loadWorkspace(flags.dir);
  if (after.errors.length) {
    console.error(`The folder now has problems:\n${formatErrors(after.errors)}`);
    return 2;
  }
  return 0;
}

/**
 * Find `step`'s steps repeated in the named flows; rewrite them to `use:` it
 * when `apply`, else just say where. Returns how many flows repeat it.
 */
function reuseIn(ws: ReturnType<typeof loadWorkspace>, id: string, step: Flow, keys: string[], apply: boolean): number {
  const library = new Map([[id, step]]);
  let count = 0;
  for (const key of keys) {
    const flow = ws.flows.get(key);
    if (!flow) continue;
    const matches = findUses(flow.steps, library, flow.inputs);
    if (!matches.length) continue;
    count += 1;
    const where = matches.map((m) => `${m.from}–${m.to}`).join(', ');
    if (!apply) {
      console.log(`  ${key} repeats it (steps ${where}).`);
      continue;
    }
    const comments = /^\s*#/m.test(readFileSync(join(ws.dir, FLOWS_DIR, `${key}.yaml`), 'utf8'));
    const applied = applyUses(flow, readFingerprints(ws.dir, key), matches);
    writeFlow(ws.dir, key, applied.flow, applied.fingerprints);
    console.log(`${key}: steps ${where} are now \`use: ${id}\`.${comments ? ' (Comments in that file were not kept.)' : ''}`);
    for (const m of matches) for (const [ours, theirs] of m.secrets) console.log(`  Note: it now types secret ${theirs} where it typed ${ours}.`);
  }
  return count;
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
  const healed = step.healed ? `  ⚕ healed by ${step.healed.via === 'similarity' ? `similarity ${Math.round((step.healed.score ?? 0) * 100)}%` : 'the AI'}` : '';
  const bug = step.bug ? '  ⚠ likely an app bug' : '';
  const head = `${indent}${mark} ${step.path}  ${step.label}${timing}${note ? `  (${note})` : ''}${healed}${bug}`;
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
