import { useEffect, useRef, useState } from 'react';
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
import { Tasks } from './components/Tasks.js';
import { Sheet } from './components/Sheet.js';
import { Icon } from './components/Icon.js';
import { useConfirm } from './useConfirm.js';
import { useAsk } from './useAsk.js';
import { Ask } from './components/Ask.js';
import { DEFAULT_BROWSER_MODE, type BrowserMode } from '../agent/originPolicy.js';
import { activeSite, grantActiveSite, type ActiveSite } from './page.js';

/** Which pane is over the conversation. One at a time, by construction. */
type Pane = 'tasks' | 'log' | 'settings';

export function App() {
  const [profile, setProfile] = useState<StoredProfile>(defaultProfile);
  const [origin, setOrigin] = useState('');
  const [pane, setPane] = useState<Pane>();
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

  /**
   * The current `stop`, reachable from an effect that must not re-run.
   *
   * `stop` is rebuilt on every render — it closes over the confirmation and
   * question hooks — while the port below has to be opened exactly once, because
   * an open port is what keeps the service worker alive. Reconnecting it each
   * render would defeat that; capturing the first `stop` would cancel a
   * confirmation belonging to a run that has since been replaced.
   */
  const stopNow = useRef(stop);
  stopNow.current = stop;

  useEffect(() => {
    void Promise.all([loadProfile(), loadOnboarded()]).then(([stored, onboarded]) => {
      setProfile(stored);
      setLoaded(true);
      // First run gets the explanation, not the settings form. Someone who has
      // been through it once and cleared their model gets the form, because at
      // that point the thing they are missing is a field, not an explanation.
      setOnboarding(!onboarded);
      if (onboarded && stored.model.length === 0) setPane('settings');
    });
  }, []);

  /**
   * Hold a port open for the whole life of the panel.
   *
   * The message it carries is incidental; the connection is the point. An open
   * port is what keeps the MV3 service worker from being shut down as idle, and
   * from M2 the run depends on the worker still being there to route to
   * (PRD §7.1).
   *
   * It also carries Stop back from the page. The bar heapbrowse draws along the
   * bottom of the page it is driving has a stop button on it, and the page has
   * no way to reach this document directly — so it goes to the worker, and the
   * worker hands it to every open panel.
   */
  useEffect(() => {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((message: WorkerMessage) => {
      if (message.type === 'origin') setOrigin(message.origin);
      // A right-click on the page, while this panel was already open.
      if (message.type === 'prompt') setDraft(message.text);
      if (message.type === 'stop') stopNow.current();
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
  const toggle = (which: Pane) => setPane((open) => (open === which ? undefined : which));
  const runAndClose = (prompt: string) => {
    setPane(undefined);
    void send(prompt);
  };

  if (onboarding) {
    return (
      <Onboarding
        profile={profile}
        origin={origin}
        site={site}
        onDone={(saved, firstPrompt) => {
          setProfile(saved);
          setOnboarding(false);
          // Finishing by pressing a suggestion should run it. The profile has
          // been saved by the time this resolves, but `useChat` closes over the
          // profile in state — so the run is queued for after the re-render.
          if (firstPrompt) setTimeout(() => void send(firstPrompt), 0);
        }}
      />
    );
  }

  return (
    <div className="app">
      {/*
        One row, and none of it is the product's name.
        
        Chrome already draws "heapbrowse" in the side panel's own title bar
        directly above this, so a brand row here was the word twice in fifty
        pixels. What is left is the two things the header is actually for:
        which site is in scope, and the panes. The model and the context meter
        moved under the composer -- they describe the run you are about to
        start, they are reference rather than navigation, and down there they
        cost nothing at the top of a 350px column.
      */}
      <header className="topbar">
        <div className="topbar-row">
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
                  Allow
                </button>
              )}
            </div>
          )}

          <div className="tool-group">
            <button
              type="button"
              className={pane === 'tasks' ? 'icon-button on' : 'icon-button'}
              onClick={() => toggle('tasks')}
              aria-expanded={pane === 'tasks'}
              aria-label="Saved tasks and earlier runs"
              title="Saved tasks and earlier runs"
            >
              <Icon name="tasks" />
            </button>
            <button
              type="button"
              className={pane === 'log' ? 'icon-button on' : 'icon-button'}
              onClick={() => toggle('log')}
              aria-expanded={pane === 'log'}
              aria-label="What heapbrowse has done"
              title="What heapbrowse has done"
            >
              <Icon name="log" />
            </button>
            <button
              type="button"
              className={pane === 'settings' ? 'icon-button on' : 'icon-button'}
              onClick={() => toggle('settings')}
              aria-expanded={pane === 'settings'}
              aria-label="Provider, details and permissions"
              title="Provider, details and permissions"
            >
              <Icon name="settings" />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={clear}
              disabled={turns.length === 0}
              aria-label="Start a new conversation"
              title="Start a new conversation"
            >
              <Icon name="newChat" />
            </button>
          </div>
        </div>
      </header>

      {/* The transcript and whatever is layered over it. A pane covers the
          conversation rather than pushing it down the screen, so closing one
          leaves the transcript exactly where it was. */}
      <div className="stage">
        <MessageList turns={turns} ready={configured} onRun={runAndClose} />

        {pane === 'settings' && loaded && (
          <Sheet title="Settings" onClose={() => setPane(undefined)}>
            <Settings
              profile={profile}
              origin={origin}
              onSaved={(saved) => {
                setProfile(saved);
                setPane(undefined);
              }}
            />
          </Sheet>
        )}

        {pane === 'tasks' && (
          <Sheet title="Tasks" onClose={() => setPane(undefined)}>
            <Tasks
              currentDraft={draft}
              host={site?.host}
              onRun={(prompt) => void send(prompt)}
              onClose={() => setPane(undefined)}
            />
          </Sheet>
        )}

        {pane === 'log' && (
          <Sheet title="What heapbrowse has done" onClose={() => setPane(undefined)}>
            <AuditLog />
          </Sheet>
        )}
      </div>

      <div className="footer">
        {/* Closing the panel ends the run. Say so rather than letting it be
            discovered — the loop lives in this document, so there is nowhere for
            it to continue (PRD §7.1). */}
        {busy && !confirmation.pending && !question.pending && (
          <p className="notice">
            <span className="notice-dot" aria-hidden="true" />
            Working — keep this panel open, the run stops if it closes.
          </p>
        )}

        {confirmation.pending && (
          <Confirm request={confirmation.pending} onAnswer={confirmation.answer} />
        )}

        {question.pending && <Ask question={question.pending} onAnswer={question.answer} />}

        <Composer
          busy={busy}
          disabled={!configured}
          text={draft}
          onText={setDraft}
          onSend={(text) => void send(text)}
          onStop={stop}
          mode={mode}
          onMode={setMode}
          model={configured ? profile.model : undefined}
          endpoint={`${profile.name} — ${profile.baseUrl}`}
          meter={<ContextMeter tokens={tokens} window={contextWindow} />}
        />
      </div>
    </div>
  );
}
