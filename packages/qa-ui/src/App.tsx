import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RpcClient } from '@heapcode/web-ui/rpc';
import { Sidebar } from '@heapcode/web-ui/components/Sidebar';
import { ProductToggle, servedProducts } from '@heapcode/web-ui/components/ProductToggle';
import { WorkspacePicker } from '@heapcode/web-ui/components/WorkspacePicker';
import { MessageList } from '@heapcode/web-ui/components/MessageList';
import { Composer } from '@heapcode/web-ui/components/Composer';
import { emptyTranscript, reduce, settle, withNotice, withUserMessage, type Transcript } from '@heapcode/web-ui/transcript';
import {
  QA_METHODS,
  QA_PROTOCOL_VERSION,
  type QaAcceptHealsResult,
  type QaEvent,
  type QaRecordSaveResult,
  type QaRecordStopResult,
  type QaRunDetail,
  type QaState,
  type UiBrowseFoldersResult,
  type UiWorkspacesResult,
} from '@heapcode/qa-host/protocol';

/**
 * Heap QA's page, inside `heapcode web` and the desktop app.
 *
 * Laid out like the test runners people already trust (Cypress, Playwright's
 * UI mode): what is happening on the left — the step log, or the AI's
 * transcript — and the browser itself on the right, live, so nothing runs out
 * of sight. A finished step shows its screenshot when clicked. The AI's work
 * uses Heap Code's own transcript and composer, so it reads the same here as
 * there. All the work is in the host (`@heapcode/qa-host`), the same code the
 * `heapcode qa` command runs.
 */

