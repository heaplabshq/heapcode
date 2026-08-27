import { useEffect, useState } from 'react';
import { defaultProfile, loadProfile, type StoredProfile } from '../shared/settings.js';
import { PORT_NAME, type WorkerMessage } from '../shared/messages.js';
import { useChat } from './useChat.js';
import { MessageList } from './components/MessageList.js';
import { Composer } from './components/Composer.js';
import { Settings } from './components/Settings.js';
import { ContextMeter } from './components/ContextMeter.js';
import { Confirm } from './components/Confirm.js';
import { useConfirm } from './useConfirm.js';
import { DEFAULT_BROWSER_MODE, type BrowserMode } from '../agent/originPolicy.js';
import { activeSite, grantActiveSite, type ActiveSite } from './page.js';

export function App() {
  const [profile, setProfile] = useState<StoredProfile>(defaultProfile);
  const [origin, setOrigin] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [site, setSite] = useState<ActiveSite>();
  const [mode, setMode] = useState<BrowserMode>(DEFAULT_BROWSER_MODE);
  const confirmation = useConfirm();
  const { turns, busy, send, stop, clear, tokens, contextWindow } = useChat(profile, {
    mode,
    confirm: confirmation.request,
    cancelConfirm: confirmation.cancel,
  });

  useEffect(() => {
    void loadProfile().then((stored) => {
      setProfile(stored);
      setLoaded(true);
      // Nothing can be sent without a model, so open setup rather than letting
      // the first send fail for a reason the user cannot see.
      if (stored.model.length === 0) setShowSettings(true);
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
    });
    port.postMessage({ type: 'origin' });
    return () => port.disconnect();
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

  return (
    <div className="app">
      <header>
        <span className="title">heapbrowse</span>
        <span className="model" title={profile.baseUrl}>
          {configured ? profile.model : 'not configured'}
        </span>
        <ContextMeter tokens={tokens} window={contextWindow} />
        {/* The ceiling on what a run may do, always visible. There is no
            full-auto: the most permissive setting still asks before anything
            irreversible (PRD section 6.3). */}
        <select
          className="mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as BrowserMode)}
          title="How much the agent may do without asking"
          aria-label="Permission mode"
        >
          <option value="read-only">Read only</option>
          <option value="confirm">Ask first</option>
          <option value="trusted-site">Trusted site</option>
        </select>
        <button type="button" className="ghost" onClick={clear} disabled={turns.length === 0}>
          Clear
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
        >
          {showSettings ? 'Close' : 'Settings'}
        </button>
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
        <div className="site">
          <span className="site-host" title={site.host}>{site.host}</span>
          {site.granted ? (
            <span className="site-ok">readable</span>
          ) : (
            <button
              type="button"
              className="ghost"
              onClick={async () => {
                if (await grantActiveSite()) setSite({ ...site, granted: true });
              }}
            >
              Allow this site
            </button>
          )}
        </div>
      )}

      <MessageList turns={turns} />

      {confirmation.pending && (
        <Confirm request={confirmation.pending} onAnswer={confirmation.answer} />
      )}

      {/* Closing the panel ends the run. Say so rather than letting it be
          discovered — the loop lives in this document, so there is nowhere for
          it to continue (PRD §7.1). */}
      {busy && <p className="notice">Keep this panel open — the run stops if it closes.</p>}

      <Composer busy={busy} disabled={!configured} onSend={(text) => void send(text)} onStop={stop} />
    </div>
  );
}
