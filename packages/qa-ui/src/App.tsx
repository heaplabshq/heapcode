import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RpcClient } from '@heapcode/web-ui/rpc';
import { Sidebar } from '@heapcode/web-ui/components/Sidebar';
import { ProductToggle, servedProducts } from '@heapcode/web-ui/components/ProductToggle';
import { WorkspacePicker } from '@heapcode/web-ui/components/WorkspacePicker';
import { MessageList } from '@heapcode/web-ui/components/MessageList';
import { Composer } from '@heapcode/web-ui/components/Composer';
import { Settings, SettingsGroup, SettingsRow, SettingsSection } from '@heapcode/web-ui/components/Settings';
import { ICON_BROWSER, ICON_POP_OUT } from '@heapcode/web-ui/components/icons';
import { usePanelWidth } from '@heapcode/web-ui/panelWidth';
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
  type UiSettings,
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
  /** The Settings page open, or undefined when the dialog is closed. */
  const [settingsOpen, setSettingsOpen] = useState<string>();
  const [uiSettings, setUiSettings] = useState<UiSettings>();
  const [browserOpen, setBrowserOpen] = useState(() => remembered('heapqa.browser') === 'open');
  const { width: panelWidth, startDrag: startPanelDrag } = usePanelWidth('heapqa.panelWidth');
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

  const setBrowser = (open: boolean): void => {
    setBrowserOpen(open);
    remember('heapqa.browser', open ? 'open' : 'closed');
  };
  /** A step's screenshot, on the right — opening the panel if it was closed. */
  const pin = (p: Pinned): void => {
    setPinned(p);
    setBrowser(true);
  };

  const refreshSettings = (): void => {
    client.request<UiSettings>(QA_METHODS.settings).then(setUiSettings).catch(() => undefined);
  };
  const openSettings = (page?: string): void => {
    refreshSettings();
    setSettingsOpen(page ?? 'tests');
  };
  /** Every shared-settings change: send it, then re-read — as Heap Chat does. */
  const editSettings = (method: string, params: unknown): void => {
    client
      .request(method, params)
      .then(refreshSettings)
      .catch((e: Error) => setError(e.message));
  };

  /** A fresh job: clears the log, the live view and any pinned step, and shows the browser. */
  const begin = (kind: Job['kind'], title: string, to: View): void => {
    setBrowser(true);
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
  // The browser belongs to the job that showed it: a view of another job's
  // kind starts empty, unless something is running right now.
  const viewKind: Job['kind'] | undefined = view === 'run' ? 'run' : view === 'record' ? 'record' : view === 'explore' ? 'explore' : view === 'ask' ? 'do' : undefined;
  const showFrame = busy || (job !== undefined && job.kind === viewKind);
  const jobBusy = busy && job !== undefined && state?.busy?.kind === job.kind;

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
          onOpenSettings={() => openSettings()}
          extraNav={
            <>
              <RailRow label="Tests" collapsed={railCollapsed} active={is('tests')} onClick={() => setView('tests')} icon={<IconList />} />
              <RailRow label="Ask AI" collapsed={railCollapsed} active={is('ask')} onClick={() => setView('ask')} icon={<IconSpark />} />
              <RailRow label="Explore" collapsed={railCollapsed} active={is('explore')} onClick={() => setView('explore')} icon={<IconCompass />} />
              {job?.kind === 'run' && <RailRow label={busy ? 'Running…' : 'Last run'} collapsed={railCollapsed} active={is('run')} onClick={() => setView('run')} icon={<IconPulse />} />}
            </>
          }
        />
        <main className="chat qa-main">
          {/* Heap Code's top strip: what this is about on the left, view toggles on the right. */}
          <div className="qa-toolbar">
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
              <button className="qa-chip" title="Where the tests point — change it in Settings" onClick={() => openSettings('tests')}>
                {state.baseUrl}
              </button>
            )}
            {state?.busy && (
              <span className="qa-busy">
                <span className="qa-dot" aria-hidden="true" />
                <span className="qa-busy-label">{state.busy.label}</span>
                {state.busy.kind !== 'record' && (
                  <button className="btn btn-quiet btn-sm" onClick={() => void call(QA_METHODS.stop)}>
                    Stop
                  </button>
                )}
              </span>
            )}
            <span className="qa-top-spacer" />
            <div className="chat-tools qa-tools" role="toolbar" aria-label="Browser">
              <button
                className={`chat-tool chat-tool-icon ${headed ? 'chat-tool-on' : ''}`}
                aria-pressed={headed}
                aria-label="Also open a browser window"
                title={
                  headed
                    ? 'Runs also open a separate browser window — click to run hidden'
                    : 'Runs are hidden and shown in the Browser panel — click to also open a separate window (full size, with developer tools)'
                }
                onClick={() =>
                  setHeaded((h) => {
                    remember('heapqa.headed', String(!h));
                    return !h;
                  })
                }
              >
                {ICON_POP_OUT}
              </button>
              <button
                className={`chat-tool chat-tool-icon ${browserOpen ? 'chat-tool-on' : ''}`}
                aria-pressed={browserOpen}
                aria-label="Browser"
                title="Browser"
                onClick={() => setBrowser(!browserOpen)}
              >
                {ICON_BROWSER}
                {!browserOpen && jobBusy && <span className="chat-tool-dot" aria-hidden="true" />}
              </button>
            </div>
          </div>
          {state?.lan && (
            <div className="banner banner-warn" role="alert">
              <strong>Reached over the network.</strong>
              <span>Browser windows open on the computer running Heap QA, not on this device — the Browser panel still shows them here.</span>
            </div>
          )}
          {status === 'closed' && <div className="banner">Disconnected — reconnecting…</div>}
          {error && (
            <div className="banner banner-error" role="alert">
              {/* The command line's instructions say to edit heapqa.yaml; here there is a button for it. */}
              <span>{/is not listed in heapqa\.yaml/.test(error) ? `${error.split(' To test it')[0]} Allow it here, or in Settings → Tests.` : error}</span>
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
            <RunLog job={job} heal={heal} pinned={pinned} onPin={pin} onOpenReport={(id) => setView({ detail: id })} />
          ) : is('record') ? (
            <Record
              state={state}
              job={job}
              begin={() => begin('record', 'Recording', 'record')}
              call={call}
              onDone={() => {
                setJob(undefined);
                setView('tests');
              }}
            />
          ) : is('explore') ? (
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
          ) : is('ask') ? (
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
              onNew={() => {
                setAi(emptyTranscript);
                setFrame(undefined);
                if (job?.kind === 'do') setJob(undefined);
              }}
              onOpenSettings={() => openSettings('providers')}
            />
          ) : typeof view === 'object' ? (
            <Detail runId={view.detail} call={call} lan={state.lan} />
          ) : null}
        </main>

        {/* The browser, as Heap Code's side panel: closable, resizable, back from the globe icon. */}
        {browserOpen && (
          <>
            <div className="panel-splitter" role="separator" aria-orientation="vertical" aria-label="Resize browser panel" onPointerDown={startPanelDrag} />
            <section className="panel" aria-label="Browser" style={panelWidth ? { width: panelWidth } : undefined}>
              <header className="panel-head">
                <span className="panel-head-icon">{ICON_BROWSER}</span>
                <h2 className="panel-title">Browser</h2>
                <button className="icon-btn panel-close" onClick={() => setBrowser(false)} aria-label="Close panel" title="Close — the globe icon brings it back">
                  ✕
                </button>
              </header>
              <LivePanel
                frame={showFrame ? frame : undefined}
                pinned={pinned}
                onUnpin={() => setPinned(undefined)}
                busy={jobBusy}
                headed={state?.busy?.kind === 'record' || headed}
                {...(state?.busy?.kind === 'record' ? { hint: 'Use the browser window that opened — this mirrors it.' } : {})}
              />
            </section>
          </>
        )}
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
      {settingsOpen && state && (
        <Settings
          settings={uiSettings}
          onClose={() => setSettingsOpen(undefined)}
          initialPage={settingsOpen}
          // Only what Heap QA uses from the shared config: connections and the
          // model roles (healing and AI tests run on the agent role).
          pages={['providers']}
          extraPages={[
            {
              id: 'tests',
              group: 'Heap QA',
              label: 'Tests',
              icon: <IconList />,
              keywords: 'address base url targets sites healing timeout browser chrome edge secrets passwords',
              render: (go) => <TestSettings state={state} save={(patch) => client.request<QaState>(QA_METHODS.saveSettings, patch).then(setState)} onChangeModel={() => go('providers')} />,
            },
          ]}
          onSaveProfile={(profile, apiKey) => editSettings(QA_METHODS.saveProfile, { profile, apiKey })}
          onDeleteProfile={(name) => editSettings(QA_METHODS.deleteProfile, { name })}
          onUseProfile={(name) => editSettings(QA_METHODS.useProfile, { name })}
          onSetRole={(role, assignment) => editSettings(QA_METHODS.setRole, { role, assignment })}
          onSetWebSearch={(patch) => editSettings(QA_METHODS.setWebSearch, patch)}
          listConnectionModels={(connection) => client.request<{ models: string[] }>(QA_METHODS.listConnectionModels, { connection }).then((r) => r.models)}
          listModels={(profileName) => client.request<{ models: string[] }>(QA_METHODS.listConnectionModels, { connection: profileName }).then((r) => r.models)}
          probeProvider={(params) => client.request(QA_METHODS.probeProvider, params)}
          // Not on the pages offered here, but required by the props.
          onSetPersona={() => {}}
          onToggleSubAgents={() => {}}
          onToggleNativeTools={() => {}}
          onResetPermissions={() => {}}
          onSaveMcpServer={() => {}}
          onDeleteMcpServer={() => {}}
        />
      )}
    </div>
  );
}