const RPC_PATH = document.documentElement.dataset.rpcPath ?? '/rpc';
const BASE = RPC_PATH.replace(/\/rpc$/, '');
const RPC_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${RPC_PATH}`;
const HAS_CODE = document.documentElement.dataset.sibling === 'code';
const HAS_CHAT = servedProducts().includes('chat');

type View = 'tests' | 'run' | 'record' | 'explore' | 'ask' | { detail: string };

interface LogRow {
  key: string;
  mark: string;
  tone: 'ok' | 'bad' | 'warn' | 'dim' | 'head';
  text: string;
  depth: number;
  note?: string;
  /** A screenshot of this moment, to show on the right when clicked. */
  shot?: string;
}

interface Job {
  kind: 'run' | 'explore' | 'record' | 'do';
  title: string;
  runId?: string;
  rows: LogRow[];
  done?: string;
  failed?: boolean;
}

interface Pinned {
  shot: string;
  label: string;
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering is a convenience only.
  }
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [state, setState] = useState<QaState>();
  const [view, setView] = useState<View>('tests');
  const [job, setJob] = useState<Job>();
  const [ai, setAi] = useState<Transcript>(emptyTranscript);
  const [heal, setHeal] = useState<Transcript>(emptyTranscript);
  const [frame, setFrame] = useState<string>();
  const [pinned, setPinned] = useState<Pinned>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<{ description: string; decide(allow: boolean): void }>();
  const [headed, setHeaded] = useState(() => remembered('heapqa.headed') === 'true');
  const [railCollapsed, setRailCollapsed] = useState(() => remembered('heapqa.rail') === 'collapsed');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const client = useMemo(() => new RpcClient(RPC_URL, setStatus), []);
  const seq = useRef(0);

  const addRow = useCallback((row: Omit<LogRow, 'key'>) => {
    setJob((j) => (j ? { ...j, rows: [...j.rows, { ...row, key: `r${seq.current++}` }] } : j));
  }, []);

  useEffect(() => {
    client.onNotification(QA_METHODS.stateChanged, (raw) => setState(raw as QaState));
    client.onNotification(QA_METHODS.event, (raw) => {
      const e = raw as QaEvent;
      switch (e.type) {
        case 'frame':
          setFrame(`data:image/jpeg;base64,${e.data}`);
          break;
        case 'agent':
          if (e.job === 'do') setAi((t) => reduce(t, e.event, seq.current++));
          else setHeal((t) => reduce(t, e.event, seq.current++));
          break;
        case 'flowStart':
          addRow({ mark: '', tone: 'head', text: e.name, depth: 0 });
          break;
        case 'step': {
          const s = e.step;
          const mark = s.kind === 'use' ? '↳' : s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '·';
          const tone = s.status === 'failed' ? 'bad' : s.healed ? 'warn' : s.status === 'skipped' ? 'dim' : 'ok';
          const note = [
            s.healed ? `healed by ${s.healed.via === 'similarity' ? `similarity ${Math.round((s.healed.score ?? 0) * 100)}%` : 'the AI'}` : '',
            s.bug ? 'likely an app bug' : '',
            s.status === 'failed' && s.kind !== 'use' ? (s.error ?? '') : '',
          ]
            .filter(Boolean)
            .join(' — ');
          addRow({ mark, tone, text: `${s.path}  ${s.label}`, depth: s.depth + 1, ...(note ? { note } : {}), ...(e.shot ? { shot: e.shot } : {}) });
          break;
        }
        case 'healStart':
          addRow({ mark: '…', tone: 'warn', text: `${e.what} has moved or gone — ${e.model} is looking for it (up to 90s)`, depth: 2 });
          break;
        case 'diagnosis':
          addRow({ mark: '?', tone: 'dim', text: `Likely cause (a guess): ${e.text}`, depth: 1 });
          break;
        case 'flowEnd':
          addRow({ mark: e.status === 'passed' ? '✓' : '✗', tone: e.status === 'passed' ? 'ok' : 'bad', text: e.status === 'passed' ? `passed in ${secs(e.durationMs)}` : `failed — ${e.error ?? ''}`, depth: 1 });
          break;
        case 'runEnd':
          setJob((j) => j && { ...j, runId: e.runId, failed: e.failed > 0, done: `${e.failed ? '✗' : '✓'} ${e.passed}/${e.passed + e.failed} passed${e.healed ? ` · ${e.healed} healed` : ''}` });
          break;
        case 'page':
          addRow({ mark: `${e.index}.`, tone: 'head', text: pathOf(e.url), depth: 0 });
          break;
        case 'finding':
          addRow({ mark: e.severity === 'high' ? '✗' : e.severity === 'medium' ? '!' : '·', tone: e.severity === 'high' ? 'bad' : e.severity === 'medium' ? 'warn' : 'dim', text: e.title, depth: 1 });
          break;
        case 'exploreEnd':
          setJob((j) => j && { ...j, runId: e.runId, failed: e.high > 0, done: e.findings ? `${e.findings} finding${e.findings === 1 ? '' : 's'} (${e.high} high) on ${e.pages} pages` : `Nothing plainly wrong on ${e.pages} pages` });
          break;
        case 'recordStep':
          addRow({ mark: '+', tone: 'ok', text: `${e.count}  ${e.label}`, depth: 0 });
          break;
        case 'recordHint':
          addRow({ mark: '↳', tone: 'dim', text: e.text, depth: 1 });
          break;
        case 'recordFinished':
          setJob((j) => j && { ...j, done: 'finished' });
          break;
        case 'action':
          // The AI's actions already show as tool calls in its transcript.
          break;
        case 'doEnd':
          setAi((t) =>
            withNotice(
              settle(t),
              e.saved ? `Saved ${e.saved} — it replays without the AI.` : e.draft ? `It did not replay (${e.error}). Kept as a draft: ${e.draft}` : (e.notSaved ?? 'Ended.'),
              !e.saved,
            ),
          );
          setJob((j) => j && { ...j, done: e.saved ? 'saved' : 'not saved', failed: !e.saved });
          break;
        case 'error':
          setError(e.message);
          setAi((t) => settle(t));
          setJob((j) => j && { ...j, done: `Stopped: ${e.message}`, failed: true });
          break;
      }
    });
    client.onRequest(QA_METHODS.confirm, async (raw) => {
      const { description } = raw as { description: string };
      return new Promise<{ allow: boolean }>((resolve) => {
        setConfirm({
          description,
          decide: (allow) => {
            setConfirm(undefined);
            resolve({ allow });
          },
        });
      });
    });
    client.onOpen = () => {
      client
        .request<{ state: QaState }>(QA_METHODS.hello, { protocolVersion: QA_PROTOCOL_VERSION })
        .then((hello) => {
          setState(hello.state);
          setError(undefined);
        })
        .catch((e: Error) => setError(e.message));
    };
    client.connect();
    return () => client.close();
  }, [client, addRow]);

  const call = useCallback(
    async <T,>(method: string, params?: unknown): Promise<T | undefined> => {
      try {
        setError(undefined);
        return await client.request<T>(method, params);
      } catch (e) {
        setError((e as Error).message);
        return undefined;
      }
    },
    [client],
  );

  /** A fresh job on the workbench: clears the log, the live view and any pinned step. */
  const begin = (kind: Job['kind'], title: string, to: View): void => {
    setJob({ kind, title, rows: [] });
    setFrame(undefined);
    setPinned(undefined);
    setHeal(emptyTranscript);
    setView(to);
  };

  const startRun = async (flows: string[], title: string): Promise<void> => {
    begin('run', title, 'run');
    if (!(await call(QA_METHODS.run, { flows, headed }))) setJob(undefined);
  };

  // A pinned step belongs to the run it came from: leaving that view lets go of it.
  useEffect(() => {
    if (view !== 'run') setPinned(undefined);
  }, [view]);

  const busy = Boolean(state?.busy);
  const conversations = (state?.runs ?? []).slice(0, 30).map((r) => ({
    id: r.id,
    title:
      r.kind === 'run'
        ? `${r.failed ? '✗' : '✓'} ${r.passed}/${(r.passed ?? 0) + (r.failed ?? 0)} passed${r.healed ? ` · ${r.healed} healed` : ''}`
        : `Explore · ${r.findings ? r.findings.high + r.findings.medium + r.findings.low : 0} findings`,
    updatedAt: Date.parse(r.startedAt) || 0,
    active: typeof view === 'object' && view.detail === r.id,
  }));
  const is = (v: string): boolean => view === v;
  // The browser belongs to the job that showed it: another view starts empty.
  const live = (kind: Job['kind'], hint?: string): JSX.Element => (
    <LivePanel frame={job?.kind === kind ? frame : undefined} pinned={pinned} onUnpin={() => setPinned(undefined)} busy={busy && job?.kind === kind} headed={kind === 'record' || headed} {...(hint ? { hint } : {})} />
  );

  return (
    <div className="app">
      <div className="body">
        <Sidebar
          brand="Heap QA"
          toggle={HAS_CODE ? <ProductToggle current="qa" {...(HAS_CHAT ? { chatPath: '/chat/' } : {})} qaPath={`${BASE}/`} /> : undefined}
          collapsed={railCollapsed}
          onToggleCollapsed={() =>
            setRailCollapsed((v) => {
              remember('heapqa.rail', v ? 'expanded' : 'collapsed');
              return !v;
            })
          }
          conversations={conversations}
          onOpen={(id) => setView({ detail: id })}
          onNew={() => setView('record')}
          busy={false}
          state={{ model: state?.model, profile: state?.profile }}
          status={status}
          onOpenSettings={() => setSettingsOpen(true)}
          extraNav={
            <>
              <RailRow label="Tests" collapsed={railCollapsed} active={is('tests')} onClick={() => setView('tests')} icon={<IconList />} />
              <RailRow label="Ask AI" collapsed={railCollapsed} active={is('ask')} onClick={() => setView('ask')} icon={<IconSpark />} />
              <RailRow label="Explore" collapsed={railCollapsed} active={is('explore')} onClick={() => setView('explore')} icon={<IconCompass />} />
              {job?.kind === 'run' && <RailRow label={busy ? 'Running…' : 'Last run'} collapsed={railCollapsed} active={is('run')} onClick={() => setView('run')} icon={<IconPulse />} />}
            </>
          }
        />
        <main className="qa-main">
          <header className="qa-top">
            {state && (
              <WorkspacePicker
                current={state.folder ?? state.root}
                busy={busy}
                loadWorkspaces={() => client.request<UiWorkspacesResult>(QA_METHODS.workspaces)}
                browse={(path) => client.request<UiBrowseFoldersResult>(QA_METHODS.browseFolders, { path })}
                onPick={async (path) => {
                  // Thrown, not swallowed: the picker shows the failure where it was asked.
                  const next = await client.request<QaState>(QA_METHODS.setRoot, { path });
                  setState(next);
                  setView('tests');
                }}
              />
            )}
            {state?.baseUrl && (
              <span className="qa-chip" title="Where the tests point — baseUrl in heapqa.yaml">
                {state.baseUrl}
              </span>
            )}
            <span className="qa-top-spacer" />
            <label className="qa-switch" title="The live view on the right always shows the browser. Turn this on to also open it as its own window — full size, and you can open its developer tools. Recording always opens one, since you click in it.">
              <input
                type="checkbox"
                role="switch"
                checked={headed}
                onChange={() =>
                  setHeaded((h) => {
                    remember('heapqa.headed', String(!h));
                    return !h;
                  })
                }
              />
              <span className="qa-switch-track" aria-hidden="true" />
              <span>Also open a browser window</span>
            </label>
            {state?.busy && (
              <span className="qa-busy">
                <span className="qa-dot" aria-hidden="true" />
                <span className="qa-busy-label">{state.busy.label}</span>
                {state.busy.kind !== 'record' && (
                  <button className="btn btn-danger" onClick={() => void call(QA_METHODS.stop)}>
                    Stop
                  </button>
                )}
              </span>
            )}
          </header>
          {state?.lan && (
            <div className="banner banner-warn" role="alert">
              <strong>Reached over the network.</strong>
              <span>Browser windows open on the computer running Heap QA, not on this device — the live view still shows them here.</span>
            </div>
          )}
          {status === 'closed' && <div className="banner">Disconnected — reconnecting…</div>}
          {error && (
            <div className="banner banner-error" role="alert">
              {/* The command line's instructions say to edit heapqa.yaml; here there is a button for it. */}
              <span>{/is not listed in heapqa\.yaml/.test(error) ? `${error.split(' To test it')[0]} Allow it here, or under Settings → Other sites tests may open.` : error}</span>
              {state?.settings && /is not listed in heapqa\.yaml/.test(error) && originIn(error) && (
                <button
                  type="button"
                  className="banner-action"
                  onClick={async () => {
                    const origin = originIn(error)!;
                    if (await call(QA_METHODS.saveSettings, { targets: [...(state.settings?.targets ?? []), origin] })) setError(undefined);
                  }}
                >
                  Allow {originIn(error)}
                </button>
              )}
              <button type="button" className="banner-action" onClick={() => setError(undefined)}>
                Dismiss
              </button>
            </div>
          )}

          {!state ? (
            <p className="qa-empty">Connecting…</p>
          ) : !state.folder ? (
            <Setup state={state} onInit={() => void call(QA_METHODS.init)} />
          ) : is('tests') ? (
            <Tests state={state} busy={busy} onRun={startRun} onView={(id) => setView({ detail: id })} call={call} />
          ) : is('run') ? (
            <Workbench left={<RunLog job={job} heal={heal} pinned={pinned} onPin={setPinned} onOpenReport={(id) => setView({ detail: id })} />} live={live('run')} />
          ) : is('record') ? (
            <Workbench
              left={
                <Record
                  state={state} job={job} begin={() => begin('record', 'Recording', 'record')} call={call} onDone={() => {
                    setJob(undefined);
                    setView('tests');
                  }}
                />
              }
              live={live('record', 'Use the browser window that opened — this mirrors it.')}
            />
          ) : is('explore') ? (
            <Workbench
              left={
                <Explore
                  state={state}
                  busy={busy}
                  job={job?.kind === 'explore' ? job : undefined}
                  onOpenReport={(id) => setView({ detail: id })}
                  onReset={() => setJob(undefined)}
                  onStart={async (start, allowCommits, aiLook) => {
                    begin('explore', `Exploring ${start || '/'}`, 'explore');
                    if (!(await call(QA_METHODS.explore, { start, allowCommits, ai: aiLook, headed }))) setJob(undefined);
                  }}
                />
              }
              live={live('explore')}
            />
          ) : is('ask') ? (
            <Workbench
              left={
                <Ask
                  state={state}
                  busy={busy}
                  transcript={ai}
                  onSend={async (task, start) => {
                    begin('do', task, 'ask');
                    setAi((t) => withUserMessage(settle(t), task));
                    if (!(await call(QA_METHODS.do, { task, start, headed }))) {
                      setJob(undefined);
                      setAi((t) => settle(t));
                    }
                  }}
                  onStop={() => void call(QA_METHODS.stop)}
                />
              }
              live={live('do')}
            />
          ) : typeof view === 'object' ? (
            <Detail runId={view.detail} call={call} lan={state.lan} />
          ) : null}
        </main>
      </div>
      {confirm && (
        <div className="modal-scrim">
          <div className="modal modal-sm" role="dialog" aria-modal="true" aria-label="Allow this action?">
            <div className="modal-head">Allow this action?</div>
            <div className="modal-body">
              <p>{confirm.description}</p>
              <p className="qa-muted">It reads like it commits something. Only allow it on test data you can lose.</p>
              <div className="form-actions">
                <button className="btn" onClick={() => confirm.decide(false)}>
                  Don't allow
                </button>
                <button className="btn btn-danger" onClick={() => confirm.decide(true)}>
                  Allow
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {settingsOpen && state && <SettingsDialog state={state} request={(m, p) => client.request(m, p)} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

type Call = <T>(method: string, params?: unknown) => Promise<T | undefined>;

/** What is happening on the left, the browser on the right. */
function Workbench({ left, live }: { left: ReactNode; live: ReactNode }): JSX.Element {
  return (
    <div className="qa-bench">
      <section className="qa-bench-left">{left}</section>
      <section className="qa-bench-right">{live}</section>
    </div>
  );
}

function LivePanel({ frame, pinned, onUnpin, busy, headed, hint }: { frame?: string; pinned?: Pinned; onUnpin(): void; busy: boolean; headed: boolean; hint?: string }): JSX.Element {
  const src = pinned?.shot ?? frame;
  return (
    <div className="qa-live">
      <div className="qa-live-bar">
        {pinned ? (
          <>
            <span className="qa-live-tag qa-live-tag-pinned">Step</span>
            <span className="qa-live-title">{pinned.label}</span>
            <button className="btn btn-quiet" onClick={onUnpin}>
              Back to live
            </button>
          </>
        ) : (
          <>
            <span className={`qa-live-tag ${busy ? 'qa-live-tag-on' : ''}`}>{busy ? 'Live' : 'Browser'}</span>
            <span className="qa-live-title">{busy ? (hint ?? (headed ? 'Also open in its own window' : 'Running hidden — this is what it sees')) : src ? 'The last thing it showed' : ''}</span>
          </>
        )}
      </div>
      <div className="qa-live-view">
        {src ? (
          <img src={src} alt={pinned ? `The page after: ${pinned.label}` : 'The browser'} />
        ) : (
          <p className="qa-live-empty">The browser shows here while a test runs, while you record or explore, and while the AI works — so you can see exactly what it does.</p>
        )}
      </div>
    </div>
  );
}

function Setup({ state, onInit }: { state: QaState; onInit(): void }): JSX.Element {
  return (
    <div className="qa-page">
      <section className="qa-hero">
        <h1 className="qa-title">Test your app with Heap QA</h1>
        <p>Heap QA keeps tests as readable files in a test folder: settings, tests and reusable steps. {state.folderName} has none yet.</p>
        <p className="qa-muted">Pick another folder above, or make one at {state.suggestedFolder} — with an example test and a .gitignore for results and test passwords.</p>
        <button className="btn btn-primary" onClick={onInit}>
          Set up a test folder here
        </button>
      </section>
    </div>
  );
}

function Tests({ state, busy, onRun, onView, call }: { state: QaState; busy: boolean; onRun(flows: string[], title: string): void; onView(runId: string): void; call: Call }): JSX.Element {
  const [source, setSource] = useState<{ file: string; text: string }>();
  const blocked = busy || state.errors.length > 0;
  return (
    <div className="qa-page">
      <div className="qa-head">
        <div>
          <h1 className="qa-title">Tests</h1>
          <p className="qa-muted">
            {state.flows.length} test{state.flows.length === 1 ? '' : 's'}
            {state.steps.length ? ` · reusable steps: ${state.steps.join(', ')}` : ''} · {state.folder}
          </p>
        </div>
        <button className="btn btn-primary" disabled={blocked || !state.flows.length} onClick={() => onRun([], `Running ${state.flows.length} tests`)}>
          Run all
        </button>
      </div>
      {state.errors.length > 0 && (
        <div className="banner banner-error qa-errors">
          <strong>Fix these first:</strong>
          <ul>
            {state.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {state.flows.length === 0 ? (
        <p className="qa-muted">No tests yet. Record one with New test, or have the AI write one with Ask AI.</p>
      ) : (
        <table className="qa-table">
          <thead>
            <tr>
              <th aria-label="Last result" />
              <th>Test</th>
              <th className="qa-file">File</th>
              <th className="qa-num">Steps</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {state.flows.map((f) => (
              <tr key={f.id}>
                <td>
                  <span className={`qa-status ${f.last ? `qa-${f.last.status}` : ''}`} title={f.last ? `${f.last.status} in the last run` : 'not run yet'}>
                    {f.last ? (f.last.status === 'passed' ? '✓' : '✗') : '·'}
                  </span>
                </td>
                <td className="qa-name">{f.name}</td>
                <td className="qa-muted qa-file">{f.file}</td>
                <td className="qa-num">{f.steps}</td>
                <td className="qa-actions">
                  {f.last && (
                    <button className="btn btn-quiet" onClick={() => onView(f.last!.runId)}>
                      Last report
                    </button>
                  )}
                  <button
                    className="btn btn-quiet"
                    onClick={async () => {
                      const r = await call<{ file: string; text: string }>(QA_METHODS.flowSource, { id: f.id });
                      if (r) setSource(r);
                    }}
                  >
                    View
                  </button>
                  <button className="btn" disabled={blocked} onClick={() => onRun([f.id], `Running ${f.name}`)}>
                    Run
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {source && (
        <div className="qa-source">
          <div className="qa-head">
            <span className="qa-muted">{source.file}</span>
            <button className="btn btn-quiet" onClick={() => setSource(undefined)}>
              Close
            </button>
          </div>
          <pre>{source.text}</pre>
        </div>
      )}
    </div>
  );
}

function RunLog({ job, heal, pinned, onPin, onOpenReport }: { job?: Job; heal: Transcript; pinned?: Pinned; onPin(p: Pinned): void; onOpenReport(runId: string): void }): JSX.Element {
  if (!job) return <p className="qa-empty">Nothing has run yet — run a test from Tests.</p>;
  return (
    <div className="qa-log-wrap">
      <div className="qa-log-head">
        <h2 className="qa-subtitle">{job.done ? job.title.replace(/^Running /, 'Ran ') : job.title}</h2>
        {job.done && job.runId && (
          <button className="btn btn-primary" onClick={() => onOpenReport(job.runId!)}>
            Open report
          </button>
        )}
      </div>
      <Log rows={job.rows} pinned={pinned} onPin={onPin} />
      {heal.items.length > 0 && (
        <details className="qa-heal" open>
          <summary>What the AI did while healing</summary>
          <MessageList transcript={heal} />
        </details>
      )}
      {job.done ? <p className={job.failed ? 'qa-done qa-bad' : 'qa-done'}>{job.done}</p> : <p className="qa-muted qa-working">Working…</p>}
      {job.rows.some((r) => r.shot) && <p className="qa-muted qa-tip">Click a step to see the page right after it.</p>}
    </div>
  );
}

function Log({ rows, pinned, onPin }: { rows: LogRow[]; pinned?: Pinned; onPin?(p: Pinned): void }): JSX.Element {
  const end = useRef<HTMLLIElement>(null);
  // A block body on purpose: newer browsers return a promise from scrollIntoView,
  // and an effect that returns anything but a function crashes React on cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [rows.length]);
  return (
    <ol className="qa-log">
      {rows.map((r) => {
        const content = (
          <>
            <span className="qa-mark" aria-hidden="true">
              {r.mark}
            </span>
            <span className="qa-log-text">
              {r.text}
              {r.note && <span className="qa-note">{r.note}</span>}
            </span>
            {r.shot && <span className="qa-shot-dot" title="Has a screenshot" aria-hidden="true" />}
          </>
        );
        return (
          <li key={r.key} className={`qa-row qa-tone-${r.tone} ${pinned && pinned.shot === r.shot ? 'qa-row-pinned' : ''}`} style={{ paddingLeft: `${8 + r.depth * 16}px` }}>
            {r.shot && onPin ? (
              <button className="qa-row-btn" onClick={() => onPin({ shot: r.shot!, label: r.text.trim() })}>
                {content}
              </button>
            ) : (
              <span className="qa-row-btn qa-row-static">{content}</span>
            )}
          </li>
        );
      })}
      <li ref={end} className="qa-log-end" aria-hidden="true" />
    </ol>
  );
}

function Detail({ runId, call, lan }: { runId: string; call: Call; lan: boolean }): JSX.Element {
  const [detail, setDetail] = useState<QaRunDetail>();
  const [applied, setApplied] = useState<QaAcceptHealsResult>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setDetail(undefined);
    setApplied(undefined);
    void call<QaRunDetail>(QA_METHODS.runDetail, { runId }).then((d) => d && setDetail(d));
  }, [runId, call]);
  const heals = detail?.kind === 'run' ? detail.summary.flows.reduce((n, f) => n + (f.heals?.length ?? 0), 0) : 0;
  const done = applied?.applied.filter((a) => a.applied).length ?? 0;
  return (
    <div className="qa-detail">
      <div className="qa-head qa-detail-head">
        <div>
          <h1 className="qa-title">{detail?.kind === 'explore' ? 'Explore report' : 'Test report'}</h1>
          <p className="qa-muted">{runId}</p>
        </div>
        <span className="qa-row-actions">
          {heals > 0 && !applied && (
            <button
              className="btn btn-primary"
              onClick={async () => {
                const r = await call<QaAcceptHealsResult>(QA_METHODS.acceptHeals, { runId });
                if (r) {
                  setApplied(r);
                  setVersion((v) => v + 1);
                }
              }}
            >
              Accept {heals} fix{heals === 1 ? '' : 'es'}
            </button>
          )}
          {lan ? (
            // Reached over the network: this browser has the sign-in cookie, so a tab works.
            <a className="btn btn-quiet" href={`${BASE}/attachment/runs/${runId}/report.html`} target="_blank" rel="noreferrer">
              Open in a tab
            </a>
          ) : (
            // The file, not a link: from the desktop app a link opens in a browser that is not signed in.
            <button className="btn btn-quiet" onClick={() => void call(QA_METHODS.openReport, { runId })}>
              Open in browser
            </button>
          )}
        </span>
      </div>
      {applied && (
        <div className="banner">
          <span>
            {done} fix{done === 1 ? '' : 'es'} written into the files
            {applied.applied.some((a) => !a.applied) ? `; skipped: ${applied.applied.filter((a) => !a.applied).map((a) => `${a.file} step ${a.step} (${a.reason})`).join(', ')}` : ''}.
          </span>
        </div>
      )}
      {/* No scripts run in the report (no allow-scripts); same-origin only so its screenshots load with the session cookie. */}
      <iframe key={version} className="qa-report" title="Report" sandbox="allow-same-origin allow-popups" src={`${BASE}/attachment/runs/${runId}/report.html`} />
    </div>
  );
}

function Record({ state, job, begin, call, onDone }: { state: QaState; job?: Job; begin(): void; call: Call; onDone(): void }): JSX.Element {
  const [start, setStart] = useState('/');
  const [stopped, setStopped] = useState<QaRecordStopResult>();
  const [name, setName] = useState('');
  const [use, setUse] = useState<string[]>([]);
  const [keepSecrets, setKeepSecrets] = useState(true);
  const [saved, setSaved] = useState<QaRecordSaveResult>();
  const recording = state.busy?.kind === 'record';

  const stop = async (): Promise<void> => {
    const r = await call<QaRecordStopResult>(QA_METHODS.recordStop);
    if (!r) return;
    setStopped(r);
    setName(r.suggestedName);
    setUse(r.known.map((k) => k.key));
  };
  const discard = async (): Promise<void> => {
    await call(QA_METHODS.recordDiscard);
    setStopped(undefined);
  };
  // Done pressed in the browser: go straight to saving.
  useEffect(() => {
    if (recording && job?.kind === 'record' && job.done === 'finished' && !stopped) void stop();
  }, [job?.done]); // eslint-disable-line react-hooks/exhaustive-deps

  if (saved) {
    return (
      <div className="qa-pane">
        <h2 className="qa-subtitle">Saved {saved.file.split('/').pop()}</h2>
        <p className={saved.replay.status === 'passed' ? 'qa-done' : 'qa-done qa-bad'}>
          {saved.replay.status === 'passed' ? '✓ It plays back without you.' : `✗ Playback failed — ${saved.replay.error}. The test is saved; edit it or record again.`}
        </p>
        {saved.secretsAdded.length > 0 && <p className="qa-muted">Added {saved.secretsAdded.join(', ')} to the secrets file.</p>}
        <button
          className="btn btn-primary"
          onClick={() => {
            setSaved(undefined);
            setStopped(undefined);
            onDone();
          }}
        >
          Back to tests
        </button>
      </div>
    );
  }

  if (stopped) {
    return (
      <div className="qa-pane">
        <h2 className="qa-subtitle">Save the recording</h2>
        {stopped.steps <= 1 ? (
          <>
            <p>Nothing was recorded.</p>
            <button className="btn" onClick={() => void discard()}>
              Close
            </button>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Name</span>
              <input className="card-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {stopped.known.length > 0 && (
              <fieldset className="qa-fieldset">
                <legend className="field-label">These steps repeat reusable steps you have</legend>
                {stopped.known.map((k) => (
                  <label key={k.key} className="qa-check">
                    <input type="checkbox" checked={use.includes(k.key)} onChange={(e) => setUse((u) => (e.target.checked ? [...u, k.key] : u.filter((x) => x !== k.key)))} />
                    Steps {k.from}–{k.to} → use <code>{k.use}</code>
                    {k.note && <span className="qa-muted"> ({k.note})</span>}
                  </label>
                ))}
              </fieldset>
            )}
            {stopped.secrets.length > 0 && (
              <label className="qa-check">
                <input type="checkbox" checked={keepSecrets} onChange={(e) => setKeepSecrets(e.target.checked)} />
                Save the typed {stopped.secrets.join(', ')} to {stopped.secretsFile} so the test can replay (it stays out of git)
              </label>
            )}
            <div className="form-actions">
              <button className="btn" onClick={() => void discard()}>
                Discard
              </button>
              <button
                className="btn btn-primary"
                disabled={!name.trim()}
                onClick={async () => {
                  const r = await call<QaRecordSaveResult>(QA_METHODS.recordSave, { name, use, saveSecrets: keepSecrets });
                  if (r) setSaved(r);
                }}
              >
                Save and play back
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (recording && job?.kind === 'record') {
    return (
      <div className="qa-log-wrap">
        <div className="qa-log-head">
          <h2 className="qa-subtitle">Recording</h2>
          <button className="btn btn-primary" onClick={() => void stop()}>
            Stop and save
          </button>
        </div>
        <p className="qa-muted">Use your app in the browser window that opened. Its bar at the bottom right adds checks. Press Done there, or Stop and save here.</p>
        <Log rows={job.rows} />
      </div>
    );
  }

  return (
    <div className="qa-pane">
      <h2 className="qa-subtitle">New test</h2>
      <p>Click through your app once in a browser window; Heap QA writes the test as you go, then plays it back to prove it works.</p>
      <label className="field">
        <span className="field-label">Start at</span>
        <input className="card-input" value={start} onChange={(e) => setStart(e.target.value)} placeholder="/login" />
        <span className="field-hint">A path on {state.baseUrl ?? 'your app'}, or a full address the tests may reach.</span>
      </label>
      <button
        className="btn btn-primary"
        disabled={Boolean(state.busy)}
        onClick={async () => {
          begin();
          await call(QA_METHODS.record, { start });
        }}
      >
        Start recording
      </button>
    </div>
  );
}

function Explore({ state, busy, job, onStart, onOpenReport, onReset }: { state: QaState; busy: boolean; job?: Job; onStart(start: string, allowCommits: boolean, ai: boolean): void; onOpenReport(runId: string): void; onReset(): void }): JSX.Element {
  const [start, setStart] = useState('/');
  const [allow, setAllow] = useState(false);
  const [ai, setAi] = useState(false);
  if (job) {
    return (
      <div className="qa-log-wrap">
        <div className="qa-log-head">
          <h2 className="qa-subtitle">{job.done ? job.title.replace(/^Exploring /, 'Explored ') : job.title}</h2>
          {job.done && (
            <span className="qa-row-actions">
              <button className="btn btn-quiet" onClick={onReset}>
                Explore again
              </button>
              {job.runId && (
                <button className="btn btn-primary" onClick={() => onOpenReport(job.runId!)}>
                  Open report
                </button>
              )}
            </span>
          )}
        </div>
        <Log rows={job.rows} />
        {job.done ? <p className={job.failed ? 'qa-done qa-bad' : 'qa-done'}>{job.done}</p> : <p className="qa-muted qa-working">Working…</p>}
      </div>
    );
  }
  return (
    <div className="qa-pane">
      <h2 className="qa-subtitle">Explore</h2>
      <p>Find bugs with no test written: Heap QA visits every page it can reach, presses what is safe to press, fills forms with ordinary and awkward input, and reports what is plainly wrong — server errors, broken links, crashes, error text, layouts too wide for a phone, buttons that do nothing.</p>
      <label className="field">
        <span className="field-label">Start at</span>
        <input className="card-input" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="qa-check">
        <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
        Also press Delete, Pay, Submit-like buttons — only on data you can lose
      </label>
      {state.model && (
        <label className="qa-check">
          <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
          Also have {state.model} look at each page for what no rule catches (labelled as the AI's)
        </label>
      )}
      <button className="btn btn-primary" disabled={busy} onClick={() => onStart(start, allow, ai)}>
        Explore
      </button>
    </div>
  );
}

function Ask({ state, busy, transcript, onSend, onStop }: { state: QaState; busy: boolean; transcript: Transcript; onSend(task: string, start: string): void; onStop(): void }): JSX.Element {
  const [start, setStart] = useState('/');
  const working = state.busy?.kind === 'do';
  return (
    <div className="qa-ask">
      {!state.model && <div className="banner banner-warn">No model is set for the agent role — set one in Heap Code's settings.</div>}
      <div className="qa-ask-messages">
        <MessageList
          transcript={transcript}
          busy={working}
          {...(working && state.busy ? { runStartedAt: state.busy.startedAt } : {})}
          empty={{
            title: 'Ask the AI to write a test',
            body: 'Say what to do in your app — "log in as ai@example.test with the test password, then check you are welcomed". It works in a browser you can watch on the right; what worked becomes a test that replays without the AI, saved only if it does.',
          }}
        />
      </div>
      <Composer
        onSend={(text) => onSend(text, start)}
        onCancel={onStop}
        busy={working}
        disabled={!state.model || (busy && !working)}
        placeholder="What should the AI do in your app?"
        footer={
          <label className="qa-start" title="Where the AI starts, on your app">
            <span className="qa-muted">Start at</span>
            <input className="qa-start-input" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
        }
      />
    </div>
  );
}

function SettingsDialog({ state, request, onClose }: { state: QaState; request(method: string, params: unknown): Promise<unknown>; onClose(): void }): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(state.baseUrl ?? '');
  const [targets, setTargets] = useState((state.settings?.targets ?? []).join('\n'));
  const [heal, setHeal] = useState(state.heal);
  const [timeout, setTimeoutSecs] = useState(String((state.settings?.timeout ?? 10_000) / 1000));
  const [channel, setChannel] = useState(state.settings?.channel ?? '');
  const [secretsFile, setSecretsFile] = useState(state.settings?.secretsFile ?? '');
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const editable = Boolean(state.folder);

  const save = async (): Promise<void> => {
    const secs = Number(timeout);
    if (!Number.isFinite(secs) || secs <= 0) return setProblem('A step may wait a number of seconds, more than 0.');
    setSaving(true);
    setProblem(undefined);
    try {
      // Straight to the client, not `call`: a refusal belongs in this dialog, not the page banner.
      await request(QA_METHODS.saveSettings, {
        baseUrl,
        targets: targets.split(/[\n,]/).map((t) => t.trim()).filter(Boolean),
        heal,
        timeout: Math.round(secs * 1000),
        channel: channel || undefined,
        secretsFile,
      });
      onClose();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Heap QA settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Heap QA settings</div>
        <div className="modal-body qa-settings">
          {!editable ? (
            <p className="qa-muted">Set up a test folder first — settings are saved in it.</p>
          ) : (
            <>
              <label className="field">
                <span className="field-label">Your app's address</span>
                <input className="card-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:3000" />
                <span className="field-hint">Where tests start. Paths like /login are on this address.</span>
              </label>
              <label className="field">
                <span className="field-label">Other sites tests may open</span>
                <textarea className="card-input qa-textarea" value={targets} onChange={(e) => setTargets(e.target.value)} placeholder={'https://staging.example.com\nhttps://*.vercel.app'} />
                <span className="field-hint">One per line. Your own computer (localhost) is always allowed; anything else must be listed, so a test never wanders onto a site by mistake.</span>
              </label>
              <label className="field">
                <span className="field-label">When a button or field has moved</span>
                <select className="card-input" value={heal} onChange={(e) => setHeal(e.target.value as QaState['heal'])}>
                  <option value="ai">Find it by likeness, then ask the AI</option>
                  <option value="similarity">Find it by likeness only (no AI)</option>
                  <option value="off">Fail the test</option>
                </select>
              </label>
              <div className="qa-settings-row">
                <label className="field">
                  <span className="field-label">Wait per step (seconds)</span>
                  <input className="card-input" inputMode="decimal" value={timeout} onChange={(e) => setTimeoutSecs(e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">Browser</span>
                  <select className="card-input" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                    <option value="">Automatic</option>
                    <option value="chrome">Chrome</option>
                    <option value="msedge">Edge</option>
                    <option value="chromium">Chromium (Playwright's own)</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span className="field-label">Test passwords file</span>
                <input className="card-input" value={secretsFile} onChange={(e) => setSecretsFile(e.target.value)} placeholder=".env.test" />
                <span className="field-hint">Inside the test folder and kept out of git. Tests use its values as {'{{secret:NAME}}'}.</span>
              </label>
            </>
          )}
          <dl className="qa-facts">
            <dt>Test folder</dt>
            <dd>{state.folder ?? 'none yet'}</dd>
            <dt>AI model</dt>
            <dd>{state.model ? `${state.model} on ${state.profile}` : 'none set'} — shared with Heap Code{HAS_CODE ? <>; <a href="/">change it there</a></> : ''}</dd>
          </dl>
          {problem && <p className="qa-bad">{problem}</p>}
          <div className="form-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            {editable && (
              <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
                Save
              </button>
            )}
          </div>
          <p className="qa-muted">Saved in heapqa.yaml in the test folder, so the command line and CI use the same settings.</p>
        </div>
      </div>
    </div>
  );
}

function RailRow({ label, icon, collapsed, active, onClick }: { label: string; icon: ReactNode; collapsed: boolean; active?: boolean; onClick(): void }): JSX.Element {
  return (
    <button className={`rail-item ${active ? 'rail-item-active' : ''}`} onClick={onClick} aria-label={collapsed ? label : undefined}>
      <span className="rail-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="rail-label">{label}</span>
      {collapsed && (
        <span className="rail-tip" aria-hidden="true">
          {label}
        </span>
      )}
    </button>
  );
}

/** The address an "is not listed" refusal names, as an origin to allow. */
function originIn(message: string): string | undefined {
  const m = /(https?:\/\/[^\s/]+)/.exec(message);
  return m?.[1];
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function secs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const svg = { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const;
function IconList(): JSX.Element {
  return (
    <svg {...svg}>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" strokeLinecap="round" />
    </svg>
  );
}
function IconCompass(): JSX.Element {
  return (
    <svg {...svg}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m10.3 5.7-1.4 3.2-3.2 1.4 1.4-3.2z" strokeLinejoin="round" />
    </svg>
  );
}
function IconSpark(): JSX.Element {
  return (
    <svg {...svg}>
      <path d="M8 2.5 9.2 6.8 13.5 8l-4.3 1.2L8 13.5 6.8 9.2 2.5 8l4.3-1.2z" strokeLinejoin="round" />
    </svg>
  );
}
function IconPulse(): JSX.Element {
  return (
    <svg {...svg}>
      <path d="M2 8h3l1.5-3.5 3 7L11 8h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
