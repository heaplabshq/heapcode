import { useEffect, useRef, useState } from 'react';
import {
  defaultProfile,
  loadOnboarded,
  loadProfile,
  saveProfile,
  type StoredProfile,
} from '../shared/settings.js';
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
import { activeSite, grantActiveSite, grantPattern, type ActiveSite } from './page.js';
import { useGrant } from './useGrant.js';
import { loadWorkflows, saveWorkflow, type SavedTask } from '../shared/tasks.js';
import { learnWorkflow } from '../agent/learn.js';
import type { Command } from './components/SlashMenu.js';
import { useHandOver } from './useHandOver.js';
import { HandOver } from './components/HandOver.js';
import { listModels } from '../shared/ollamaDiagnostic.js';
import { loadApiKey } from '../shared/settings.js';

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
  /** What the configured endpoint says it can run. Empty until it has answered. */
  const [models, setModels] = useState<string[]>([]);
  /**
   * A site permission the run is stopped on.
   *
   * Held apart from the transcript on purpose. The transcript is a record and a
   * record must not change its mind -- what the agent said when it was blocked
   * stays true of that moment. This is the live question, and it goes away when
   * it is answered.
   */
  const grant = useGrant();
  /** Saved workflows, which are what a slash mostly offers. */
  const [workflows, setWorkflows] = useState<SavedTask[]>([]);
  /** What `/save` is doing, so the panel can say so rather than looking idle. */
  const [saving, setSaving] = useState<string>();
  /** A step only the person at the keyboard can do: a login, a code, a file. */
  const handover = useHandOver();
  const confirmation = useConfirm();
  const question = useAsk();
  const { turns, busy, send, stop, clear, tokens, lastRun, contextWindow } = useChat(profile, {
    mode,
    host: site?.host,
    confirm: confirmation.request,
    cancelConfirm: confirmation.cancel,
    ask: question.ask,
    cancelAsk: question.cancel,
    requestGrant: grant.request,
    cancelGrant: grant.cancel,
    handOver: handover.request,
    cancelHandOver: handover.cancel,
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
    const refresh = async () => {
      const current = await activeSite();
      setSite(current);
    };
    void refresh();
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(refresh);
    return () => {
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(refresh);
    };
  }, []);

  /**
   * What the endpoint can run, refreshed whenever the endpoint changes.
   *
   * So the picker under the composer has something to offer without the user
   * having gone to Settings and pressed Test. Silent on failure: an endpoint
   * that will not list its models is a text box, not an error.
   */
  useEffect(() => {
    let live = true;
    if (!profile.baseUrl) return;
    void loadApiKey(profile.name)
      .then((key) => listModels(profile.baseUrl, key))
      .then((found) => {
        if (live) setModels(found);
      });
    return () => {
      live = false;
    };
  }, [profile.baseUrl, profile.name]);

  useEffect(() => {
    void loadWorkflows().then(setWorkflows);
  }, []);

  const configured = profile.model.length > 0 && profile.baseUrl.length > 0;
  const toggle = (which: Pane) => setPane((open) => (open === which ? undefined : which));

  /**
   * Everything a slash reaches: the one built-in, then the saved workflows.
   *
   * `/save` first because it is the only one that exists before the user has
   * made any, and an empty menu teaches nobody that the feature is there.
   */
  const commands: Command[] = [
    {
      slug: 'save',
      name: 'save',
      hint: turns.length > 0 ? 'keep the last run as a workflow' : 'run something first',
      builtin: true,
    },
    ...workflows.map((task) => ({
      slug: task.slug!,
      name: task.name,
      hint: task.workflow?.varies ? `add ${task.workflow.varies}` : task.name,
    })),
  ];

  /**
   * Keep the last run, in the model's own account of it.
   *
   * Deliberately after the fact and deliberately asked for. Learning from every
   * run would produce a library of things nobody wants; "do that again" is a
   * judgement only the person who asked has.
   */
  const saveLastRun = async () => {
    const run = lastRun();
    if (!run) {
      setSaving('Nothing to save yet — run something first.');
      return;
    }
    setSaving('Writing down what it did…');
    const learned = await learnWorkflow(
      profile,
      run.task,
      run.steps.map((step) =>
        step.kind === 'tool' ? { kind: 'tool', tool: step.tool } : { kind: step.kind },
      ),
    );
    if (!learned) {
      setSaving('Could not work out what that run did. Nothing saved.');
      return;
    }
    const next = await saveWorkflow({
      name: learned.name,
      prompt: run.task,
      host: site?.host,
      workflow: learned,
    });
    setWorkflows(next.filter((task) => task.workflow && task.slug));
    const saved = next.find((task) => task.workflow?.learnedAt === learned.learnedAt);
    setSaving(`Saved as /${saved?.slug ?? learned.name}. Type it to run this again.`);
  };

  /**
   * Send, resolving a leading slash first.
   *
   * A workflow is invoked as `/name whatever is different this time`, and the
   * words after the name are the whole of what varies — which is why nothing
   * here has to guess which part of last time's run was incidental. The user
   * says.
   */
  const submit = (text: string) => {
    const trimmed = text.trim();
    setSaving(undefined);

    if (trimmed === '/save' || trimmed.startsWith('/save ')) {
      void saveLastRun();
      return;
    }

    const invoked = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
    const match = invoked && workflows.find((task) => task.slug === invoked[1]!.toLowerCase());
    if (match) {
      const detail = invoked![2]?.trim();
      // The saved request, plus whatever the user added. Both, because the
      // saved one carries the intent and the new words carry the difference.
      void send(detail ? `${match.prompt}\n\nThis time: ${detail}` : match.prompt, match.workflow);
      return;
    }

    void send(trimmed);
  };
  const start = (prompt: string) => void send(prompt);
  const runAndClose = (prompt: string) => {
    setPane(undefined);
    start(prompt);
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
          if (firstPrompt) setTimeout(() => start(firstPrompt), 0);
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
                <span className="site-ok">
                  <Icon name="check" size={11} />
                  readable
                </span>
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
              knownModels={models}
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
              onRun={start}
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
        {saving && !busy && (
          <p className="notice">
            <Icon name="sparkle" size={12} />
            {saving}
          </p>
        )}

        {busy && !confirmation.pending && !question.pending && !grant.pending && !handover.pending && (
          <p className="notice">
            <span className="notice-dot" aria-hidden="true" />
            Working — keep this panel open, the run stops if it closes.
          </p>
        )}

        {confirmation.pending && (
          <Confirm request={confirmation.pending} onAnswer={confirmation.answer} />
        )}

        {question.pending && <Ask question={question.pending} onAnswer={question.answer} />}

        {/* The run is stopped, and the next move is the user's own hands on
            their own page. */}
        {handover.pending && <HandOver request={handover.pending} onAnswer={handover.answer} />}

        {/* The run is stopped here until this is answered. The permission is
            offered where the run stopped, rather than described in a sentence
            the user has to go and act on somewhere else. */}
        {grant.pending && (
          <div className="prompt-sheet" role="alertdialog" aria-label="Allow a site">
            <p className="confirm-head">
              <Icon name="lock" size={13} />
              Needs your permission
            </p>
            <p className="confirm-what">
              heapbrowse has not been allowed to read <strong>{grant.pending.host}</strong>.
            </p>
            <p className="confirm-where">The run is waiting here until you decide.</p>
            <div className="confirm-actions">
              <button type="button" className="ghost deny" onClick={() => grant.answer(false)}>
                Not now
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  /*
                   * Not `async`, and nothing is awaited before the request.
                   * Chrome ties a permission prompt to the gesture still on the
                   * stack, and an `await` in front of it is how the prompt ends
                   * up never appearing at all.
                   */
                  void grantPattern(grant.pending!.pattern).then(async (allowed) => {
                    grant.answer(allowed);
                    if (allowed) setSite(await activeSite());
                  });
                }}
              >
                Allow {grant.pending.host}
              </button>
            </div>
          </div>
        )}

        <Composer
          busy={busy}
          disabled={!configured}
          text={draft}
          onText={setDraft}
          onSend={submit}
          onStop={stop}
          mode={mode}
          onMode={setMode}
          commands={commands}
          model={configured ? profile.model : undefined}
          models={models}
          onModel={(model) => {
            const next = { ...profile, model };
            setProfile(next);
            void saveProfile(next);
          }}
          endpoint={`${profile.name} — ${profile.baseUrl}`}
          meter={<ContextMeter tokens={tokens} window={contextWindow} />}
        />
      </div>
    </div>
  );
}
