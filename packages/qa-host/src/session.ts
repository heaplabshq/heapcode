import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type { RpcPeer } from '@heapcode/core';
import type { ConfigStore, SecretsStore } from '@heapcode/host';
import {
  CONFIG_FILE,
  RESULTS_DIR,
  applyHeals,
  describeLocator,
  initWorkspace,
  isAllowedTarget,
  loadWorkspace,
  writeSettings,
  type QaSettingsPatch,
  notAllowedMessage,
  resolveUrl,
  saveSecrets,
  selectFlows,
  stepLabel,
  type ExploreReportInput,
  type Workspace,
} from '@heapcode/qa';
import type { PlaywrightDriver } from '@heapcode/qa-playwright';
import {
  connectionModels,
  deleteConnection,
  listFolders,
  probeConnection,
  saveConnection,
  setModelRole,
  setWebSearch,
  sharedSettings,
  type HostSession,
  type WorkspaceEvents,
  type WorkspaceStore,
} from '@heapcode/web-host';
import type { UiModelRole } from '@heapcode/web-host/protocol';
import {
  QA_METHODS,
  QA_PROTOCOL_VERSION,
  type QaAcceptHealsResult,
  type QaEvent,
  type QaFlowInfo,
  type QaJobKind,
  type QaRecordSaveParams,
  type QaRecordSaveResult,
  type QaRecordStopResult,
  type QaRunDetail,
  type QaState,
} from './protocol.js';
import { exploreSite, findRun, launchDriver, listRuns, prepare, resolveAgentModel, runSuite } from './orchestrate.js';
import { RecordingSession, aiTask, replayOnce, saveFlow } from './work.js';
import { openFile } from './openFile.js';
import { agentEventStream } from './agentEvents.js';

export interface QaSessionDeps {
  /** The workspace `heapcode web` runs in; the test folder is found in or under it. */
  root: string;
  /** Heap Code's folder switches; Heap QA follows them (after any job in progress). */
  workspaceEvents?: WorkspaceEvents;
  /** The recent-folders list Heap Code's picker shows, shared. */
  workspaces?: WorkspaceStore;
  config: ConfigStore;
  secrets: SecretsStore;
  lan: boolean;
}

/**
 * Heap QA in the app: the session behind `/qa`.
 *
 * Does exactly what `heapcode qa` does — the work is in orchestrate.ts and
 * work.ts, shared — and reports it as events on the page's socket instead of
 * lines in a terminal. One job at a time: a run, an explore, a recording or an
 * AI task; the page shows which and can stop it.
 *
 * Recording and AI tasks open a browser on the machine running `heapcode web`.
 * Fine for the desktop app and a local tab; a LAN-reached page is told so
 * (`state.lan`) rather than left wondering where the window went.
 */
export class QaSession implements HostSession {
  private ui: RpcPeer | undefined;
  private folder: string | undefined;
  private busy: QaState['busy'];
  private abort: AbortController | undefined;
  private recording: RecordingSession | undefined;
  private pendingRecording: ReturnType<RecordingSession['finish']> | undefined;
  private recordContext: { baseUrl?: string } = {};

  private root: string;
  private pendingRoot: string | undefined;

  constructor(private readonly deps: QaSessionDeps) {
    this.root = deps.root;
    this.folder = findFolder(deps.root);
    deps.workspaceEvents?.on((root) => {
      // Never mid-job: the switch waits for the run to end (see finishJob).
      if (this.busy) this.pendingRoot = root;
      else this.useRoot(root);
    });
  }

  /** Point Heap QA at another project: its test folder, or none yet. */
  private useRoot(root: string): void {
    this.root = root;
    this.folder = findFolder(root);
    void this.pushState();
  }

