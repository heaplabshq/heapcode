import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '@heapcode/core';
import {
  UI_METHODS,
  UI_PROTOCOL_VERSION,
  type UiAskUserParams,
  type UiConversationMeta,
  type UiEventParams,
  type UiHelloResult,
  type UiConnectionModelsResult,
  type UiListModelsResult,
  type UiProbeProviderParams,
  type UiProbeProviderResult,
  type UiOpenConversationResult,
  type UiPermissionRequestParams,
  type UiArtifactMeta,
  type UiArtifactResult,
  type UiArtifactsResult,
  type UiChangedFile,
  type UiChangesResult,
  type UiCheckpoint,
  type UiCheckpointsResult,
  type UiDiffResult,
  type UiFileTreeResult,
  type UiReadFileResult,
  type UiResetPermissionsResult,
  type UiReviewConfirmParams,
  type UiReviewEventParams,
  type UiReviewResult,
  type UiSearchResult,
  type UiSendMessageResult,
  type UiSettings,
  type UiState,
  type UiBrowseFoldersResult,
  type UiContextResult,
  type UiIndexStatus,
  type UiRepoMapResult,
  type UiSetWorkspaceResult,
  type UiWorkspacesResult,
} from '@heapcode/web-host/protocol';
import { Panel, type PanelTab } from './components/Panel.js';
import { terminalEntries } from './terminal.js';
import { findCommand, type Command } from './commands.js';
import { Palette } from './components/Palette.js';
import { Shortcuts } from './components/Shortcuts.js';
import { Settings, type UiProfileDraft } from './components/Settings.js';
import { RpcClient } from './rpc.js';
import {
  AskUserCard,
  PermissionCard,
  ReviewCard,
  type PendingAsk,
  type PendingPermission,
  type PendingReview,
} from './components/Cards.js';
import { Composer } from './components/Composer.js';
import { ModelPicker } from './components/ModelPicker.js';
import { MessageList } from './components/MessageList.js';
import { Sidebar } from './components/Sidebar.js';
import { WorkspacePicker } from './components/WorkspacePicker.js';
import { ContextMeter } from './components/ContextMeter.js';
import { ChatTools } from './components/ChatTools.js';
import { Announcer } from './components/Announcer.js';
import { useFinishNotification } from './notify.js';
import {
  activityOf,
  concat,
  emptyTranscript,
  fromMessages,
  reduce,
  settle,
  withAssistantNote,
  withNotice,
  withUserMessage,
  type Transcript,
} from './transcript.js';

/** The last thing the agent said, for the screen-reader announcement on finish. */
function lastReplyOf(t: Transcript): string | undefined {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const item = t.items[i]!;
    if (item.kind === 'text' && item.role === 'assistant') return item.text;
  }
  return undefined;
}

/**
 * What the transcript should say about a run that ended in something other
 * than a finished job.
 *
 * The browser used to ignore `outcome` entirely — every run just stopped, and
 * a run cut off at the step limit signed off with a summary of progress and
 * next steps that is indistinguishable from a completed one. The CLI has said
 * this for a while (App.tsx's pushSystem); this is the same wording.
 */
function outcomeNotice(res: UiSendMessageResult): { text: string; warn: boolean } | undefined {
  switch (res.outcome) {
    case 'max-iterations':
      return {
        text:
          `Ended at the ${res.maxIterations}-step limit, mid-task — the summary above is not a finished job. ` +
          "A follow-up starts fresh from that summary (the run's own transcript is gone), so say where to pick up — " +
          'or raise "maxIterations" in ~/.heapcode/config.json.',
        warn: true,
      };
    case 'incomplete':
      return {
        text:
          'The model kept replying without taking action and never confirmed a real completion — ' +
          'treat its last reply with suspicion. Rephrase the request or try again.',
        warn: true,
      };
    case 'stopped':
      return { text: 'Interrupted — send a new message to continue.', warn: false };
    default:
      return undefined;
  }
}

/** Permission modes, least to most autonomous — same order the CLI lists them. */
const MODES = ['plan', 'default', 'auto-edit', 'full-auto'];

/** Tools whose completion can change the workspace, so the panel refetches. */
const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'rename_file',
  'delete_file',
  'create_directory',
  'run_command',
]);

