import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentEvent, AgentEvents, ChatMessage } from '@heapcode/core';
import { projectStateDir } from '@heapcode/core/node';
import { chainRecordings, runAiTask, runFlow, type Flow, type SavedFingerprints, type Templates, type Workspace } from '@heapcode/qa';
import type { PlaywrightDriver } from '@heapcode/qa-playwright';
import { launchDriver, type AgentModel } from './orchestrate.js';
import { keepAiFlow } from './work.js';

/**
 * Ask AI as a conversation, one per test folder.
 *
 * "Log in", then "now also check the cart": the second request carries on in
 * the same browser, from where the first stopped, with the first in the
 * model's history — and the two become one test, saved under one file each
 * time a request adds to it (only once the whole of it replays without the
 * model; otherwise the last good version stays and the attempt is a draft).
 *
 * Kept on disk, beside the project's other state, so it survives switching
 * folders and restarting the app. The browser does not: when the next request
 * finds it gone — an app restart, idle time, or the window switch changed —
 * the test so far is replayed, without the model, to get back to the same
 * place. New chat forgets all of it and closes the browser.
 */

export interface AskTurn {
  task: string;
  /** What the model said and called, for the page to show again later. */
  events: AgentEvent[];
  /** How it ended, in a line. */
  note: string;
  warn: boolean;
}

interface Saved {
  version: 1;
  /** The test this conversation builds, as it stands in the browser. */
  test?: { flow: Flow; fingerprints: SavedFingerprints };
  /** Its file in flows/, once one has been saved. */
  flowId?: string;
  name?: string;
  history: ChatMessage[];
  turns: AskTurn[];
}

/** Long tool output is cut down on disk; the page shows the start of it anyway. */
const KEEP_RESULT = 1500;
/** The model's view of earlier requests: the newest, since the browser holds the rest. */
const KEEP_HISTORY = 12;
/** A browser no one has asked anything of for this long is closed. */
const IDLE_MS = 10 * 60_000;

