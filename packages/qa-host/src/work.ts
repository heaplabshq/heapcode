import {
  Recording,
  Templates,
  applyDescription,
  applyUses,
  describeFlow,
  findUses,
  flowId,
  newRunId,
  runAiTask,
  runFlow,
  writeDraft,
  writeFlow,
  type Flow,
  type FlowResult,
  type SavedFingerprints,
  type Step,
  type UseMatch,
  type Workspace,
} from '@heapcode/qa';
import type { PlaywrightDriver } from '@heapcode/qa-playwright';
import { launchDriver, type AgentModel } from './orchestrate.js';

/**
 * Recording and AI-written flows, for both front ends — see orchestrate.ts.
 * Questions (a name, which reusable steps to use, whether to keep a secret,
 * whether to allow a click) are the front end's: these take the answers.
 */

export interface RecordingEvents {
  onStep?(step: Step, count: number): void;
  /** A run of recorded steps repeats a known reusable step. */
  onKnownStep?(match: UseMatch): void;
  /** The person finished in the browser: the bar's Done, or the window closed. */
  onFinished?(): void;
}

/** A visible browser being watched: start it, let the person work, stop it, then save. */
export class RecordingSession {
  private readonly hinted = new Set<string>();
  private stopRecording: () => Promise<void> = async () => {};
  private closed = false;
  title = '';

  private constructor(
    private readonly ws: Workspace,
    private readonly driver: PlaywrightDriver,
    readonly recording: Recording,
    private readonly events: RecordingEvents,
  ) {}

  static async start(
    ws: Workspace,
    options: { start: string; baseUrl?: string; browser?: 'chrome' | 'msedge' | 'chromium'; exitOnSigint?: boolean },
    events: RecordingEvents = {},
  ): Promise<RecordingSession> {
    const driver = await launchDriver(ws, { browser: options.browser, headless: false, exitOnSigint: options.exitOnSigint ?? false });
    const session = new RecordingSession(ws, driver, new Recording(options.baseUrl), events);
    try {
      session.stopRecording = await driver.record({
        event: (event) => {
          if (event.kind === 'done') events.onFinished?.();
          else session.saw(session.recording.add(event));
          return session.recording.stepCount;
        },
        navigated: (url) => session.saw(session.recording.navigated(url)),
        closed: () => events.onFinished?.(),
      });
      session.saw(session.recording.start(options.start));
      session.title = (await driver.open(options.start)).title;
    } catch (err) {
      await driver.close();
      throw err;
    }
    return session;
  }

  private saw(step: Step | undefined): void {
    if (!step) return;
    this.events.onStep?.(step, this.recording.stepCount);
    const { steps, inputs } = this.recording.peek();
    for (const m of findUses(steps, this.ws.steps, inputs)) {
      const key = `${m.use}@${m.from}`;
      if (this.hinted.has(key)) continue;
      this.hinted.add(key);
      this.events.onKnownStep?.(m);
    }
  }

  get stepCount(): number {
    return this.recording.stepCount;
  }

  /** Stop watching and close the browser. Safe to call twice. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stopRecording();
    await this.driver.close();
  }

  /** The flow so far under `name`, with the reusable steps it repeats (to offer). */
  finish(name: string): { flow: Flow; fingerprints: SavedFingerprints; secrets: Record<string, string>; known: UseMatch[] } {
    const done = this.recording.finish(name);
    return { ...done, known: findUses(done.flow.steps, this.ws.steps, done.flow.inputs) };
  }
}

/** Write a recorded (or AI-written) flow, with the reusable steps the person accepted. */
export function saveFlow(ws: Workspace, flow: Flow, fingerprints: SavedFingerprints, accepted: UseMatch[] = []): { id: string; file: string; flow: Flow } {
  let out = { flow, fingerprints };
  if (accepted.length) out = applyUses(flow, fingerprints, accepted);
  const id = flowId(flow.name, ws.flows.keys());
  const file = writeFlow(ws.dir, id, out.flow, out.fingerprints);
  return { id, file, flow: out.flow };
}

/** Play a flow once, headless, with no model — the proof a new flow replays. */
export async function replayOnce(
  ws: Workspace,
  id: string,
  flow: Flow,
  options: { baseUrl?: string; browser?: 'chrome' | 'msedge' | 'chromium'; secrets?: Record<string, string>; templates?: Templates },
): Promise<FlowResult> {
  const driver = await launchDriver(ws, { browser: options.browser, headless: true });
  try {
    const templates =
      options.templates?.withInputs(flow.inputs) ??
      new Templates({ inputs: flow.inputs, secret: (n) => ws.secret(n) ?? options.secrets?.[n], env: process.env, runId: newRunId() });
    return await runFlow(id, flow, {
      driver,
      library: ws.steps,
      templates,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      timeout: ws.config.timeout,
      screenshots: 'none',
    });
  } finally {
    await driver.close();
  }
}

export interface AiTaskOutcome {
  /** How the agent's run ended. */
  outcome: string;
  /** The model's own closing words. */
  summary: string;
  /** Saved to flows/ — it replayed. */
  saved?: { id: string; file: string; flow: Flow };
  /** Kept in drafts/ — it did not replay. */
  draft?: { file: string; error: string };
  /** Why nothing was saved at all. */
  notSaved?: string;
}

/** Have the agent do a task; name the flow it leaves; replay it without the model; save or draft it. */
export async function aiTask(options: {
  ws: Workspace;
  model: AgentModel;
  task: string;
  start?: string;
  baseUrl?: string;
  templates: Templates;
  name?: string;
  browser?: 'chrome' | 'msedge' | 'chromium';
  headless?: boolean;
  confirm(description: string): Promise<boolean>;
  onAction?(line: string): void;
  signal?: AbortSignal;
}): Promise<AiTaskOutcome> {
  const { ws, model } = options;
  const driver = await launchDriver(ws, { browser: options.browser, headless: options.headless ?? true });
  let result;
  try {
    result = await runAiTask({
      driver,
      provider: model.provider,
      model: model.model,
      nativeToolCalls: model.nativeToolCalls,
      contextWindow: model.contextWindow,
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      task: options.task,
      startUrl: options.start ?? '/',
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      secretNames: ws.secretNames,
      templates: options.templates,
      confirm: options.confirm,
      events: { ...(options.onAction ? { onAction: options.onAction } : {}) },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } finally {
    await driver.close();
  }

  const base = { outcome: result.outcome, summary: result.summary };
  const usable = result.recording.flow.steps.filter((s) => s.kind !== 'goto').length;
  if (result.outcome !== 'done' || usable === 0) {
    return { ...base, notSaved: result.outcome === 'stopped' ? 'Stopped — no flow saved.' : 'The task was not completed, so no flow was saved.' };
  }

  let flow = result.recording.flow;
  const described = await describeFlow(model.provider, model.model, options.task, flow);
  if (described) flow = applyDescription(flow, described);
  flow = { ...flow, name: options.name ?? described?.name ?? options.task.toLowerCase().slice(0, 60) };
  const id = flowId(flow.name, ws.flows.keys());
  const played = await replayOnce(ws, id, flow, { ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.browser ? { browser: options.browser } : {}), templates: options.templates });
  if (played.status !== 'passed') {
    return { ...base, draft: { file: writeDraft(ws.dir, id, flow), error: played.error ?? 'it failed' } };
  }
  return { ...base, saved: { id, file: writeFlow(ws.dir, id, flow, result.recording.fingerprints), flow } };
}
