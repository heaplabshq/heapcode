import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProvider, resolveCapabilities, type Provider } from '@heapcode/core';
import { profileContextWindow, type ConfigStore, type SecretsStore } from '@heapcode/host';
import {
  RESULTS_DIR,
  Templates,
  createHealer,
  createRunDir,
  diagnose,
  explore,
  newRunId,
  readFingerprints,
  resolveUrl,
  runFlow,
  saveFlow,
  saveRefreshed,
  tracePathFor,
  writeExplore,
  writeReports,
  writeRunSummary,
  type Diagnosis,
  type ExploreReportInput,
  type ExploreResult,
  type Finding,
  type Flow,
  type FlowResult,
  type HealRequest,
  type Healer,
  type RunSummary,
  type StepResult,
  type Workspace,
} from '@heapcode/qa';
import { PlaywrightDriver } from '@heapcode/qa-playwright';
import type { RunListing } from './protocol.js';

export type { RunListing } from './protocol.js';

/**
 * Heap QA's work, once, for both of its front ends.
 *
 * The terminal (`heapcode qa …`) and the app (`/qa` in `heapcode web`) do the
 * same things — run flows, explore, record, have the AI write a flow — and
 * differ only in how they show progress and ask questions. So the doing lives
 * here and reports through events; each front end supplies the words.
 */

/** The agent role's model, ready to call — or undefined when none is set up. */
export interface AgentModel {
  provider: Provider;
  model: string;
  nativeToolCalls: boolean;
  contextWindow: number;
  maxTokens?: number;
}

