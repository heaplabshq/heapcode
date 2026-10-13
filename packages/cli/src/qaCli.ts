import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  FLOWS_DIR,
  Recording,
  Templates,
  applyHeals,
  createHealer,
  saveRefreshed,
  type HealProposal,
  type Healer,
  applyDescription,
  applyUses,
  describeFlow,
  runAiTask,
  writeDraft,
  extractSteps,
  findUses,
  parseRange,
  readFingerprints,
  type Flow,
  type UseMatch,
  describeLocator,
  createRunDir,
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
import { createProvider, resolveCapabilities } from '@heapcode/core';
import { ConfigStore, SecretsStore, configFile, profileContextWindow, secretsFile } from '@heapcode/host';

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
  heapcode qa heals [--run ID] [--accept]      Show the fixes healing proposed in the last run (or run ID); --accept writes them into the files
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

When a step's element has moved or changed, the run looks for it again: by
similarity to how it last looked (no model), then — with \`heal: ai\`, the default
in heapqa.yaml — by asking your agent model to look at the page. A healed step
passes and its fix is proposed, never written into the file without --accept-heals
or \`heapcode qa heals --accept\`. If the element is truly gone, the step fails
as a bug.

Record flags: --dir, --base-url, --browser as above, and
  --name NAME        What to call the flow (asked for when not given)

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
}

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = { dir: process.cwd(), positional: [], headed: false, json: false, trace: true, everywhere: false, yes: false, acceptHeals: false, heal: true, accept: false };
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

  // Healing: similarity always (unless off); the agent model only with `heal: ai` and a model set up.
  let healer: Healer | undefined;
  const mode = flags.heal ? ws.config.heal : 'off';
  if (mode !== 'off') {
    const model = mode === 'ai' ? await agentModel() : undefined;
    healer = createHealer(
      model
        ? { agent: { provider: model.provider, model: model.model, nativeToolCalls: model.nativeToolCalls, contextWindow: model.contextWindow, templates: baseTemplates } }
        : {},
    );
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
        ...(healer ? { healer } : {}),
        fingerprints: (source) => readFingerprints(ws.dir, source.id, source.kind),
        refreshFingerprints: true,
      });
      // How the elements looked when this flow last passed — what healing compares with next time.
      if (result.status === 'passed') saveRefreshed(ws.dir, result.refreshed);
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
  const heals = summary.flows.flatMap((f) => f.heals);
  if (heals.length) {
    if (flags.acceptHeals) {
      reportApplied(applyHeals(ws.dir, heals), flags.json);
    } else if (!flags.json) {
      console.log(`\n${heals.length} step${heals.length === 1 ? ' was' : 's were'} healed. The files still have the old locators.`);
      console.log(`Review: heapcode qa heals${flags.dir === process.cwd() ? '' : ` --dir ${shown(flags.dir)}`}    Accept: add --accept`);
    }
  }
  return summary.failed ? 1 : 0;
}

/** The agent role's model, ready to call — or undefined when none is set up. */
async function agentModel(): Promise<{ provider: ReturnType<typeof createProvider>; model: string; nativeToolCalls: boolean; contextWindow: number; maxTokens?: number } | undefined> {
  const config = new ConfigStore(configFile());
  const profile = await config.resolve('agent').catch(() => undefined);
  if (!profile?.model) return undefined;
  const apiKey = await new SecretsStore(secretsFile()).getApiKey(profile.name);
  const provider = createProvider(profile, apiKey);
  const contextWindow = (await provider.contextLengthFor?.(profile.model).catch(() => undefined)) ?? profileContextWindow(profile);
  return {
    provider,
    model: profile.model,
    nativeToolCalls: resolveCapabilities(profile).nativeToolCalls,
    contextWindow,
    ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}),
  };
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
  const resultsDir = join(flags.dir, 'results');
  const runs = existsSync(resultsDir) ? readdirSync(resultsDir).filter((d) => existsSync(join(resultsDir, d, 'run.json'))).sort() : [];
  const runId = flags.run ?? runs.at(-1);
  if (!runId) return fail('No runs yet — `heapcode qa run` first.');
  const file = join(resultsDir, runId, 'run.json');
  if (!existsSync(file)) return fail(`No run ${runId} in results/.`);
  const summary = JSON.parse(readFileSync(file, 'utf8')) as RunSummary;
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

  const baseTemplates = new Templates({ inputs: {}, secret: ws.secret, env: process.env, runId: newRunId() });
  let baseUrl: string | undefined;
  let start: string;
  try {
    const raw = flags.baseUrl ?? ws.config.baseUrl;
    baseUrl = raw === undefined ? undefined : baseTemplates.fill(raw).value;
    start = resolveUrl(flags.positional[0] ?? '/', baseUrl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!isAllowedTarget(start, ws.config.targets)) return fail(notAllowedMessage(start));

  let driver: PlaywrightDriver;
  try {
    driver = await PlaywrightDriver.launch({
      channel: flags.browser ?? ws.config.browser.channel,
      headless: false,
      timeout: ws.config.timeout,
      targets: ws.config.targets,
      exitOnSigint: false,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const recording = new Recording(baseUrl);
  const hinted = new Set<string>();
  const say = (step: ReturnType<Recording['add']>): void => {
    if (!step) return;
    console.log(`  + ${recording.stepCount}  ${stepLabel(step)}`);
    // A known reusable step, just done by hand: say so now, offer it at the end.
    const { steps, inputs } = recording.peek();
    for (const m of findUses(steps, ws.steps, inputs)) {
      const key = `${m.use}@${m.from}`;
      if (hinted.has(key)) continue;
      hinted.add(key);
      console.log(`    ↳ steps ${m.from}–${m.to} are your reusable step \`${m.use}\` — you'll be offered it when you finish`);
    }
  };
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const onSigint = (): void => finish();
  process.once('SIGINT', onSigint);

  let stop: () => Promise<void> = async () => {};
  let title = '';
  try {
    stop = await driver.record({
      event: (event) => {
        if (event.kind === 'done') finish();
        else say(recording.add(event));
        return recording.stepCount;
      },
      navigated: (url) => say(recording.navigated(url)),
      closed: () => finish(),
    });
    say(recording.start(start));
    title = (await driver.open(start)).title;
  } catch (err) {
    process.off('SIGINT', onSigint);
    await driver.close();
    return fail(err instanceof Error ? err.message : String(err));
  }
  console.log(
    '\nRecording in the browser window. Use the page as a person would; the bar at the bottom right adds checks.\n' +
      'Finish with Done on that bar, by closing the window, or with Ctrl+C here.\n',
  );
  await finished;
  process.off('SIGINT', onSigint);
  await stop();
  await driver.close();

  if (recording.stepCount <= 1) {
    console.log('Nothing was recorded — no flow saved.');
    return 0;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const suggested = title.trim().toLowerCase() || 'recording';
    const name = flags.name ?? ((await rl?.question(`\nName this flow [${suggested}]: `))?.trim() || suggested);
    const finished = recording.finish(name);
    const { secrets } = finished;
    let { flow, fingerprints } = finished;
    const known = findUses(flow.steps, ws.steps, flow.inputs);
    const accepted: UseMatch[] = [];
    for (const m of known) {
      const answer = rl ? (await rl.question(`Steps ${m.from}–${m.to} are your reusable step \`${m.use}\`. Use it instead? [Y/n]: `)).trim().toLowerCase() : 'n';
      if (answer === '' || answer === 'y' || answer === 'yes') {
        accepted.push(m);
        for (const [ours, theirs] of m.secrets) console.log(`  Note: \`${m.use}\` types secret ${theirs} where you typed ${ours}.`);
      }
    }
    if (accepted.length) ({ flow, fingerprints } = applyUses(flow, fingerprints, accepted));
    else if (known.length && !rl) console.log(`Steps ${known.map((m) => `${m.from}–${m.to} (${m.use})`).join(', ')} repeat reusable steps; edit the flow to \`use:\` them.`);
    mkdirSync(join(ws.dir, FLOWS_DIR), { recursive: true });
    const id = flowId(name, ws.flows.keys());
    const file = writeFlow(ws.dir, id, flow, fingerprints);
    console.log(`Saved ${shown(file)} — ${flow.steps.length} steps.`);

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
    const replay = await PlaywrightDriver.launch({
      channel: flags.browser ?? ws.config.browser.channel,
      headless: true,
      timeout: ws.config.timeout,
      targets: ws.config.targets,
    });
    try {
      const result = await runFlow(id, flow, {
        driver: replay,
        library: ws.steps,
        templates: new Templates({ inputs: flow.inputs, secret: (n) => ws.secret(n) ?? secrets[n], env: process.env, runId: newRunId() }),
        baseUrl,
        timeout: ws.config.timeout,
        screenshots: 'none',
      });
      if (result.status === 'passed') {
        console.log(`✓ It plays back. Run it any time with \`heapcode qa run ${id}\`.`);
        return 0;
      }
      console.log(`✗ Playback failed — ${result.error}\nThe flow is saved; edit ${shown(file)} or record it again.`);
      return 1;
    } finally {
      await replay.close();
    }
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
  const { provider, contextWindow } = model;

  const runId = newRunId();
  const templates = new Templates({ inputs: {}, secret: ws.secret, env: process.env, runId });
  let baseUrl: string | undefined;
  try {
    const raw = flags.baseUrl ?? ws.config.baseUrl;
    baseUrl = raw === undefined ? undefined : templates.fill(raw).value;
    resolveUrl(flags.url ?? '/', baseUrl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const launch = (headless: boolean): Promise<PlaywrightDriver> =>
    PlaywrightDriver.launch({ channel: flags.browser ?? ws.config.browser.channel, headless, timeout: ws.config.timeout, targets: ws.config.targets });
  let driver: PlaywrightDriver;
  try {
    driver = await launch(!flags.headed);
  } catch (err) {
    rl?.close();
    return fail(err instanceof Error ? err.message : String(err));
  }

  console.log(`${model.model} is doing: ${task}\n`);
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.once('SIGINT', onSigint);
  let result;
  try {
    result = await runAiTask({
      driver,
      provider,
      model: model.model,
      nativeToolCalls: model.nativeToolCalls,
      contextWindow,
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      task,
      startUrl: flags.url ?? '/',
      baseUrl,
      secretNames: ws.secretNames,
      templates,
      confirm: async (what) => {
        if (flags.yes) return true;
        if (!rl) {
          console.log(`  ✗ needs approval, refused (no terminal to ask in; --yes approves): ${what}`);
          return false;
        }
        const answer = (await rl.question(`  ? ${what} — this looks like it commits something. Allow? [y/N]: `)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      },
      events: { onAction: (line) => console.log(`  • ${line}`) },
      signal: abort.signal,
    });
  } catch (err) {
    rl?.close();
    process.off('SIGINT', onSigint);
    await driver.close();
    return fail(err instanceof Error ? err.message : String(err));
  }
  process.off('SIGINT', onSigint);
  await driver.close();

  const usable = result.recording.flow.steps.filter((s) => s.kind !== 'goto').length;
  console.log(`\n${result.summary || `(the run ended: ${result.outcome})`}`);
  if (result.outcome !== 'done' || usable === 0) {
    rl?.close();
    console.log(result.outcome === 'stopped' ? 'Stopped — no flow saved.' : 'The task was not completed, so no flow was saved.');
    return 1;
  }

  try {
    let flow = result.recording.flow;
    const described = await describeFlow(provider, model.model, task, flow);
    if (described) flow = applyDescription(flow, described);
    const name = flags.name ?? described?.name ?? task.toLowerCase().slice(0, 60);
    flow = { ...flow, name };
    const id = flowId(name, ws.flows.keys());
    const hasChecks = flow.steps.some((s) => s.kind === 'expect');

    console.log('\nPlaying it back without the AI…');
    const replay = await launch(true);
    try {
      const played = await runFlow(id, flow, {
        driver: replay,
        library: ws.steps,
        templates: templates.withInputs(flow.inputs),
        baseUrl,
        timeout: ws.config.timeout,
        screenshots: 'none',
      });
      if (played.status !== 'passed') {
        const draft = writeDraft(ws.dir, id, flow);
        console.log(`✗ It did not replay — ${played.error}\nSaved as a draft to look at: ${shown(draft)} (not run by \`heapcode qa run\`).`);
        return 1;
      }
    } finally {
      await replay.close();
    }
    const file = writeFlow(ws.dir, id, flow, result.recording.fingerprints);
    console.log(`✓ Saved ${shown(file)} — ${flow.steps.length} steps, and it replays.${hasChecks ? '' : ' It has no checks yet; add an `expect` so it can fail when the app is wrong.'}`);
    return 0;
  } finally {
    rl?.close();
  }
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