export function App(): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [state, setState] = useState<UiState>();
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [conversations, setConversations] = useState<UiConversationMeta[]>([]);
  // The rail is always present now; this is only whether it shows labels.
  // Remembered, because it is a preference about screen width, and re-making
  // that choice on every reload is the kind of small friction that adds up.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem('heapcode.rail') === 'collapsed',
  );
  const [permission, setPermission] = useState<PendingPermission>();
  const [ask, setAsk] = useState<PendingAsk>();
  const [review, setReview] = useState<PendingReview>();
  const [runId, setRunId] = useState<string>();
  /**
   * The run the *host* says is active, which is not always one this tab
   * started. A browser that reloads mid-run has no `agent/run` promise to
   * settle on, so `runId` alone never cleared and the composer stayed stuck on
   * "Running — Esc to stop" for the rest of the session. Tracking the host's
   * view separately keeps both directions honest: this tab's own run is busy
   * the instant it is sent (before the host has acknowledged it), and a run
   * inherited on reload stops being busy when the host says it ended.
   */
  const [hostRunId, setHostRunId] = useState<string>();
  /** When the visible run started, for the working indicator's clock. */
  const [runStartedAt, setRunStartedAt] = useState<number>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  /**
   * How the last run ended, when it ended badly — announced instead of the
   * usual "Finished", then cleared when the next run starts.
   */
  const [ending, setEnding] = useState<string>();
  const [settings, setSettings] = useState<UiSettings>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which part of Settings the user was reaching for, if they said. */
  const [settingsFocus, setSettingsFocus] = useState<'context'>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Text the global `/` shortcut hands to the composer; cleared once used. */
  const [seed, setSeed] = useState<string>();
  /**
   * The workspace panel, closed until asked for.
   *
   * It opened by default, which meant every new session started with half the
   * window given to a diff list that is empty until the agent has done
   * something — the conversation, which is the thing you came to have, was
   * squeezed into what was left. The changed-file count on the Workspace
   * button is the affordance that says when there is something in there.
   *
   * Remembered afterwards, like the rail: opening it is a statement about how
   * you want to work, and re-making that choice on every reload is exactly the
   * small friction this is meant to remove.
   */
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('heapcode.panel') === 'open');
  const [panelTab, setPanelTab] = useState<PanelTab>('changes');

  // One effect rather than a write at each of the eight places that open the
  // panel — including the ones the app opens for you, like a new artifact or a
  // clicked path. Whatever state you were left in is the one to come back to.
  useEffect(() => {
    localStorage.setItem('heapcode.panel', panelOpen ? 'open' : 'closed');
  }, [panelOpen]);
  const [changes, setChanges] = useState<UiChangedFile[]>([]);
  const [checkpoints, setCheckpoints] = useState<UiCheckpoint[]>([]);
  const [openPath, setOpenPath] = useState<string>();
  const [artifacts, setArtifacts] = useState<UiArtifactMeta[]>([]);
  const [indexStatus, setIndexStatus] = useState<UiIndexStatus>();
  const [selectedArtifact, setSelectedArtifact] = useState<string>();

  const seq = useRef(0);
  // `runCommand` needs to start a new conversation, but `newConversation` is
  // declared below it (it depends on things runCommand does not). A ref keeps
  // the ordering readable without a forward reference.
  const newConversationRef = useRef<() => void>();
  /** Arguments typed after a slash command, e.g. the query in `/search foo`. */
  const pendingArgs = useRef('');
  const rpc = useMemo(() => {
    const url = new URL(window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/rpc';
    url.search = '';
    // No token here: the launch URL already exchanged it for an HttpOnly
    // cookie, which the browser attaches to the upgrade for us. That is the
    // point of the exchange — the token is not reachable from this script.
    return new RpcClient(url.toString(), setStatus);
  }, []);

  const applyEvent = useCallback((event: AgentEvent) => {
    setTranscript((t) => reduce(t, event, seq.current++));
  }, []);

  const refreshArtifacts = useCallback(() => {
    void rpc
      .request<UiArtifactsResult>(UI_METHODS.artifacts)
      .then((r) => setArtifacts(r.artifacts))
      .catch(() => {});
  }, [rpc]);

  const loadArtifact = useCallback(
    (id: string, version?: number) => rpc.request<UiArtifactResult>(UI_METHODS.artifact, { id, version }),
    [rpc],
  );

  const refreshWorkspace = useCallback(() => {
    void rpc
      .request<UiChangesResult>(UI_METHODS.changes)
      .then((r) => setChanges(r.files))
      .catch(() => {
        /* the panel is non-critical — a failure here must not break chat */
      });
    void rpc
      .request<UiCheckpointsResult>(UI_METHODS.checkpoints)
      .then((r) => setCheckpoints(r.checkpoints))
      .catch(() => {});
  }, [rpc]);

  const refreshIndex = useCallback(() => {
    void rpc
      .request<UiIndexStatus>(UI_METHODS.indexStatus)
      .then(setIndexStatus)
      .catch(() => {
        /* the index panel is non-critical — a failure must not break chat */
      });
  }, [rpc]);

  const loadRepoMap = useCallback(
    (query: string) => rpc.request<UiRepoMapResult>(UI_METHODS.repoMap, { query }),
    [rpc],
  );

  const refreshConversations = useCallback(() => {
    void rpc
      .request<UiConversationMeta[]>(UI_METHODS.conversations)
      .then(setConversations)
      .catch(() => {
        /* sidebar is non-critical */
      });
  }, [rpc]);

  useEffect(() => {
    rpc.onNotification(UI_METHODS.event, (raw) => {
      const { event } = raw as UiEventParams;
      applyEvent(event);
      // A finished mutating tool means the changed set moved. Refetch rather
      // than inferring it here — the host knows, and guessing would drift.
      if (event.type === 'tool_result' && MUTATING_TOOLS.has(event.name)) refreshWorkspace();
    });
    rpc.onNotification(UI_METHODS.stateChanged, (raw) => {
      const next = raw as UiState;
      setState(next);
      setHostRunId(next.runId);
    });
    rpc.onNotification(UI_METHODS.workspaceChanged, (raw) => setChanges((raw as UiChangesResult).files));
    // Pushed rather than polled, so a long rebuild shows a moving bar.
    rpc.onNotification(UI_METHODS.indexChanged, (raw) => setIndexStatus(raw as UiIndexStatus));

    // A new artifact opens the Preview tab on it — the agent just made
    // something to look at, so showing it is the point.
    rpc.onNotification(UI_METHODS.artifactChanged, (raw) => {
      const meta = raw as UiArtifactMeta;
      setSelectedArtifact(meta.id);
      setPanelOpen(true);
      setPanelTab('preview');
      refreshArtifacts();
    });

    // Host→browser requests: the user's click IS the reply, so these resolve
    // only when a card is answered.
    rpc.onRequest(UI_METHODS.permissionRequest, (raw) => {
      const params = raw as UiPermissionRequestParams;
      return new Promise((resolve) => {
        setPermission({
          ...params,
          resolve: (choice) => {
            setPermission(undefined);
            resolve({ choice });
          },
        });
      });
    });

    // The review's own progress stream. Rendered as transcript notes rather
    // than as a banner: a review takes minutes and emits a dozen of these, and
    // a banner that replaces itself shows only the last one.
    rpc.onNotification(UI_METHODS.reviewEvent, (raw) => {
      const { kind, message } = raw as UiReviewEventParams;
      if (kind === 'error') setError(message);
      else setTranscript((t) => withAssistantNote(t, `**PR review** — ${message}`));
    });

    rpc.onRequest(UI_METHODS.reviewConfirm, (raw) => {
      const params = raw as UiReviewConfirmParams;
      return new Promise((resolve) => {
        setReview({
          ...params,
          resolve: (ok) => {
            setReview(undefined);
            resolve({ ok });
          },
        });
      });
    });

    rpc.onRequest(UI_METHODS.askUser, (raw) => {
      const params = raw as UiAskUserParams;
      return new Promise((resolve) => {
        setAsk({
          ...params,
          resolve: (answer) => {
            setAsk(undefined);
            resolve({ answer });
          },
        });
      });
    });

    let cancelled = false;
    // Re-sent on every reconnect, not just the first: a resumed socket with a
    // stale view is worse than a visible reconnect.
    rpc.onOpen = (): void => {
      if (cancelled) return;
      void rpc
        .request<UiHelloResult>(UI_METHODS.hello, {
          protocolVersion: UI_PROTOCOL_VERSION,
          client: { name: 'heapcode-web-ui' },
        })
        .then((hello) => {
          setError(undefined);
          setState(hello.state);
          // Rebuild the view from history, then fold in whatever the run we
          // reattached to has already emitted (§5.4).
          //
          // `pending` is preferred over `replay` when the host sends it: it is
          // the in-flight turn as the host recorded it — prompt included, and
          // not subject to the replay buffer's bound — so a tab that reloads
          // ten minutes into a run comes back to the whole turn rather than to
          // whatever fitted in the last 2,000 events. Replay is still folded in
          // for the events `pending` has no room for, the ones that describe
          // the run rather than the transcript.
          let next = fromMessages(hello.messages);
          if (hello.pending) {
            next = concat(next, fromMessages(hello.pending, 'live'));
            for (const e of hello.replay ?? []) {
              if (e.event.type === 'context_usage' || e.event.type === 'compaction')
                next = reduce(next, e.event, seq.current++);
            }
          } else {
            for (const e of hello.replay ?? []) next = reduce(next, e.event, seq.current++);
          }
          setTranscript(next);
          setRunId(undefined);
          setHostRunId(hello.activeRunId);
          refreshConversations();
          refreshWorkspace();
          refreshArtifacts();
          refreshIndex();
        })
        .catch((err: Error) => setError(err.message));
    };

    rpc.connect();
    return () => {
      cancelled = true;
      rpc.close();
    };
  }, [rpc, applyEvent, refreshConversations, refreshWorkspace, refreshArtifacts, refreshIndex]);

  // Stable identities so the Panel's effects can depend on them honestly
  // rather than re-fetching on every parent render.
  const loadDiff = useCallback(
    (path: string) => rpc.request<UiDiffResult>(UI_METHODS.diff, { path }),
    [rpc],
  );
  const loadTree = useCallback(
    (path: string) => rpc.request<UiFileTreeResult>(UI_METHODS.fileTree, { path }).then((r) => r.entries),
    [rpc],
  );
  const loadFile = useCallback(
    (path: string) => rpc.request<UiReadFileResult>(UI_METHODS.readFile, { path }),
    [rpc],
  );

  /** Clicking a path in a tool chip opens it in the Files tab. */
  const openInFiles = useCallback((path: string) => {
    setPanelOpen(true);
    setPanelTab('files');
    setOpenPath(path);
  }, []);

  /** Stable identity: the modal fetches on mount, so a new function each
   *  render would make it refetch on every parent render instead. */
  const loadContext = useCallback(
    () => rpc.request<UiContextResult>(UI_METHODS.context),
    [rpc],
  );


  const listProfileModels = useCallback(
    (profileName: string) =>
      rpc
        .request<UiListModelsResult>(UI_METHODS.listModels, { profileName })
        .then((r) => r.models.map((m) => m.id)),
    [rpc],
  );

  const probeProvider = useCallback(
    (params: UiProbeProviderParams) => rpc.request<UiProbeProviderResult>(UI_METHODS.probeProvider, params),
    [rpc],
  );

  const loadSkills = useCallback(
    () => rpc.request<{ skills: string }>(UI_METHODS.skills).then((r) => r.skills),
    [rpc],
  );

  const loadMemory = useCallback(
    () => rpc.request<{ instructions: string }>(UI_METHODS.memory).then((r) => r.instructions),
    [rpc],
  );

  /** Stable identity: the composer's seed effect depends on it. */
  const clearSeed = useCallback(() => setSeed(undefined), []);

  const refreshSettings = useCallback(() => {
    void rpc
      .request<UiSettings>(UI_METHODS.settings)
      .then(setSettings)
      .catch((err: Error) => setError(err.message));
  }, [rpc]);

  const openSettings = useCallback(
    (focus?: 'context') => {
      setSettingsFocus(focus);
      setSettingsOpen(true);
      refreshSettings();
    },
    [refreshSettings],
  );

  /**
   * The global keyboard map (`components/Shortcuts.tsx` is the written form).
   *
   * Two rules keep this from stealing keys people are trying to type:
   * unmodified shortcuts (`?`, `/`) only fire when focus is not in a text
   * field, and modified ones fire anywhere, because ⌘K in a textarea still
   * means ⌘K. Escape is handled per-layer by `useModal`, so it is not here —
   * one dialog closing must not close the three behind it at the same time.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true;

      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === 'k') {
          e.preventDefault();
          setPaletteOpen((v) => !v);
        } else if (key === ',') {
          e.preventDefault();
          openSettings();
        } else if (key === 'b') {
          e.preventDefault();
          setPanelOpen((v) => {
            if (!v) refreshWorkspace();
            return !v;
          });
        } else if (key === '\\') {
          e.preventDefault();
          setRailCollapsed((v) => {
            localStorage.setItem('heapcode.rail', v ? 'expanded' : 'collapsed');
            return !v;
          });
        } else if (e.shiftKey && key === 'n') {
          e.preventDefault();
          newConversationRef.current?.();
        }
        return;
      }

      if (typing) return;
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (e.key === '/') {
        // Focus the composer *with the slash in it*, so the menu opens. The
        // default has to be prevented (`/` is quick-find in some browsers),
        // which means the character has to be placed deliberately — focusing
        // alone would leave an empty box and swallow the keystroke.
        e.preventDefault();
        setSeed('/');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSettings, refreshWorkspace]);

  /**
   * Draws the line under a run that did not finish its job — in the transcript
   * where it stays, and once through the announcer for a reader who is not
   * looking at it.
   */
  const noteOutcome = useCallback((res: UiSendMessageResult) => {
    const note = outcomeNotice(res);
    if (!note) return;
    setTranscript((t) => withNotice(t, note.text, note.warn));
    setEnding(note.text);
  }, []);

  const runCommand = useCallback(
    (command: Command) => {
      setPaletteOpen(false);
      switch (command.name) {
        case '/help':
          // The palette IS the command list, so /help re-opening it would be a
          // no-op from inside it. The other half of "how do I use this" is the
          // keyboard map, which nothing else surfaced.
          setShortcutsOpen(true);
          return;
        case '/context':
          // The token budgets live on the profile, so land the user in its
          // editor rather than on the settings dialog's front page.
          openSettings('context');
          return;
        case '/settings':
        case '/profile':
        case '/persona':
        case '/websearch':
        case '/permissions':
        case '/nativetools':
        case '/subagents':
        case '/mcp':
          openSettings();
          return;
        case '/model':
        case '/mode':
          setNotice('Use the pickers in the bar under the composer.');
          return;
        case '/new':
        case '/clear':
          newConversationRef.current?.();
          return;
        case '/resume':
          // The list is always in the rail now; all this can do is make sure
          // the rail is not collapsed to icons.
          setRailCollapsed(false);
          return;

        // ---- workspace panel (W6) ----
        case '/revert':
          setPanelOpen(true);
          setPanelTab('changes');
          workspaceAct(UI_METHODS.revertAll, undefined);
          return;
        case '/checkpoints':
        case '/rewind':
          setPanelOpen(true);
          setPanelTab('changes');
          refreshWorkspace();
          setNotice('Checkpoints are listed under the changed files — pick one to rewind to.');
          return;
        case '/index':
          // Opens the tab that shows what the rebuild is doing, rather than
          // leaving a one-line notice as the only feedback.
          setPanelOpen(true);
          setPanelTab('index');
          setNotice('Rebuilding the index…');
          void rpc
            .request(UI_METHODS.reindex)
            .then(() => setNotice('Index rebuilt.'))
            .catch((err: Error) => setError(err.message))
            .finally(refreshIndex);
          return;
        case '/memory':
          void rpc
            .request<{ instructions: string }>(UI_METHODS.memory)
            .then((r) =>
              setTranscript((t) =>
                withAssistantNote(t, r.instructions.trim() || 'No project instructions or memory configured.'),
              ),
            )
            .catch((err: Error) => setError(err.message));
          return;
        case '/skills':
          void rpc
            .request<{ skills: string }>(UI_METHODS.skills)
            .then((r) => setTranscript((t) => withAssistantNote(t, r.skills.trim() || 'No skills available.')))
            .catch((err: Error) => setError(err.message));
          return;
        case '/pr-review': {
          const arg = pendingArgs.current.trim().toLowerCase();
          if (arg && arg !== 'deep' && arg !== 'fast') {
            setNotice('Usage: /pr-review [deep] — reviews the current branch\'s PR (needs the "gh" CLI).');
            return;
          }
          // A real id, like a task command: the review takes the run slot, so
          // Stop has to be able to name it.
          const id = crypto.randomUUID();
          setRunId(id);
          setError(undefined);
          setTranscript((t) =>
            withUserMessage(t, arg === 'deep' ? '/pr-review deep' : '/pr-review'),
          );
          void rpc
            .request<UiReviewResult>(UI_METHODS.review, { deep: arg === 'deep', runId: id })
            .then((res) => {
              const note =
                res.status === 'posted'
                  ? `**PR review** — posted on PR #${res.pr?.number} — ${res.pr?.url}`
                  : res.status === 'cancelled'
                    ? '**PR review** — nothing was posted.'
                    : '**PR review** — stopped before producing a review.';
              setTranscript((t) => withAssistantNote(t, note));
            })
            .catch((err: Error) => {
              if (!/cancel|abort/i.test(err.message)) setError(err.message);
            })
            .finally(() => {
              setRunId(undefined);
              setTranscript(settle);
            });
          return;
        }
        case '/search': {
          const query = pendingArgs.current.trim();
          if (!query) {
            setNotice('Usage: /search <query>');
            return;
          }
          void rpc
            .request<UiSearchResult>(UI_METHODS.search, { query })
            .then((r) => setTranscript((t) => withAssistantNote(t, `**${r.kind} search** — \`${query}\`\n\n${r.results}`)))
            .catch((err: Error) => setError(err.message));
          return;
        }
        default:
          break;
      }

      if (command.kind === 'task') {
        // A real id, not a placeholder: Stop has to be able to name this run.
        const id = crypto.randomUUID();
        setRunId(id);
        // Last run's bad ending is history now — otherwise the announcer would
        // read it out again when THIS run finishes cleanly.
        setEnding(undefined);
        setTranscript((t) => withUserMessage(t, command.name));
        void rpc
          .request<UiSendMessageResult>(UI_METHODS.runCommand, { command: command.name, runId: id })
          .then((res) => noteOutcome(res))
          .catch((err: Error) => {
            if (!/cancel|abort/i.test(err.message)) setError(err.message);
          })
          .finally(() => {
            setRunId(undefined);
            setTranscript(settle);
            refreshWorkspace();
          });
        return;
      }

      setNotice(`${command.name} isn't in the web UI yet — coming in ${command.milestone ?? 'a later milestone'}.`);
    },
    [rpc, openSettings],
  );

  const send = useCallback(
    (text: string, images?: string[]) => {
      // A slash command is a command, not a prompt — never send it to the model.
      if (text.startsWith('/')) {
        const command = findCommand(text);
        if (command) {
          pendingArgs.current = text.slice(command.name.length);
          return runCommand(command);
        }
        setNotice(`Unknown command: ${text.split(/\s+/)[0]}. Press ⌘K for the list.`);
        return;
      }
      const id = crypto.randomUUID();
      setRunId(id);
      setError(undefined);
      setEnding(undefined);
      setTranscript((t) => withUserMessage(t, text, images));
      void rpc
        .request<UiSendMessageResult>(UI_METHODS.sendMessage, { text, runId: id, images })
        .then((res) => noteOutcome(res))
        .catch((err: Error) => {
          // A cancelled run rejects here too; that is not an error worth a banner.
          if (!/cancel|abort/i.test(err.message)) setError(err.message);
        })
        .finally(() => {
          setRunId(undefined);
          setTranscript(settle);
          refreshConversations();
        });
    },
    [rpc, refreshConversations],
  );

  const cancel = useCallback(() => {
    // Falls back to the host's id so Stop still works on a run this tab
    // inherited after a reload — the host cancels whatever is active either
    // way, but sending nothing at all would have been a dead button.
    const target = runId ?? hostRunId;
    if (!target) return;
    setNotice('Stopping…');
    void rpc
      .request(UI_METHODS.cancel, { runId: target })
      .then(() => setNotice('Stopped.'))
      .catch((err: Error) => setError(`Could not stop the run: ${err.message}`));
  }, [rpc, runId, hostRunId]);

  const openConversation = useCallback(
    (id: string) => {
      void rpc
        .request<UiOpenConversationResult>(UI_METHODS.openConversation, { id })
        .then((res) => {
          setTranscript(fromMessages(res.messages));
          refreshConversations();
        })
        .catch((err: Error) => setError(err.message));
    },
    [rpc, refreshConversations],
  );

  /**
   * Point the session at another folder.
   *
   * Everything on screen belongs to the old workspace, so this resets the view
   * wholesale rather than letting the panel, the artifacts and the transcript
   * refresh at their own pace — a half-swapped UI showing this repo's diff
   * beside that repo's conversation is worse than a blank one.
   *
   * The promise is returned, not swallowed: the picker keeps its popup open
   * and shows the reason when a folder cannot be opened.
   */
  const switchWorkspace = useCallback(
    (path: string) =>
      rpc.request<UiSetWorkspaceResult>(UI_METHODS.setWorkspace, { path }).then((res) => {
        setState(res.state);
        setHostRunId(res.state.runId);
        setTranscript(fromMessages(res.messages));
        setError(undefined);
        setChanges([]);
        setCheckpoints([]);
        setArtifacts([]);
        setSelectedArtifact(undefined);
        setOpenPath(undefined);
        setNotice(`Now working in ${res.state.workspaceName}.`);
        refreshConversations();
        refreshWorkspace();
        refreshArtifacts();
      }),
    [rpc, refreshConversations, refreshWorkspace, refreshArtifacts],
  );

  const newConversation = useCallback(() => {
    void rpc
      .request<UiOpenConversationResult>(UI_METHODS.newConversation)
      .then(() => {
        setTranscript(emptyTranscript);
        refreshConversations();
      })
      .catch((err: Error) => setError(err.message));
  }, [rpc, refreshConversations]);

  newConversationRef.current = newConversation;

  // Either source counts: this tab's own in-flight request, or a run the host
  // reports (one started before a reload, or from another tab).
  const busy = Boolean(runId ?? hostRunId);


  // The indicator's clock starts when the run becomes visible here and stops
  // with it. Timed from this tab rather than from the host, which does not
  // record a start time — for a run inherited on reload that means "since you
  // reattached", which is the only thing this side can honestly claim.
  useEffect(() => {
    setRunStartedAt(busy ? Date.now() : undefined);
  }, [busy]);

  // A long run that ends while the tab is in the background gets a desktop
  // notification — the whole reason to run this in a browser is to be able to
  // go elsewhere while it works.
  useFinishNotification(busy, runStartedAt, state?.workspaceName ?? 'your workspace');

  return (
    <div className="app">
      <div className="body">
        <Sidebar
          collapsed={railCollapsed}
          onToggleCollapsed={() =>
            setRailCollapsed((v) => {
              localStorage.setItem('heapcode.rail', v ? 'expanded' : 'collapsed');
              return !v;
            })
          }
          conversations={conversations}
          onOpen={openConversation}
          onNew={newConversation}
          busy={busy}
          state={state}
          status={status}
          onOpenArtifacts={() => {
            setPanelOpen(true);
            setPanelTab('preview');
            refreshArtifacts();
          }}
          onOpenSettings={openSettings}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        <main className="chat">
          <ChatTools
            panelOpen={panelOpen}
            changeCount={changes.length}
            onTogglePanel={() => {
              const next = !panelOpen;
              setPanelOpen(next);
              if (next) refreshWorkspace();
            }}
          />

          {state?.lan && (
            <div className="banner banner-warn" role="alert">
              <strong>Exposed to your network.</strong>
              <span>
                Anyone who can reach this address and holds the launch token can run commands on{' '}
                {state.workspaceName || 'this machine'} as you.
              </span>
            </div>
          )}
          {status === 'closed' && <div className="banner">Disconnected — reconnecting…</div>}
          {error && <div className="banner banner-error">{error}</div>}
          {notice && (
            <div className="banner" onClick={() => setNotice(undefined)} role="status">
              {notice}
            </div>
          )}

          <MessageList
            transcript={transcript}
            onOpenPath={openInFiles}
            busy={busy}
            runStartedAt={runStartedAt}
          />

          <Announcer busy={busy} activity={activityOf(transcript)} lastReply={lastReplyOf(transcript)} ending={ending} />

          {permission && <PermissionCard pending={permission} />}
          {ask && <AskUserCard pending={ask} />}
          {review && <ReviewCard pending={review} />}

          <Composer
            onSend={send}
            onCancel={cancel}
            onReject={setNotice}
            seed={seed}
            onSeedUsed={clearSeed}
            busy={busy}
            disabled={status !== 'open'}
            footer={
              <>
                {/* Which folder, then how much freedom, then which model —
                    left to right, widest scope first. All three describe the
                    message you are about to send, which is why they live on
                    the composer rather than in the rail. */}
                <WorkspacePicker
                  current={state?.root ?? ''}
                  busy={busy}
                  loadWorkspaces={() => rpc.request<UiWorkspacesResult>(UI_METHODS.workspaces)}
                  browse={(path) => rpc.request<UiBrowseFoldersResult>(UI_METHODS.browseFolders, { path })}
                  onPick={switchWorkspace}
                />

                <select
                  className="bar-select"
                  value={state?.permissionMode ?? 'default'}
                  onChange={(e) => void rpc.request(UI_METHODS.setMode, { mode: e.target.value }).catch(() => {})}
                  aria-label="Permission mode"
                  title="How much the agent may do without asking"
                >
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>

                <div className="composer-bar-right">
                  <ContextMeter
                    used={transcript.usedTokens}
                    live={busy}
                    // Idle, the meter re-prices itself from `load`; this tells
                    // it when the thing being priced has moved underneath it —
                    // a conversation switched, a new chat started.
                    revision={transcript.items.length}
                    window={transcript.windowTokens || state?.contextWindow}
                    load={loadContext}
                    onOpenSettings={() => openSettings('context')}
                  />
                  <ModelPicker
                    current={state?.model ?? ''}
                    placement="up"
                    listModels={() => rpc.request<UiListModelsResult>(UI_METHODS.listModels).then((r) => r.models)}
                    onPick={(model) => void rpc.request(UI_METHODS.setModel, { model }).catch(() => {})}
                  />
                </div>
              </>
            }
          />
        </main>

        {panelOpen && (
          <Panel
            tab={panelTab}
            onTab={setPanelTab}
            onClose={() => setPanelOpen(false)}
            changes={changes}
            checkpoints={checkpoints}
            terminal={terminalEntries(transcript.items)}
            busy={busy}
            openPath={openPath}
            loadDiff={loadDiff}
            loadTree={loadTree}
            loadFile={loadFile}
            onRevertFile={(path) => workspaceAct(UI_METHODS.revertFile, { path })}
            onRevertAll={() => workspaceAct(UI_METHODS.revertAll, undefined)}
            onKeepAll={() => workspaceAct(UI_METHODS.keepAll, undefined)}
            onRewind={(hash) => workspaceAct(UI_METHODS.rewind, { hash })}
            indexStatus={indexStatus}
            loadRepoMap={loadRepoMap}
            onReindex={() => {
              setNotice('Rebuilding the index…');
              void rpc
                .request(UI_METHODS.reindex)
                .then(() => setNotice('Index rebuilt.'))
                .catch((err: Error) => setError(err.message))
                .finally(refreshIndex);
            }}
            onClearIndex={() => {
              void rpc
                .request(UI_METHODS.reindex, { clear: true })
                .then(() => setNotice('Index cleared.'))
                .catch((err: Error) => setError(err.message))
                .finally(refreshIndex);
            }}
            onOpenPath={openInFiles}
            artifacts={artifacts}
            selectedArtifact={selectedArtifact}
            onSelectArtifact={setSelectedArtifact}
            loadArtifact={loadArtifact}
            onSaveArtifact={(id, path, version) => {
              void rpc
                .request(UI_METHODS.saveArtifact, { id, path, version })
                .then(() => setNotice(`Saved to ${path}.`))
                .catch((err: Error) => setError(err.message))
                .finally(refreshWorkspace);
            }}
          />
        )}
      </div>

      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} onPick={runCommand} />}

      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}

      {settingsOpen && (
        <Settings
          settings={settings}
          focus={settingsFocus}
          onClose={() => setSettingsOpen(false)}
          onSetPersona={(persona) => act(UI_METHODS.setPersona, { persona })}
          onToggleSubAgents={(enabled) => act(UI_METHODS.setSubAgents, { enabled })}
          onToggleNativeTools={(enabled) => act(UI_METHODS.setNativeTools, { enabled })}
          onSetWebSearch={(patch) => act(UI_METHODS.setWebSearch, patch)}
          onUseProfile={(name) => act(UI_METHODS.useProfile, { name })}
          onSetRole={(role, assignment) => act(UI_METHODS.setRole, { role, assignment })}
          listConnectionModels={(connection) =>
            rpc
              .request<UiConnectionModelsResult>(UI_METHODS.listConnectionModels, { connection })
              // An endpoint that is not running degrades the row, not the
              // screen — the row falls back to typing an id by hand.
              .then((r) => r.models)
              .catch(() => [])
          }
          onDeleteProfile={(name) => act(UI_METHODS.deleteProfile, { name })}
          onSaveProfile={(profile: UiProfileDraft, apiKey?: string) =>
            act(UI_METHODS.saveProfile, { profile, apiKey })
          }
          onSaveMcpServer={(name, spec) => act(UI_METHODS.saveMcpServer, { name, spec })}
          onDeleteMcpServer={(name) => act(UI_METHODS.deleteMcpServer, { name })}
          loadSkills={loadSkills}
          loadMemory={loadMemory}
          listModels={listProfileModels}
          probeProvider={probeProvider}
          onResetPermissions={() => {
            void rpc
              .request<UiResetPermissionsResult>(UI_METHODS.resetPermissions)
              .then((r) => setNotice(`Cleared ${r.cleared} saved grant${r.cleared === 1 ? '' : 's'}.`))
              .catch((err: Error) => setError(err.message))
              .finally(refreshSettings);
          }}
        />
      )}
    </div>
  );

  /** Every settings mutation: fire it, then re-read the truth from the host. */
  function act(method: string, params: unknown): void {
    void rpc
      .request(method, params)
      .catch((err: Error) => setError(err.message))
      .finally(refreshSettings);
  }

  /** Same pattern for the workspace panel — the host is the source of truth. */
  function workspaceAct(method: string, params: unknown): void {
    void rpc
      .request(method, params)
      .catch((err: Error) => setError(err.message))
      .finally(refreshWorkspace);
  }
}