export async function resolveAgentModel(config: ConfigStore, secrets: SecretsStore): Promise<AgentModel | undefined> {
  const profile = await config.resolve('agent').catch(() => undefined);
  if (!profile?.model) return undefined;
  const apiKey = await secrets.getApiKey(profile.name);
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

/** Templates for a run and the base URL, filled — `${ENV}` in heapqa.yaml included. */
export function prepare(ws: Workspace, baseUrlOverride?: string, env: Record<string, string | undefined> = process.env): { runId: string; templates: Templates; baseUrl?: string } {
  const runId = newRunId();
  const templates = new Templates({ inputs: {}, secret: ws.secret, env, runId });
  const raw = baseUrlOverride ?? ws.config.baseUrl;
  const baseUrl = raw === undefined ? undefined : templates.fill(raw).value;
  return { runId, templates, ...(baseUrl ? { baseUrl } : {}) };
}

export function launchDriver(
  ws: Workspace,
  options: { browser?: 'chrome' | 'msedge' | 'chromium'; headless?: boolean; timeout?: number; exitOnSigint?: boolean } = {},
): Promise<PlaywrightDriver> {
  return PlaywrightDriver.launch({
    channel: options.browser ?? ws.config.browser.channel,
    headless: options.headless ?? ws.config.browser.headless ?? true,
    timeout: options.timeout ?? ws.config.timeout,
    targets: ws.config.targets,
    ...(options.exitOnSigint === false ? { exitOnSigint: false } : {}),
  });
}

export interface SuiteEvents {
  onFlowStart?(id: string, flow: Flow): void;
  onStep?(id: string, step: StepResult): void;
  /** The agent started looking for a step's element (it can take a while). */
  onHealStart?(id: string, request: HealRequest, model: string): void;
  onDiagnosis?(id: string, diagnosis: Diagnosis): void;
  onFlowEnd?(id: string, result: FlowResult): void;
}

export interface SuiteOptions {
  ws: Workspace;
  flows: [string, Flow][];
  runId: string;
  templates: Templates;
  baseUrl?: string;
  driver: PlaywrightDriver;
  /** For AI healing and diagnosis. Without it both stop short of a model. */
  model?: AgentModel;
  heal?: boolean;
  diagnose?: boolean;
  trace?: boolean;
  events?: SuiteEvents;
  /** Stops between flows; closing the driver stops the flow in progress. */
  signal?: AbortSignal;
}

/**
 * Run flows and write everything a run leaves behind: run.json, the
 * reports, screenshots, traces, refreshed fingerprints for what passed.
 */
export async function runSuite(options: SuiteOptions): Promise<{ summary: RunSummary; report: string; file: string }> {
  const { ws, driver, model, templates, events } = options;
  const mode = options.heal === false ? 'off' : ws.config.heal;
  let current = '';
  let healer: Healer | undefined;
  if (mode !== 'off') {
    healer = createHealer(
      model && mode === 'ai'
        ? {
            agent: {
              provider: model.provider,
              model: model.model,
              nativeToolCalls: model.nativeToolCalls,
              contextWindow: model.contextWindow,
              templates,
              onStart: (request) => events?.onHealStart?.(current, request, model.model),
            },
          }
        : {},
    );
  }
  // `heal: similarity` keeps diagnosis off the model too — it is the no-model setting.
  const diagnoseWith = options.diagnose !== false && ws.config.heal === 'ai' ? model : undefined;

  const runDir = createRunDir(ws.dir, options.runId);
  const started = Date.now();
  const summary: RunSummary = {
    runId: options.runId,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    dir: runDir,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    passed: 0,
    failed: 0,
    flows: [],
  };
  for (const [id, flow] of options.flows) {
    if (options.signal?.aborted) break;
    current = id;
    events?.onFlowStart?.(id, flow);
    const result = await runFlow(id, flow, {
      driver,
      library: ws.steps,
      templates: templates.withInputs(flow.inputs),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      timeout: ws.config.timeout,
      screenshots: 'every-step',
      ...(options.trace !== false ? { tracePath: tracePathFor(runDir, id) } : {}),
      onStep: (step) => events?.onStep?.(id, step),
      ...(healer ? { healer } : {}),
      fingerprints: (source) => readFingerprints(ws.dir, source.id, source.kind),
      refreshFingerprints: true,
    });
    // How the elements looked when this flow last passed — what healing compares with next time.
    if (result.status === 'passed') saveRefreshed(ws.dir, result.refreshed);
    else if (diagnoseWith) {
      const guess = await diagnose(diagnoseWith.provider, diagnoseWith.model, result, AbortSignal.timeout(45_000));
      if (guess) {
        result.diagnosis = guess;
        events?.onDiagnosis?.(id, guess);
      }
    }
    summary.flows.push(saveFlow(runDir, result));
    if (result.status === 'passed') summary.passed += 1;
    else summary.failed += 1;
    events?.onFlowEnd?.(id, result);
  }
  summary.durationMs = Date.now() - started;
  const file = writeRunSummary(summary);
  const report = writeReports(summary);
  return { summary, report, file };
}

export interface ExploreSiteOptions {
  ws: Workspace;
  runId: string;
  templates: Templates;
  baseUrl?: string;
  /** Path or address; default `/`. */
  start?: string;
  driver: PlaywrightDriver;
  maxPages?: number;
  maxDepth?: number;
  forms?: boolean;
  buttons?: boolean;
  allowCommits?: boolean;
  onPage?(url: string, index: number): void;
  onFinding?(finding: Finding): void;
  signal?: AbortSignal;
}

export async function exploreSite(options: ExploreSiteOptions): Promise<{ result: ExploreResult; start: string; dir: string; report: string }> {
  const start = resolveUrl(options.start ?? '/', options.baseUrl);
  const started = Date.now();
  const result = await explore({
    driver: options.driver,
    startUrl: start,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    targets: options.ws.config.targets,
    templates: options.templates,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.forms !== undefined ? { forms: options.forms } : {}),
    ...(options.buttons !== undefined ? { buttons: options.buttons } : {}),
    ...(options.allowCommits !== undefined ? { allowCommits: options.allowCommits } : {}),
    ...(options.onPage ? { onPage: options.onPage } : {}),
    ...(options.onFinding ? { onFinding: options.onFinding } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const { dir, report } = writeExplore(options.ws.dir, options.runId, result, { start, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started });
  return { result, start, dir, report };
}

/** Every run and explore in results/, newest first. Unreadable folders are skipped. */
export function listRuns(dir: string): RunListing[] {
  const results = join(dir, RESULTS_DIR);
  if (!existsSync(results)) return [];
  const out: RunListing[] = [];
  for (const name of readdirSync(results)) {
    try {
      if (name.endsWith('-explore')) {
        const data = JSON.parse(readFileSync(join(results, name, 'explore.json'), 'utf8')) as ExploreReportInput;
        const count = (s: string): number => data.findings.filter((f) => f.severity === s).length;
        out.push({ id: name, kind: 'explore', startedAt: data.startedAt, durationMs: data.durationMs, findings: { high: count('high'), medium: count('medium'), low: count('low') }, pages: data.pages.length });
      } else if (existsSync(join(results, name, 'run.json'))) {
        const data = JSON.parse(readFileSync(join(results, name, 'run.json'), 'utf8')) as RunSummary;
        out.push({ id: name, kind: 'run', startedAt: data.startedAt, durationMs: data.durationMs, passed: data.passed, failed: data.failed, healed: data.flows.reduce((n, f) => n + (f.heals?.length ?? 0), 0) });
      }
    } catch {
      // A run still being written, or a stray folder.
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** The newest test run (not explore), or the one named. */
export function findRun(dir: string, runId: string | undefined): { runId: string; summary: RunSummary } | string {
  const resultsDir = join(dir, RESULTS_DIR);
  const runs = existsSync(resultsDir) ? readdirSync(resultsDir).filter((d) => !d.endsWith('-explore') && existsSync(join(resultsDir, d, 'run.json'))).sort() : [];
  const id = runId ?? runs.at(-1);
  if (!id) return 'No runs yet — `heapcode qa run` first.';
  const file = join(resultsDir, id, 'run.json');
  if (!existsSync(file)) return `No run ${id} in results/.`;
  const summary = JSON.parse(readFileSync(file, 'utf8')) as RunSummary;
  // The folder may have moved since; the report is written where it is now.
  return { runId: id, summary: { ...summary, dir: join(resultsDir, id) } };
}