  attach(ui: RpcPeer): void {
    this.ui = ui;
    ui.onRequest(QA_METHODS.hello, async () => ({ version: QA_PROTOCOL_VERSION, state: await this.state() }));
    ui.onRequest(QA_METHODS.state, async () => this.state());
    ui.onRequest(QA_METHODS.init, async () => {
      const folder = this.folder ?? join(this.root, 'heapqa');
      initWorkspace(folder);
      this.folder = folder;
      return this.pushState();
    });
    ui.onRequest(QA_METHODS.setFolder, async (raw) => {
      const path = String((raw as { path?: unknown }).path ?? '');
      const full = resolve(this.root, path);
      if (!existsSync(join(full, CONFIG_FILE))) throw new Error(`${path} has no ${CONFIG_FILE}.`);
      this.folder = full;
      return this.pushState();
    });
    ui.onRequest(QA_METHODS.run, async (raw) => {
      const p = raw as { flows?: string[]; headed?: boolean };
      return this.startRun(p.flows ?? [], p.headed === true);
    });
    ui.onRequest(QA_METHODS.explore, async (raw) => this.startExplore(raw as { start?: string; allowCommits?: boolean; ai?: boolean; headed?: boolean }));
    ui.onRequest(QA_METHODS.workspaces, async () => {
      const recent = (await this.deps.workspaces?.list()) ?? [];
      return {
        current: this.root,
        recent: recent.some((r) => r.path === this.root) ? recent : [{ path: this.root, name: basename(this.root) || this.root, lastOpened: Date.now() }, ...recent],
        home: homedir(),
      };
    });
    ui.onRequest(QA_METHODS.browseFolders, async (raw) => listFolders((raw as { path?: string } | undefined)?.path));
    ui.onRequest(QA_METHODS.setRoot, async (raw) => {
      if (this.busy) throw new Error(`Busy: ${this.busy.label}. Stop it first.`);
      const path = resolve(String((raw as { path?: unknown }).path ?? ''));
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a folder: ${path}`);
      await this.deps.workspaces?.record(path);
      this.useRoot(path);
      return this.state();
    });
    ui.onRequest(QA_METHODS.record, async (raw) => this.startRecording((raw as { start?: string }).start));
    ui.onRequest(QA_METHODS.recordStop, async () => this.stopRecording());
    ui.onRequest(QA_METHODS.recordSave, async (raw) => this.saveRecording(raw as QaRecordSaveParams));
    ui.onRequest(QA_METHODS.recordDiscard, async () => {
      this.pendingRecording = undefined;
      await this.recording?.stop();
      this.recording = undefined;
      this.finishJob();
      return {};
    });
    ui.onRequest(QA_METHODS.do, async (raw) => this.startTask(raw as { task?: string; start?: string; name?: string; headed?: boolean }));
    ui.onRequest(QA_METHODS.stop, async () => {
      this.abort?.abort();
      if (this.busy?.kind === 'record') return this.stopRecording();
      return {};
    });
    ui.onRequest(QA_METHODS.saveSettings, async (raw) => {
      const ws = this.workspace();
      writeSettings(ws.dir, raw as QaSettingsPatch);
      return this.pushState();
    });
    ui.onRequest(QA_METHODS.openReport, async (raw) => {
      const runId = String((raw as { runId?: unknown }).runId ?? '');
      if (!this.folder || !/^[\w-]+$/.test(runId)) throw new Error('No such run.');
      const file = join(this.folder, RESULTS_DIR, runId, 'report.html');
      if (!existsSync(file)) throw new Error('That run has no report.');
      // On this computer — so never for a page reached over the network.
      if (this.deps.lan) throw new Error('Reached over the network: open the report from the computer running Heap QA.');
      openFile(file);
      return {};
    });
    // The shared Settings dialog: one config file, one role table, for all three products.
    const { config, secrets } = this.deps;
    ui.onRequest(QA_METHODS.settings, async () => ({
      personas: [],
      persona: '',
      permissionMode: '',
      subAgents: false,
      nativeToolCalls: true,
      mcpServers: [],
      permissionGrants: [],
      ...(await sharedSettings(config, secrets)),
    }));
    const thenState = async (work: Promise<unknown>): Promise<null> => {
      await work;
      void this.pushState();
      return null;
    };
    ui.onRequest(QA_METHODS.saveProfile, async (raw) => thenState(saveConnection(config, secrets, raw as never)));
    ui.onRequest(QA_METHODS.deleteProfile, async (raw) => thenState(deleteConnection(config, secrets, String((raw as { name?: unknown }).name ?? ''))));
    ui.onRequest(QA_METHODS.useProfile, async (raw) => thenState(config.setActiveProfile(String((raw as { name?: unknown }).name ?? ''))));
    ui.onRequest(QA_METHODS.setRole, async (raw) => {
      const { role, assignment } = raw as { role: UiModelRole; assignment?: { connection: string; model: string } };
      return thenState(setModelRole(config, role, assignment));
    });
    ui.onRequest(QA_METHODS.listConnectionModels, async (raw) => ({
      models: (await connectionModels(config, secrets, String((raw as { connection?: unknown }).connection ?? '')).catch(() => [])).map((m) => m.id),
    }));
    ui.onRequest(QA_METHODS.probeProvider, async (raw) => probeConnection(secrets, (raw ?? {}) as never));
    ui.onRequest(QA_METHODS.setWebSearch, async (raw) => thenState(setWebSearch(config, secrets, raw as never)));
    ui.onRequest(QA_METHODS.runDetail, async (raw) => this.runDetail(String((raw as { runId?: unknown }).runId ?? '')));
    ui.onRequest(QA_METHODS.acceptHeals, async (raw) => this.acceptHeals(String((raw as { runId?: unknown }).runId ?? '')));
    ui.onRequest(QA_METHODS.flowSource, async (raw) => {
      const ws = this.workspace();
      const flow = ws.flows.get(String((raw as { id?: unknown }).id ?? ''));
      if (!flow?.file) throw new Error('No such flow.');
      return { file: flow.file, text: readFileSync(join(ws.dir, flow.file), 'utf8') };
    });
  }

  detach(ui: RpcPeer): void {
    if (this.ui === ui) this.ui = undefined;
  }

  async close(): Promise<void> {
    this.abort?.abort();
    await this.recording?.stop().catch(() => {});
  }

  /**
   * Run files, for the page: `runs/<run id>/<path inside it>` → a file under
   * results/. Reports, screenshots, repro flows. Nothing outside results/.
   */
  async attachment(id: string): Promise<{ bytes: Buffer; mediaType: string } | undefined> {
    if (!this.folder || !id.startsWith('runs/')) return undefined;
    const results = join(this.folder, RESULTS_DIR);
    const full = resolve(results, id.slice('runs/'.length));
    if (!full.startsWith(results + sep) || !existsSync(full)) return undefined;
    // Symlinks pointing out of results/ are not followed.
    if (!realpathSync(full).startsWith(realpathSync(results) + sep)) return undefined;
    return { bytes: readFileSync(full), mediaType: MEDIA[extname(full)] ?? 'application/octet-stream' };
  }

  private workspace(): Workspace {
    if (!this.folder) throw new Error('There is no test folder yet — set one up first.');
    return loadWorkspace(this.folder);
  }

  private emit(event: QaEvent): void {
    this.ui?.notify(QA_METHODS.event, event);
  }

  private async pushState(): Promise<QaState> {
    const state = await this.state();
    this.ui?.notify(QA_METHODS.stateChanged, state);
    return state;
  }

  async state(): Promise<QaState> {
    const profile = await this.deps.config.resolve('agent').catch(() => undefined);
    const base: QaState = {
      root: this.root,
      folderName: basename(this.folder ?? this.root),
      suggestedFolder: join(this.root, 'heapqa'),
      errors: [],
      heal: 'ai',
      flows: [],
      steps: [],
      runs: [],
      lan: this.deps.lan,
      ...(this.busy ? { busy: this.busy } : {}),
      ...(profile?.model ? { model: profile.model, profile: profile.name } : {}),
    };
    if (!this.folder) return base;
    const ws = loadWorkspace(this.folder);
    const runs = listRuns(ws.dir);
    const last = lastStatuses(ws.dir, runs);
    const flows: QaFlowInfo[] = [...ws.flows].map(([id, flow]) => ({
      id,
      name: flow.name,
      file: flow.file ?? `flows/${id}.yaml`,
      steps: flow.steps.length,
      ...(last.get(id) ? { last: last.get(id)! } : {}),
    }));
    return {
      ...base,
      folder: ws.dir,
      errors: ws.errors.map((e) => `${e.file ?? ''}${e.line ? `:${e.line}` : ''} ${e.message}`.trim()),
      ...(ws.config.baseUrl ? { baseUrl: ws.config.baseUrl } : {}),
      heal: ws.config.heal,
      settings: {
        targets: ws.config.targets,
        timeout: ws.config.timeout,
        ...(ws.config.browser.channel ? { channel: ws.config.browser.channel } : {}),
        ...(ws.config.secretsFile ? { secretsFile: ws.config.secretsFile } : {}),
      },
      flows,
      steps: [...ws.steps.keys()],
      runs,
    };
  }

  private beginJob(kind: QaJobKind, label: string, runId?: string): AbortController {
    if (this.busy) throw new Error(`Busy: ${this.busy.label}. Stop it first.`);
    this.busy = { kind, label, startedAt: Date.now(), ...(runId ? { runId } : {}) };
    this.abort = new AbortController();
    void this.pushState();
    return this.abort;
  }

  private finishJob(): void {
    this.busy = undefined;
    this.abort = undefined;
    if (this.pendingRoot) {
      const root = this.pendingRoot;
      this.pendingRoot = undefined;
      this.useRoot(root);
      return;
    }
    void this.pushState();
  }

  /** Live frames, at most ~8 a second: enough to watch, not enough to flood the socket. */
  private frameAt = 0;
  private frame = (data: string): void => {
    const now = Date.now();
    if (now - this.frameAt < 120) return;
    this.frameAt = now;
    this.emit({ type: 'frame', data });
  };

  private async startRun(names: string[], headed = false): Promise<{ runId: string }> {
    const ws = this.workspace();
    if (ws.errors.length) throw new Error(`Fix these first:\n${ws.errors.map((e) => `${e.file ?? ''}${e.line ? `:${e.line}` : ''} ${e.message}`).join('\n')}`);
    const { flows, unknown } = selectFlows(ws, names);
    if (unknown.length) throw new Error(`No flow named ${unknown.join(', ')}.`);
    if (!flows.length) throw new Error('No flows to run yet.');
    const { runId, templates, baseUrl } = prepare(ws);
    const abort = this.beginJob('run', flows.length === 1 ? `Running ${flows[0]![1].name}` : `Running ${flows.length} flows`, runId);
    void (async () => {
      let driver: PlaywrightDriver | undefined;
      try {
        driver = await launchDriver(ws, { headless: !headed });
        abort.signal.addEventListener('abort', () => void driver?.close(), { once: true });
        await driver.screencast(this.frame).catch(() => undefined);
        const model = ws.config.heal === 'ai' ? await resolveAgentModel(this.deps.config, this.deps.secrets) : undefined;
        const { summary } = await runSuite({
          ws,
          flows,
          runId,
          templates,
          ...(baseUrl ? { baseUrl } : {}),
          driver,
          ...(model ? { model } : {}),
          signal: abort.signal,
          events: {
            onFlowStart: (flowId, flow) => this.emit({ type: 'flowStart', runId, flowId, name: flow.name }),
            onStep: (flowId, step) => {
              const { screenshot, visual: _visual, ...rest } = step;
              this.emit({ type: 'step', runId, flowId, step: rest, ...(screenshot?.length ? { shot: `data:image/png;base64,${Buffer.from(screenshot).toString('base64')}` } : {}) });
            },
            healAgentEvents: agentEventStream((event) => this.emit({ type: 'agent', job: 'heal', event })),
            onHealStart: (flowId, req, name) => this.emit({ type: 'healStart', runId, flowId, what: describeLocator(req.locator), model: name }),
            onDiagnosis: (flowId, d) => this.emit({ type: 'diagnosis', runId, flowId, text: d.text }),
            onFlowEnd: (flowId, r) =>
              this.emit({ type: 'flowEnd', runId, flowId, status: r.status, durationMs: r.durationMs, ...(r.error ? { error: r.error } : {}) }),
          },
        });
        this.emit({ type: 'runEnd', runId, passed: summary.passed, failed: summary.failed, healed: summary.flows.reduce((n, f) => n + (f.heals?.length ?? 0), 0) });
      } catch (err) {
        this.emit({ type: 'error', message: message(err) });
      } finally {
        await driver?.close().catch(() => {});
        this.finishJob();
      }
    })();
    return { runId };
  }

  private async startExplore(params: { start?: string; allowCommits?: boolean; ai?: boolean; headed?: boolean }): Promise<{ runId: string }> {
    const ws = this.workspace();
    const judgeWith = params.ai ? await resolveAgentModel(this.deps.config, this.deps.secrets) : undefined;
    if (params.ai && !judgeWith) throw new Error('No model is set for the agent role — set one in Heap Code\'s settings.');
    const { runId, templates, baseUrl } = prepare(ws);
    const start = resolveUrl(params.start || '/', baseUrl);
    if (!isAllowedTarget(start, ws.config.targets)) throw new Error(notAllowedMessage(start));
    const abort = this.beginJob('explore', `Exploring ${start}`, `${runId}-explore`);
    void (async () => {
      let driver: PlaywrightDriver | undefined;
      try {
        driver = await launchDriver(ws, { timeout: Math.min(ws.config.timeout, 5000), headless: params.headed !== true });
        await driver.screencast(this.frame).catch(() => undefined);
        const { result } = await exploreSite({
          ws,
          runId,
          templates,
          ...(baseUrl ? { baseUrl } : {}),
          start,
          driver,
          ...(params.allowCommits ? { allowCommits: true } : {}),
          ...(judgeWith ? { judgeWith } : {}),
          onPage: (url, index) => this.emit({ type: 'page', runId: `${runId}-explore`, url, index }),
          onFinding: (f) => this.emit({ type: 'finding', runId: `${runId}-explore`, severity: f.severity, title: f.title }),
          signal: abort.signal,
        });
        this.emit({
          type: 'exploreEnd',
          runId: `${runId}-explore`,
          findings: result.findings.length,
          high: result.findings.filter((f) => f.severity === 'high').length,
          pages: result.pages.length,
        });
      } catch (err) {
        this.emit({ type: 'error', message: message(err) });
      } finally {
        await driver?.close().catch(() => {});
        this.finishJob();
      }
    })();
    return { runId: `${runId}-explore` };
  }

  private async startRecording(startPath?: string): Promise<Record<string, never>> {
    const ws = this.workspace();
    const { baseUrl } = prepare(ws);
    const start = resolveUrl(startPath || '/', baseUrl);
    if (!isAllowedTarget(start, ws.config.targets)) throw new Error(notAllowedMessage(start));
    this.beginJob('record', `Recording from ${start}`);
    this.pendingRecording = undefined;
    this.recordContext = baseUrl ? { baseUrl } : {};
    try {
      this.recording = await RecordingSession.start(
        ws,
        { start, ...(baseUrl ? { baseUrl } : {}), onFrame: this.frame },
        {
          onStep: (step, count) => this.emit({ type: 'recordStep', label: stepLabel(step), count }),
          onKnownStep: (m) => this.emit({ type: 'recordHint', text: `Steps ${m.from}–${m.to} are your reusable step "${m.use}" — you'll be offered it when you save.` }),
          onFinished: () => this.emit({ type: 'recordFinished', steps: this.recording?.stepCount ?? 0, title: this.recording?.title ?? '' }),
        },
      );
    } catch (err) {
      this.finishJob();
      throw err;
    }
    return {};
  }

  /** Stop watching; hand the page what it needs to ask for a name and choices. */
  private async stopRecording(): Promise<QaRecordStopResult> {
    const session = this.recording;
    if (!session) throw new Error('Nothing is being recorded.');
    await session.stop();
    const ws = this.workspace();
    const suggestedName = session.title.trim().toLowerCase() || 'recording';
    // Named for now; the real name arrives with recordSave.
    const done = session.finish(suggestedName);
    this.pendingRecording = done;
    return {
      steps: done.flow.steps.length,
      suggestedName,
      known: done.known.map((m) => ({
        key: `${m.use}@${m.from}`,
        use: m.use,
        from: m.from,
        to: m.to,
        ...(m.secrets.length ? { note: m.secrets.map(([ours, theirs]) => `types secret ${theirs} where you typed ${ours}`).join('; ') } : {}),
      })),
      secrets: Object.keys(done.secrets),
      secretsFile: ws.config.secretsFile ?? '.env.test',
    };
  }

  private async saveRecording(params: QaRecordSaveParams): Promise<QaRecordSaveResult> {
    const pending = this.pendingRecording;
    if (!pending) throw new Error('There is no recording to save.');
    const ws = this.workspace();
    try {
      const name = params.name.trim() || 'recording';
      const accepted = pending.known.filter((m) => params.use.includes(`${m.use}@${m.from}`));
      const saved = saveFlow(ws, { ...pending.flow, name }, pending.fingerprints, accepted);
      const secretsAdded = params.saveSecrets ? saveSecrets(ws.dir, pending.secrets, ws.config.secretsFile ?? '.env.test') : [];
      const replay = await replayOnce(loadWorkspace(ws.dir), saved.id, saved.flow, { ...this.recordContext, secrets: pending.secrets });
      return { id: saved.id, file: saved.file, replay: { status: replay.status, ...(replay.error ? { error: replay.error } : {}) }, secretsAdded };
    } finally {
      this.pendingRecording = undefined;
      this.recording = undefined;
      this.finishJob();
    }
  }

  private async startTask(params: { task?: string; start?: string; name?: string; headed?: boolean }): Promise<Record<string, never>> {
    const task = (params.task ?? '').trim();
    if (!task) throw new Error('Say what the AI should do.');
    const ws = this.workspace();
    const model = await resolveAgentModel(this.deps.config, this.deps.secrets);
    if (!model) throw new Error('No model is set up for the agent role — set one in Heap Code\'s settings.');
    const { templates, baseUrl } = prepare(ws);
    resolveUrl(params.start || '/', baseUrl);
    const abort = this.beginJob('do', `${model.model}: ${task}`);
    void (async () => {
      try {
        const done = await aiTask({
          ws,
          model,
          task,
          start: params.start || '/',
          ...(baseUrl ? { baseUrl } : {}),
          templates,
          ...(params.name ? { name: params.name } : {}),
          // Asked in the page. No page attached → refused, never assumed.
          confirm: async (description) => {
            if (!this.ui) return false;
            const answer = await this.ui.request<{ allow?: boolean }>(QA_METHODS.confirm, { description }).catch(() => ({ allow: false }));
            return answer.allow === true;
          },
          onAction: (line) => this.emit({ type: 'action', line }),
          agentEvents: agentEventStream((event) => this.emit({ type: 'agent', job: 'do', event })),
          onFrame: this.frame,
          headless: params.headed !== true,
          signal: abort.signal,
        });
        this.emit({
          type: 'doEnd',
          summary: done.summary,
          ...(done.saved ? { saved: relative(ws.dir, done.saved.file) } : {}),
          ...(done.draft ? { draft: relative(ws.dir, done.draft.file), error: done.draft.error } : {}),
          ...(done.notSaved ? { notSaved: done.notSaved } : {}),
        });
      } catch (err) {
        this.emit({ type: 'error', message: message(err) });
      } finally {
        this.finishJob();
      }
    })();
    return {};
  }

  private runDetail(runId: string): QaRunDetail {
    if (!this.folder || !/^[\w-]+$/.test(runId)) throw new Error('No such run.');
    if (runId.endsWith('-explore')) {
      const file = join(this.folder, RESULTS_DIR, runId, 'explore.json');
      if (!existsSync(file)) throw new Error('No such run.');
      return { kind: 'explore', explore: JSON.parse(readFileSync(file, 'utf8')) as ExploreReportInput };
    }
    const found = findRun(this.folder, runId);
    if (typeof found === 'string') throw new Error(found);
    return { kind: 'run', summary: found.summary };
  }

  private async acceptHeals(runId: string): Promise<QaAcceptHealsResult> {
    const detail = this.runDetail(runId);
    if (detail.kind !== 'run') throw new Error('Only test runs heal.');
    const heals = detail.summary.flows.flatMap((f) => f.heals ?? []);
    const applied = applyHeals(this.folder!, heals);
    void this.pushState();
    return { applied: applied.map((a) => ({ file: a.file, step: a.proposal.step, applied: a.applied, ...(a.reason ? { reason: a.reason } : {}) })) };
  }
}

const MEDIA: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
  '.yaml': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

/** The test folder in a workspace: the root itself, or heapqa/ or qa/ under it — whichever has heapqa.yaml. */
export function findFolder(root: string): string | undefined {
  for (const candidate of [root, join(root, 'heapqa'), join(root, 'qa')]) {
    if (existsSync(join(candidate, CONFIG_FILE))) return candidate;
  }
  return undefined;
}

/** Each flow's status in the newest run that included it. */
function lastStatuses(dir: string, runs: ReturnType<typeof listRuns>): Map<string, { status: 'passed' | 'failed'; runId: string }> {
  const out = new Map<string, { status: 'passed' | 'failed'; runId: string }>();
  for (const run of runs) {
    if (run.kind !== 'run') continue;
    const found = findRun(dir, run.id);
    if (typeof found === 'string') continue;
    for (const f of found.summary.flows) if (!out.has(f.id)) out.set(f.id, { status: f.status, runId: run.id });
  }
  return out;
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
}
