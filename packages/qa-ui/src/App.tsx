import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RpcClient } from '@heapcode/web-ui/rpc';
import { Sidebar } from '@heapcode/web-ui/components/Sidebar';
import { ProductToggle, servedProducts } from '@heapcode/web-ui/components/ProductToggle';
import {
  QA_METHODS,
  QA_PROTOCOL_VERSION,
  type QaAcceptHealsResult,
  type QaEvent,
  type QaRecordSaveResult,
  type QaRecordStopResult,
  type QaRunDetail,
  type QaState,
} from '@heapcode/qa-host/protocol';

/**
 * Heap QA's page, inside `heapcode web` (and so inside the desktop app).
 *
 * The shell is Heap Code's — rail, buttons, banners, the stylesheet — used,
 * not imitated, like Heap Chat. What is this product's: the tests list, live
 * progress of a run, the report, recording, exploring and AI-written tests.
 * All of the work happens in the host (`@heapcode/qa-host`), the same code
 * the `heapcode qa` command runs; this page starts it and shows it.
 */

const RPC_PATH = document.documentElement.dataset.rpcPath ?? '/rpc';
const BASE = RPC_PATH.replace(/\/rpc$/, '');
const RPC_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${RPC_PATH}`;
const HAS_CODE = document.documentElement.dataset.sibling === 'code';
const HAS_CHAT = servedProducts().includes('chat');

type View = { name: 'tests' } | { name: 'live' } | { name: 'detail'; runId: string } | { name: 'record' } | { name: 'explore' } | { name: 'ask' };

interface LiveLine {
  key: string;
  mark: string;
  tone: 'ok' | 'bad' | 'warn' | 'dim';
  text: string;
  depth: number;
  note?: string;
}

interface Live {
  kind: 'run' | 'explore' | 'record' | 'do';
  title: string;
  runId?: string;
  lines: LiveLine[];
  /** Set when the job ended: a one-line result. */
  done?: string;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [state, setState] = useState<QaState>();
  const [view, setView] = useState<View>({ name: 'tests' });
  const [live, setLive] = useState<Live>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<{ description: string; decide(allow: boolean): void }>();
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem('heapqa.rail') === 'collapsed');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const client = useMemo(() => new RpcClient(RPC_URL, setStatus), []);
  const seq = useRef(0);

  const addLine = useCallback((line: Omit<LiveLine, 'key'>) => {
    setLive((l) => (l ? { ...l, lines: [...l.lines, { ...line, key: `l${seq.current++}` }] } : l));
  }, []);

  useEffect(() => {
    client.onNotification(QA_METHODS.stateChanged, (raw) => setState(raw as QaState));
    client.onNotification(QA_METHODS.event, (raw) => {
      const e = raw as QaEvent;
      switch (e.type) {
        case 'flowStart':
          addLine({ mark: '▸', tone: 'dim', text: e.name, depth: 0 });
          break;
        case 'step': {
          const s = e.step;
          const mark = s.kind === 'use' ? '↳' : s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '·';
          const tone = s.status === 'failed' ? 'bad' : s.healed ? 'warn' : s.status === 'skipped' ? 'dim' : 'ok';
          const note = [
            s.healed ? `healed by ${s.healed.via === 'similarity' ? `similarity ${Math.round((s.healed.score ?? 0) * 100)}%` : 'the AI'}` : '',
            s.bug ? 'likely an app bug' : '',
            s.status === 'failed' && s.kind !== 'use' ? s.error ?? '' : '',
          ]
            .filter(Boolean)
            .join(' — ');
          addLine({ mark, tone, text: `${s.path}  ${s.label}`, depth: s.depth + 1, ...(note ? { note } : {}) });
          break;
        }
        case 'healStart':
          addLine({ mark: '…', tone: 'warn', text: `${e.what} has moved or gone — ${e.model} is looking for it (up to 90s)`, depth: 2 });
          break;
        case 'diagnosis':
          addLine({ mark: '?', tone: 'dim', text: `Likely cause (a guess): ${e.text}`, depth: 1 });
          break;
        case 'flowEnd':
          addLine({ mark: e.status === 'passed' ? '✓' : '✗', tone: e.status === 'passed' ? 'ok' : 'bad', text: e.status === 'passed' ? `passed in ${secs(e.durationMs)}` : `failed — ${e.error ?? ''}`, depth: 1 });
          break;
        case 'runEnd':
          setLive((l) => l && { ...l, runId: e.runId, done: `${e.failed ? '✗' : '✓'} ${e.passed}/${e.passed + e.failed} passed${e.healed ? ` · ${e.healed} healed` : ''}` });
          break;
        case 'page':
          addLine({ mark: `${e.index}.`, tone: 'dim', text: pathOf(e.url), depth: 0 });
          break;
        case 'finding':
          addLine({ mark: e.severity === 'high' ? '✗' : e.severity === 'medium' ? '!' : '·', tone: e.severity === 'high' ? 'bad' : e.severity === 'medium' ? 'warn' : 'dim', text: e.title, depth: 1 });
          break;
        case 'exploreEnd':
          setLive((l) => l && { ...l, runId: e.runId, done: e.findings ? `${e.findings} finding${e.findings === 1 ? '' : 's'} (${e.high} high) on ${e.pages} pages` : `Nothing plainly wrong on ${e.pages} pages` });
          break;
        case 'recordStep':
          addLine({ mark: '+', tone: 'ok', text: `${e.count}  ${e.label}`, depth: 0 });
          break;
        case 'recordHint':
          addLine({ mark: '↳', tone: 'dim', text: e.text, depth: 1 });
          break;
        case 'recordFinished':
          setLive((l) => l && { ...l, done: 'finished' });
          break;
        case 'action':
          addLine({ mark: '•', tone: 'ok', text: e.line, depth: 0 });
          break;
        case 'doEnd':
          setLive((l) => l && { ...l, done: e.saved ? `✓ Saved ${e.saved} — it replays without the AI.` : e.draft ? `✗ It did not replay (${e.error}). Kept as a draft: ${e.draft}` : (e.notSaved ?? 'Ended.'), lines: [...l.lines, { key: `l${seq.current++}`, mark: '', tone: 'dim', text: e.summary, depth: 0 }] });
          break;
        case 'error':
          setError(e.message);
          setLive((l) => l && { ...l, done: `Stopped: ${e.message}` });
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
  }, [client, addLine]);

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

  const startRun = async (flows: string[], title: string): Promise<void> => {
    setLive({ kind: 'run', title, lines: [] });
    setView({ name: 'live' });
    const r = await call<{ runId: string }>(QA_METHODS.run, { flows });
    if (!r) setLive(undefined);
  };

  const busy = Boolean(state?.busy);
  const runs = state?.runs ?? [];
  const conversations = runs.slice(0, 30).map((r) => ({
    id: r.id,
    title:
      r.kind === 'run'
        ? `${r.failed ? '✗' : '✓'} ${r.passed}/${(r.passed ?? 0) + (r.failed ?? 0)} passed${r.healed ? ` · ${r.healed} healed` : ''}`
        : `Explore · ${r.findings ? r.findings.high + r.findings.medium + r.findings.low : 0} findings`,
    updatedAt: Date.parse(r.startedAt) || 0,
    active: view.name === 'detail' && view.runId === r.id,
  }));

  return (
    <div className="app">
      <div className="body">
        <Sidebar
          brand="Heap QA"
          toggle={HAS_CODE ? <ProductToggle current="qa" {...(HAS_CHAT ? { chatPath: '/chat/' } : {})} qaPath={`${BASE}/`} /> : undefined}
          collapsed={railCollapsed}
          onToggleCollapsed={() =>
            setRailCollapsed((v) => {
              localStorage.setItem('heapqa.rail', v ? 'expanded' : 'collapsed');
              return !v;
            })
          }
          conversations={conversations}
          onOpen={(id) => setView({ name: 'detail', runId: id })}
          onNew={() => setView({ name: 'record' })}
          busy={false}
          state={{ model: state?.model, profile: state?.profile }}
          status={status}
          onOpenSettings={() => setSettingsOpen(true)}
          extraNav={
            <>
              <RailRow label="Tests" collapsed={railCollapsed} active={view.name === 'tests'} onClick={() => setView({ name: 'tests' })} icon={<IconList />} />
              <RailRow label="Explore" collapsed={railCollapsed} active={view.name === 'explore'} onClick={() => setView({ name: 'explore' })} icon={<IconCompass />} />
              <RailRow label="Ask AI" collapsed={railCollapsed} active={view.name === 'ask'} onClick={() => setView({ name: 'ask' })} icon={<IconSpark />} />
              {live && <RailRow label={busy ? 'Running…' : 'Last job'} collapsed={railCollapsed} active={view.name === 'live'} onClick={() => setView({ name: 'live' })} icon={<IconPulse />} />}
            </>
          }
        />
        <main className="chat qa-main">
          {state?.lan && (
            <div className="banner banner-warn" role="alert">
              <strong>Reached over the network.</strong>
              <span>Recording and AI runs open a browser on the computer running Heap QA, not on this device.</span>
            </div>
          )}
          {status === 'closed' && <div className="banner">Disconnected — reconnecting…</div>}
          {error && (
            <div className="banner banner-error" role="alert">
              <span>{error}</span>
              <button type="button" className="banner-action" onClick={() => setError(undefined)}>
                Dismiss
              </button>
            </div>
          )}
          {state?.busy && view.name !== 'live' && view.name !== 'record' && (
            <div className="banner">
              <span>{state.busy.label}</span>
              <button type="button" className="banner-action" onClick={() => setView(state.busy?.kind === 'record' ? { name: 'record' } : { name: 'live' })}>
                Show
              </button>
            </div>
          )}
          <div className="qa-scroll">
            {!state ? (
              <p className="qa-muted">Connecting…</p>
            ) : !state.folder ? (
              <Setup state={state} onInit={() => void call(QA_METHODS.init)} />
            ) : view.name === 'tests' ? (
              <Tests state={state} busy={busy} onRun={startRun} onView={(runId) => setView({ name: 'detail', runId })} call={call} />
            ) : view.name === 'live' ? (
              <LiveView live={live} busy={busy} onStop={() => void call(QA_METHODS.stop)} onOpen={(runId) => setView({ name: 'detail', runId })} />
            ) : view.name === 'detail' ? (
              <Detail runId={view.runId} call={call} />
            ) : view.name === 'record' ? (
              <Record state={state} live={live} setLive={setLive} call={call} onDone={() => setView({ name: 'tests' })} />
            ) : view.name === 'explore' ? (
              <Explore busy={busy} {...(state.model ? { model: state.model } : {})} onStart={async (start, allowCommits, ai) => {
                setLive({ kind: 'explore', title: `Exploring ${start || '/'}`, lines: [] });
                setView({ name: 'live' });
                if (!(await call(QA_METHODS.explore, { start, allowCommits, ai }))) setLive(undefined);
              }} />
            ) : (
              <Ask state={state} busy={busy} onStart={async (task, start) => {
                setLive({ kind: 'do', title: task, lines: [] });
                setView({ name: 'live' });
                if (!(await call(QA_METHODS.do, { task, start }))) setLive(undefined);
              }} />
            )}
          </div>
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
      {settingsOpen && state && <SettingsDialog state={state} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

type Call = <T>(method: string, params?: unknown) => Promise<T | undefined>;

function Setup({ state, onInit }: { state: QaState; onInit(): void }): JSX.Element {
  return (
    <section className="qa-section">
      <h1 className="qa-title">Test your app with Heap QA</h1>
      <p>Heap QA keeps tests as readable files in a test folder: settings, flows and reusable steps. There is none in {state.folderName} yet.</p>
      <p className="qa-muted">It will be made at {state.suggestedFolder}, with an example test and a .gitignore for results and test passwords.</p>
      <button className="btn btn-primary" onClick={onInit}>
        Set up a test folder
      </button>
    </section>
  );
}

function Tests({ state, busy, onRun, onView, call }: { state: QaState; busy: boolean; onRun(flows: string[], title: string): void; onView(runId: string): void; call: Call }): JSX.Element {
  const [source, setSource] = useState<{ id: string; file: string; text: string }>();
  return (
    <section className="qa-section">
      <div className="qa-head">
        <div>
          <h1 className="qa-title">Tests</h1>
          <p className="qa-muted">
            {state.flows.length} flow{state.flows.length === 1 ? '' : 's'} in {state.folder}
            {state.baseUrl ? ` · against ${state.baseUrl}` : ''}
            {state.steps.length ? ` · reusable steps: ${state.steps.join(', ')}` : ''}
          </p>
        </div>
        <button className="btn btn-primary" disabled={busy || !state.flows.length || state.errors.length > 0} onClick={() => onRun([], `Running ${state.flows.length} flows`)}>
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
        <ul className="qa-list">
          {state.flows.map((f) => (
            <li key={f.id} className="qa-row">
              <span className={`qa-status ${f.last ? `qa-${f.last.status}` : ''}`} aria-label={f.last ? f.last.status : 'not run yet'}>
                {f.last ? (f.last.status === 'passed' ? '✓' : '✗') : '·'}
              </span>
              <span className="qa-row-main">
                <span className="qa-row-name">{f.name}</span>
                <span className="qa-muted qa-row-sub">
                  {f.file} · {f.steps} step{f.steps === 1 ? '' : 's'}
                </span>
              </span>
              <span className="qa-row-actions">
                {f.last && (
                  <button className="btn btn-quiet" onClick={() => onView(f.last!.runId)}>
                    Last run
                  </button>
                )}
                <button
                  className="btn btn-quiet"
                  onClick={async () => {
                    const r = await call<{ file: string; text: string }>(QA_METHODS.flowSource, { id: f.id });
                    if (r) setSource({ id: f.id, ...r });
                  }}
                >
                  View
                </button>
                <button className="btn" disabled={busy || state.errors.length > 0} onClick={() => onRun([f.id], `Running ${f.name}`)}>
                  Run
                </button>
              </span>
            </li>
          ))}
        </ul>
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
    </section>
  );
}

function LiveView({ live, busy, onStop, onOpen }: { live?: Live; busy: boolean; onStop(): void; onOpen(runId: string): void }): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  // A block body on purpose: newer browsers return a promise from scrollIntoView,
  // and an effect that returns anything but a function crashes React on cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [live?.lines.length]);
  if (!live) return <p className="qa-muted">Nothing has run yet.</p>;
  return (
    <section className="qa-section">
      <div className="qa-head">
        <h1 className="qa-title">{live.done ? live.title.replace(/^Running /, 'Ran ').replace(/^Exploring /, 'Explored ') : live.title}</h1>
        {busy && !live.done ? (
          <button className="btn btn-danger" onClick={onStop}>
            Stop
          </button>
        ) : live.runId ? (
          <button className="btn btn-primary" onClick={() => onOpen(live.runId!)}>
            Open report
          </button>
        ) : null}
      </div>
      <Lines lines={live.lines} />
      {live.done ? <p className="qa-done">{live.done}</p> : <p className="qa-muted qa-working">Working…</p>}
      <div ref={end} />
    </section>
  );
}

function Lines({ lines }: { lines: LiveLine[] }): JSX.Element {
  return (
    <ol className="qa-lines">
      {lines.map((l) => (
        <li key={l.key} className={`qa-line qa-tone-${l.tone}`} style={{ paddingLeft: `${l.depth * 18}px` }}>
          <span className="qa-mark" aria-hidden="true">
            {l.mark}
          </span>
          <span>
            {l.text}
            {l.note && <span className="qa-note">{l.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Detail({ runId, call }: { runId: string; call: Call }): JSX.Element {
  const [detail, setDetail] = useState<QaRunDetail>();
  const [applied, setApplied] = useState<QaAcceptHealsResult>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setDetail(undefined);
    setApplied(undefined);
    void call<QaRunDetail>(QA_METHODS.runDetail, { runId }).then((d) => d && setDetail(d));
  }, [runId, call]);
  const heals = detail?.kind === 'run' ? detail.summary.flows.reduce((n, f) => n + (f.heals?.length ?? 0), 0) : 0;
  return (
    <section className="qa-section qa-detail">
      <div className="qa-head">
        <div>
          <h1 className="qa-title">{detail?.kind === 'explore' ? 'Explore' : 'Test run'}</h1>
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
          <a className="btn btn-quiet" href={`${BASE}/attachment/runs/${runId}/report.html`} target="_blank" rel="noreferrer">
            Open in a tab
          </a>
        </span>
      </div>
      {applied && (
        <div className="banner">
          <span>
            {applied.applied.filter((a) => a.applied).length} fix{applied.applied.filter((a) => a.applied).length === 1 ? '' : 'es'} written into the files
            {applied.applied.some((a) => !a.applied) ? `; skipped: ${applied.applied.filter((a) => !a.applied).map((a) => `${a.file} step ${a.step} (${a.reason})`).join(', ')}` : ''}.
          </span>
        </div>
      )}
      {/* The report is the same page the terminal writes. No scripts run in it
          (no allow-scripts); same-origin only so its screenshots load with the
          session's cookie. */}
      <iframe key={version} className="qa-report" title="Report" sandbox="allow-same-origin allow-popups" src={`${BASE}/attachment/runs/${runId}/report.html`} />
    </section>
  );
}

function Record({ state, live, setLive, call, onDone }: { state: QaState; live?: Live; setLive(l: Live | undefined): void; call: Call; onDone(): void }): JSX.Element {
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
  // The person pressed Done in the browser: go straight to saving.
  useEffect(() => {
    if (recording && live?.kind === 'record' && live.done === 'finished' && !stopped) void stop();
  }, [live?.done]);

  if (saved) {
    return (
      <section className="qa-section">
        <h1 className="qa-title">Saved {saved.file.split('/').pop()}</h1>
        <p className={saved.replay.status === 'passed' ? 'qa-done' : 'qa-bad'}>
          {saved.replay.status === 'passed' ? '✓ It plays back without you.' : `✗ Playback failed — ${saved.replay.error}. The flow is saved; edit it or record again.`}
        </p>
        {saved.secretsAdded.length > 0 && <p className="qa-muted">Added {saved.secretsAdded.join(', ')} to the secrets file.</p>}
        <button className="btn btn-primary" onClick={() => { setSaved(undefined); setStopped(undefined); setLive(undefined); onDone(); }}>
          Back to tests
        </button>
      </section>
    );
  }

  if (stopped) {
    return (
      <section className="qa-section">
        <h1 className="qa-title">Save the recording</h1>
        {stopped.steps <= 1 ? (
          <>
            <p>Nothing was recorded.</p>
            <button className="btn" onClick={async () => { await call(QA_METHODS.recordDiscard); setStopped(undefined); setLive(undefined); }}>
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
              <button className="btn" onClick={async () => { await call(QA_METHODS.recordDiscard); setStopped(undefined); setLive(undefined); }}>
                Discard
              </button>
              <button className="btn btn-primary" disabled={!name.trim()} onClick={async () => {
                const r = await call<QaRecordSaveResult>(QA_METHODS.recordSave, { name, use, saveSecrets: keepSecrets });
                if (r) setSaved(r);
              }}>
                Save and play back
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  if (recording && live?.kind === 'record') {
    return (
      <section className="qa-section">
        <div className="qa-head">
          <h1 className="qa-title">Recording</h1>
          <button className="btn btn-primary" onClick={() => void stop()}>
            Stop and save
          </button>
        </div>
        <p className="qa-muted">Use your app in the browser window that opened. The bar at its bottom right adds checks. Press Done there, or Stop here, when you have finished.</p>
        <Lines lines={live.lines} />
      </section>
    );
  }

  return (
    <section className="qa-section">
      <h1 className="qa-title">New test</h1>
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
          setLive({ kind: 'record', title: 'Recording', lines: [] });
          if (!(await call(QA_METHODS.record, { start }))) setLive(undefined);
        }}
      >
        Start recording
      </button>
    </section>
  );
}

function Explore({ busy, model, onStart }: { busy: boolean; model?: string; onStart(start: string, allowCommits: boolean, ai: boolean): void }): JSX.Element {
  const [start, setStart] = useState('/');
  const [allow, setAllow] = useState(false);
  const [ai, setAi] = useState(false);
  return (
    <section className="qa-section">
      <h1 className="qa-title">Explore</h1>
      <p>Find bugs with no test written: Heap QA visits every page it can reach, presses what is safe to press, fills forms with ordinary and awkward input, and reports what is plainly wrong — server errors, broken links, crashes, error text, layouts too wide for a phone, buttons that do nothing.</p>
      <label className="field">
        <span className="field-label">Start at</span>
        <input className="card-input" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="qa-check">
        <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
        Also press Delete, Pay, Submit-like buttons — only on data you can lose
      </label>
      {model && (
        <label className="qa-check">
          <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
          Also have {model} look at each page for what no rule catches (labelled as the AI's)
        </label>
      )}
      <button className="btn btn-primary" disabled={busy} onClick={() => onStart(start, allow, ai)}>
        Explore
      </button>
    </section>
  );
}

function Ask({ state, busy, onStart }: { state: QaState; busy: boolean; onStart(task: string, start: string): void }): JSX.Element {
  const [task, setTask] = useState('');
  const [start, setStart] = useState('/');
  return (
    <section className="qa-section">
      <h1 className="qa-title">Ask AI to write a test</h1>
      <p>Say what to do in your app. The AI does it in a browser; what worked becomes a test that replays without the AI, saved only if it does.</p>
      {!state.model && <div className="banner banner-warn">No model is set for the agent role — set one in Heap Code's settings.</div>}
      <label className="field">
        <span className="field-label">What to do</span>
        <textarea className="card-input qa-textarea" value={task} onChange={(e) => setTask(e.target.value)} placeholder="Log in as ai@example.test with the test password, then check you are welcomed" />
      </label>
      <label className="field">
        <span className="field-label">Start at</span>
        <input className="card-input" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <button className="btn btn-primary" disabled={busy || !task.trim() || !state.model} onClick={() => onStart(task.trim(), start)}>
        Do it{state.model ? ` with ${state.model}` : ''}
      </button>
    </section>
  );
}

function SettingsDialog({ state, onClose }: { state: QaState; onClose(): void }): JSX.Element {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Heap QA settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Heap QA</div>
        <div className="modal-body">
          <dl className="qa-facts">
            <dt>Test folder</dt>
            <dd>{state.folder ?? 'none yet'}</dd>
            <dt>App address</dt>
            <dd>{state.baseUrl ?? 'not set — add baseUrl to heapqa.yaml'}</dd>
            <dt>Healing</dt>
            <dd>{state.heal === 'ai' ? 'similarity, then the AI' : state.heal === 'similarity' ? 'similarity only (no model)' : 'off'}</dd>
            <dt>Model</dt>
            <dd>{state.model ? `${state.model} on ${state.profile} (the agent role)` : 'none — set the agent role in Heap Code'}</dd>
          </dl>
          <p className="qa-muted">Settings live in heapqa.yaml in the test folder. Models are shared with Heap Code: change them in its settings.</p>
          <div className="form-actions">
            {HAS_CODE && (
              <a className="btn" href="/">
                Open Heap Code
              </a>
            )}
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
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