type Call = <T>(method: string, params?: unknown) => Promise<T | undefined>;

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
            {busy && <span className="qa-live-tag qa-live-tag-on">Live</span>}
            {(busy || src) && <span className="qa-live-title">{busy ? (hint ?? (headed ? 'Also open in its own window' : 'Running hidden — this is what it sees')) : 'The last thing it showed'}</span>}
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

function Ask({ state, busy, transcript, onSend, onStop, onNew, onOpenSettings }: { state: QaState; busy: boolean; transcript: Transcript; onSend(task: string, start: string): void; onStop(): void; onNew(): void; onOpenSettings(): void }): JSX.Element {
  const [start, setStart] = useState('/');
  const working = state.busy?.kind === 'do';
  return (
    <div className="qa-ask">
      <div className="qa-ask-head">
        <h2 className="qa-subtitle">Ask AI</h2>
        {/* Each request is its own task in a fresh browser — the AI does not carry earlier ones over — so this clears the screen, not a memory. */}
        <span className="qa-muted qa-ask-note">Each request starts fresh in a new browser.</span>
        <button className="btn btn-quiet" disabled={working || transcript.items.length === 0} onClick={onNew} title="Clear this conversation and start again">
          New chat
        </button>
      </div>
      {!state.model && (
        <div className="banner banner-warn" role="alert">
          <strong>No model yet.</strong>
          <span>Ask AI runs on the agent role.</span>
          <button type="button" className="banner-action" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      )}
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

/**
 * Heap QA's own page in the shared Settings dialog: heapqa.yaml, laid out
 * with the dialog's own rows so it reads like the pages around it. Each
 * field saves when it is left — the way the other pages apply as you go —
 * and a refusal shows under it.
 */
function TestSettings({ state, save, onChangeModel }: { state: QaState; save(patch: Record<string, unknown>): Promise<void>; onChangeModel(): void }): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(state.baseUrl ?? '');
  const [targets, setTargets] = useState((state.settings?.targets ?? []).join('\n'));
  const [timeout, setTimeoutSecs] = useState(String((state.settings?.timeout ?? 10_000) / 1000));
  const [secretsFile, setSecretsFile] = useState(state.settings?.secretsFile ?? '');
  const [problem, setProblem] = useState<string>();
  const [saved, setSaved] = useState(false);

  if (!state.folder) {
    return (
      <SettingsSection description="Settings for the test folder, saved in its heapqa.yaml.">
        <p className="hint">Set up a test folder first — these settings are saved in it.</p>
      </SettingsSection>
    );
  }
  const apply = (patch: Record<string, unknown>): void => {
    setProblem(undefined);
    setSaved(false);
    save(patch)
      .then(() => setSaved(true))
      .catch((e: Error) => setProblem(e.message));
  };
  const secs = (): number | undefined => {
    const n = Number(timeout);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
  };

  return (
    <SettingsSection description="How tests run in this folder. Saved in its heapqa.yaml, so the command line and CI use the same settings.">
      <SettingsGroup label="Your app">
        <SettingsRow label="Address" hint="Where tests start. Paths like /login are on this address." stacked>
          <input className="card-input" value={baseUrl} placeholder="http://localhost:3000" onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => baseUrl !== (state.baseUrl ?? '') && apply({ baseUrl })} />
        </SettingsRow>
        <SettingsRow label="Other sites tests may open" hint="One per line. Your own computer (localhost) is always allowed; anything else must be listed, so a test never wanders onto a site by mistake." stacked>
          <textarea
            className="card-input qa-textarea"
            value={targets}
            placeholder={'https://staging.example.com\nhttps://*.vercel.app'}
            onChange={(e) => setTargets(e.target.value)}
            onBlur={() => apply({ targets: targets.split(/[\n,]/).map((t) => t.trim()).filter(Boolean) })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup label="Running">
        <SettingsRow label="When a button or field has moved" hint="Likeness compares label, position and kind; the AI looks at the page when that is not sure. Fixes are only suggested — you accept them.">
          <select className="select" value={state.heal} onChange={(e) => apply({ heal: e.target.value })}>
            <option value="ai">Likeness, then the AI</option>
            <option value="similarity">Likeness only (no AI)</option>
            <option value="off">Fail the test</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Wait per step" hint="How long a step waits for the page, in seconds.">
          <input className="card-input qa-num-input" inputMode="decimal" value={timeout} onChange={(e) => setTimeoutSecs(e.target.value)} onBlur={() => (secs() ? apply({ timeout: secs() }) : setProblem('Wait per step is a number of seconds, more than 0.'))} />
        </SettingsRow>
        <SettingsRow label="Browser" hint="Automatic runs hidden in Playwright's own browser, and uses Chrome when that is missing.">
          <select className="select" value={state.settings?.channel ?? ''} onChange={(e) => apply({ channel: e.target.value || undefined })}>
            <option value="">Automatic</option>
            <option value="chrome">Chrome</option>
            <option value="msedge">Edge</option>
            <option value="chromium">Chromium (Playwright's)</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Test passwords file" hint="Inside the test folder and kept out of git. Tests use its values as {{secret:NAME}}." stacked>
          <input className="card-input" value={secretsFile} placeholder=".env.test" onChange={(e) => setSecretsFile(e.target.value)} onBlur={() => secretsFile !== (state.settings?.secretsFile ?? '') && apply({ secretsFile })} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup label="AI">
        <SettingsRow label="Model" hint="Healing, failure notes and Ask AI use the agent role — shared with Heap Code and Heap Chat.">
          <span className="qa-settings-model">
            <span>{state.model ? `${state.model} · ${state.profile}` : 'none set'}</span>
            <button className="btn btn-sm" onClick={onChangeModel}>
              Change
            </button>
          </span>
        </SettingsRow>
      </SettingsGroup>
      {problem ? <p className="qa-bad">{problem}</p> : saved ? <p className="hint">Saved.</p> : null}
      <p className="hint">Test folder: {state.folder}</p>
    </SettingsSection>
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
