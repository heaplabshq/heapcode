import { useEffect, useState } from 'react';
import { defaultProfile, loadOnboarded, loadProfile, type StoredProfile } from '../shared/settings.js';
import { PENDING_PROMPT_KEY, PORT_NAME, type WorkerMessage } from '../shared/messages.js';
import { useChat } from './useChat.js';
import { MessageList } from './components/MessageList.js';
import { Composer } from './components/Composer.js';
import { Settings } from './components/Settings.js';
import { ContextMeter } from './components/ContextMeter.js';
import { Confirm } from './components/Confirm.js';
import { AuditLog } from './components/AuditLog.js';
import { Onboarding } from './components/Onboarding.js';
import { Tasks, TaskChips } from './components/Tasks.js';
import { useConfirm } from './useConfirm.js';
import { useAsk } from './useAsk.js';
import { Ask } from './components/Ask.js';
import { DEFAULT_BROWSER_MODE, type BrowserMode } from '../agent/originPolicy.js';
import { activeSite, grantActiveSite, type ActiveSite } from './page.js';

export function App() {
  const [profile, setProfile] = useState<StoredProfile>(defaultProfile);
  const [origin, setOrigin] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  /** The composer's text, held here so the saved-tasks panel can offer to keep it. */
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  /** Undefined until the flag has been read, so the panel does not flash. */
  const [onboarding, setOnboarding] = useState<boolean>();
  const [site, setSite] = useState<ActiveSite>();
  const [mode, setMode] = useState<BrowserMode>(DEFAULT_BROWSER_MODE);
  const confirmation = useConfirm();
  const question = useAsk();
  const { turns, busy, send, stop, clear, tokens, contextWindow } = useChat(profile, {
    mode,
    host: site?.host,
    confirm: confirmation.request,
    cancelConfirm: confirmation.cancel,
    ask: question.ask,
    cancelAsk: question.cancel,
  });

  useEffect(() => {
    void Promise.all([loadProfile(), loadOnboarded()]).then(([stored, onboarded]) => {
      setProfile(stored);
      setLoaded(true);
      // First run gets the explanation, not the settings form. Someone who has
      // been through it once and cleared their model gets the form, because at
      // that point the thing they are missing is a field, not an explanation.
      setOnboarding(!onboarded);
      if (onboarded && stored.model.length === 0) setShowSettings(true);
    });
  }, []);

  /**
   * Hold a port open for the whole life of the panel.
   *
   * The message it carries (the extension's own origin) is incidental; the
   * connection is the point. An open port is what keeps the MV3 service worker
   * from being shut down as idle, and from M2 the run depends on the worker
   * still being there to route to (PRD §7.1).
   */
  useEffect(() => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((message: WorkerMessage) => {
      if (message.type === 'origin') setOrigin(message.origin);
      // A right-click on the page, while this panel was already open.
      if (message.type === 'prompt') setDraft(message.text);
    });
    port.postMessage({ type: 'origin' });
    return () => port.disconnect();
  }, []);

  /**
   * A request left by a right-click, picked up once.
   *
   * The panel may be opening *because* of that click, in which case there was
   * no port to send it on when the menu fired — so it is also written to
   * session storage, read here, and cleared. It lands in the composer rather
   * than being sent: selected text is page content, and page content must not
   * reach the model carrying the user's authority without the user having read
   * it first.
   */
  useEffect(() => {
    void chrome.storage.session.get(PENDING_PROMPT_KEY).then((stored) => {
      const pending = stored[PENDING_PROMPT_KEY];
      if (typeof pending !== 'string' || !pending) return;
      setDraft(pending);
      void chrome.storage.session.remove(PENDING_PROMPT_KEY);
    });
  }, []);

  /**
   * Which site the panel is pointed at, and whether we may read it.
   *
   * Re-checked on tab and navigation changes because the side panel outlives
   * both — the header would otherwise keep showing whichever site happened to
   * be open when the panel was first opened.
   */
  useEffect(() => {
    const refresh = async () => setSite(await activeSite());
    void refresh();
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(refresh);
    return () => {
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(refresh);
    };
  }, []);

  const configured = profile.model.length > 0 && profile.baseUrl.length > 0;

  if (onboarding) {
    return (
      <div className="app">
        <header className="app-header">
          <div className="header-row">
            <span className="brand">
              <span className="brand-mark" aria-hidden="true" />
              heapbrowse
            </span>
          </div>
        </header>
        <Onboarding
          profile={profile}
          origin={origin}
          site={site}
          onDone={(saved) => {
            setProfile(saved);
            setOnboarding(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {/*
        Two rows, not one. Eight controls competing for a 350px header meant
        every one of them was truncated to an ambiguous stub, and the model name
        — the thing you most often want to check — lost every time. Identity and
        state on top, the controls beneath them.
      */}
      <header className="app-header">
        <div className="header-row">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true" />
            heapbrowse
          </span>
          <span className="model" title={`${profile.name} — ${profile.baseUrl}`}>
            {configured ? profile.model : 'not configured'}
          </span>
          <ContextMeter tokens={tokens} window={contextWindow} />
        </div>
        <div className="header-row header-controls">
          {/* The ceiling on what a run may do, always visible. There is no
              full-auto: the most permissive setting still asks before anything
              irreversible (PRD section 6.3). */}
          <select
            className="mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as BrowserMode)}
            title={
              'Read only: never acts.\n' +
              'Ask every time: confirms every action.\n' +
              'Ask only for risky: routine clicks and typing go ahead; anything that buys, ' +
              'pays, submits, deletes or leaves the site still asks.\n' +
              "Don't ask: acts without confirming. Banks and password managers are still " +
              'refused, credential fields are still never typed into, and the per-run action ' +
              'limits still apply.'
            }
            aria-label="Permission mode"
          >
            <option value="read-only">Read only</option>
            <option value="confirm">Ask every time</option>
            <option value="auto-approve">Ask only for risky</option>
            <option value="auto">Don't ask</option>
          </select>
          <span className="header-spacer" />
          <button
            type="button"
            className={showTasks ? 'ghost on' : 'ghost'}
            onClick={() => setShowTasks((v) => !v)}
            aria-expanded={showTasks}
            title="Saved tasks and earlier runs"
          >
            Tasks
          </button>
          <button
            type="button"
            className={showAudit ? 'ghost on' : 'ghost'}
            onClick={() => setShowAudit((v) => !v)}
            aria-expanded={showAudit}
            title="What heapbrowse has done"
          >
            Log
          </button>
          <button
            type="button"
            className={showSettings ? 'ghost on' : 'ghost'}
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
            title="Provider, details and permissions"
          >
            Settings
          </button>
          <button
            type="button"
            className="ghost"
            onClick={clear}
            disabled={turns.length === 0}
            title="Start a new conversation"
          >
            Clear
          </button>
        </div>
      </header>

      {showSettings && loaded && (
        <Settings
          profile={profile}
          origin={origin}
          onSaved={(saved) => {
            setProfile(saved);
            setShowSettings(false);
          }}
        />
      )}

      {site && (
        <div className={site.granted ? 'site site-granted' : 'site'}>
          <span className="site-dot" aria-hidden="true" />
          <span className="site-host" title={site.host}>
            {site.host}
          </span>
          {site.granted ? (
            <span className="site-ok">readable</span>
          ) : (
            <button
              type="button"
              className="grant"
              onClick={async () => {
                if (await grantActiveSite()) setSite({ ...site, granted: true });
              }}
            >
              Allow this site
            </button>
          )}
        </div>
      )}

      {showTasks && (
        <Tasks
          currentDraft={draft}
          host={site?.host}
          onRun={(prompt) => void send(prompt)}
          onClose={() => setShowTasks(false)}
        />
      )}

      {showAudit && <AuditLog onClose={() => setShowAudit(false)} />}

      <MessageList turns={turns} />

      {turns.length === 0 && !busy && configured && (
        <TaskChips onRun={(prompt) => void send(prompt)} />
      )}

      {confirmation.pending && (
        <Confirm request={confirmation.pending} onAnswer={confirmation.answer} />
      )}

      {question.pending && <Ask question={question.pending} onAnswer={question.answer} />}

      {/* Closing the panel ends the run. Say so rather than letting it be
          discovered — the loop lives in this document, so there is nowhere for
          it to continue (PRD §7.1). */}
      {busy && (
        <p className="notice">
          <span className="notice-dot" aria-hidden="true" />
          Working — keep this panel open, the run stops if it closes.
        </p>
      )}

      <Composer
        busy={busy}
        disabled={!configured}
        text={draft}
        onText={setDraft}
        onSend={(text) => void send(text)}
        onStop={stop}
      />
    </div>
  );
}