export class AskConversation {
  private saved: Saved;
  private driver: PlaywrightDriver | undefined;
  private driverHeadless = true;
  /** The browser was just opened: the test so far has to be replayed in it before carrying on. */  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly folder: string,
    private readonly file = askFile(folder),
  ) {
    this.saved = read(this.file);
  }

  get turns(): AskTurn[] {
    return this.saved.turns;
  }

  /** The test so far, when there is one: what the next request builds on. */
  get testName(): string | undefined {
    return this.saved.test ? this.saved.name : undefined;
  }

  async ask(options: {
    ws: Workspace;
    model: AgentModel;
    task: string;
    start: string;
    baseUrl?: string;
    templates: Templates;
    headless: boolean;
    confirm(description: string): Promise<boolean>;
    agentEvents?: Partial<AgentEvents>;
    onAction?(line: string): void;
    onNote?(text: string): void;
    onFrame?(jpeg: string): void;
    signal?: AbortSignal;
  }): Promise<{ saved?: string; draft?: string; error?: string; notSaved?: string; summary: string; outcome: string }> {
    this.stopIdle();
    const { ws, model } = options;
    const driver = await this.browser(options);
    const continuing = await this.restore(driver, options);

    const stopFrames = options.onFrame && driver.screencast ? await driver.screencast(options.onFrame).catch(() => undefined) : undefined;
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
        startUrl: options.start,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        secretNames: ws.secretNames,
        templates: options.templates,
        confirm: options.confirm,
        events: { ...options.agentEvents, ...(options.onAction ? { onAction: options.onAction } : {}) },
        history: this.saved.history.slice(-KEEP_HISTORY),
        continuing,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } finally {
      await stopFrames?.();
      this.startIdle();
    }

    const usable = result.recording.flow.steps.filter((s) => s.kind !== 'goto').length;
    let end: { saved?: string; draft?: string; error?: string; notSaved?: string };
    if (result.outcome !== 'done' || usable === 0) {
      end = { notSaved: result.outcome === 'stopped' ? 'Stopped — the test was not changed.' : 'The task was not completed, so the test was not changed.' };
    } else {
      const test = continuing && this.saved.test ? chainRecordings(this.saved.test, result.recording) : result.recording;
      const kept = await keepAiFlow({
        ws,
        model,
        task: this.saved.history.length ? `${this.saved.history.filter((m) => m.role === 'user').map((m) => m.content).join('; then ')}; then ${options.task}` : options.task,
        recorded: test,
        ...(this.saved.name ? { name: this.saved.name } : {}),
        ...(this.saved.flowId ? { id: this.saved.flowId } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        templates: options.templates,
      });
      // The browser has done all of it either way, so the next request builds on all of it.
      this.saved.test = test;
      this.saved.name = kept.name;
      if (kept.saved) this.saved.flowId = kept.id;
      end = kept.saved ? { saved: kept.saved.file } : { draft: kept.draft!.file, error: kept.draft!.error };
    }

    this.saved.history.push(
      { role: 'user', content: options.task },
      { role: 'assistant', content: `${result.summary || '(no summary)'}\n[${result.outcome === 'done' ? `done — the test now has ${this.saved.test?.flow.steps.length ?? 0} steps` : `ended: ${result.outcome}`}]` },
    );
    this.write();
    return { ...end, summary: result.summary, outcome: result.outcome };
  }

  /** Keep the page's record of a finished request. */
  remember(turn: AskTurn): void {
    this.saved.turns.push({ ...turn, events: compact(turn.events) });
    this.write();
  }

  /** New chat: forget the conversation, close its browser. */
  async reset(): Promise<void> {
    this.saved = { version: 1, history: [], turns: [] };
    rmSync(this.file, { force: true });
    await this.close();
  }

  /** Close the browser; the conversation stays on disk. */
  async close(): Promise<void> {
    this.stopIdle();
    const driver = this.driver;
    this.driver = undefined;
    await driver?.close().catch(() => {});
  }

  private async browser(options: { ws: Workspace; headless: boolean }): Promise<PlaywrightDriver> {
    // The window switch changed since the last request: a new browser, the right kind.
    if (this.driver && this.driverHeadless !== options.headless) await this.close();
    if (!this.driver) {
      this.driver = await launchDriver(options.ws, { headless: options.headless });
      this.driverHeadless = options.headless;
      this.fresh = true;
    }
    return this.driver;
  }

  private fresh = false;

  /**
   * Whether this request carries on from the last. In the same browser it
   * simply does; in a new one the test so far is replayed first, and if that
   * fails the conversation starts a new test from the start page.
   */
  private async restore(driver: PlaywrightDriver, options: { ws: Workspace; baseUrl?: string; templates: Templates; onNote?(text: string): void }): Promise<boolean> {
    const test = this.saved.test;
    if (!test) return false;
    if (!this.fresh) return true;
    this.fresh = false;
    options.onNote?.(`Getting back to where the conversation was: replaying "${this.saved.name ?? 'the test'}" without the AI…`);
    const played = await runFlow(this.saved.flowId ?? 'ask', test.flow, {
      driver,
      library: options.ws.steps,
      templates: options.templates.withInputs(test.flow.inputs),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      timeout: options.ws.config.timeout,
      screenshots: 'none',
    }).catch((err: unknown) => ({ status: 'failed' as const, error: err instanceof Error ? err.message : String(err) }));
    if (played.status === 'passed') return true;
    options.onNote?.(`Could not get back there (${played.error ?? 'the replay failed'}), so this request starts a new test from the start page.`);
    this.saved.test = undefined;
    this.saved.flowId = undefined;
    this.saved.name = undefined;
    return false;
  }

  private startIdle(): void {
    this.stopIdle();
    this.idle = setTimeout(() => void this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  private stopIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.saved));
  }
}

/** Where a test folder's conversation is kept: with the project's state, out of the repository. */
export function askFile(folder: string): string {
  return join(projectStateDir(folder), 'qa-ask.json');
}

function read(file: string): Saved {
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Saved;
      if (saved.version === 1 && Array.isArray(saved.turns) && Array.isArray(saved.history)) return saved;
    }
  } catch {
    // A conversation that cannot be read is started again, not a failure.
  }
  return { version: 1, history: [], turns: [] };
}

/**
 * The events as they are kept: streamed text joined into whole messages,
 * thinking dropped, long tool output cut — what showing it again needs.
 */
export function compact(events: AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  let text = '';
  const flush = (): void => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  for (const e of events) {
    if (e.type === 'text_delta') text += e.text;
    else if (e.type === 'text_end') flush();
    else if (e.type === 'text') {
      text = '';
      out.push(e);
    } else if (e.type === 'tool_call') {
      flush();
      out.push(e);
    } else if (e.type === 'tool_result') out.push({ ...e, content: e.content.slice(0, KEEP_RESULT) });
  }
  flush();
  return out;
}
