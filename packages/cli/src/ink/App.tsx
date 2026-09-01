import { randomUUID } from 'node:crypto';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import { useTerminalColumns } from './useTerminalColumns.js';
import { isFailure, readClipboardImage } from '../clipboardImage.js';

/** Matches the web composer's cap, so the two hosts refuse at the same point. */
const MAX_ATTACHED_IMAGES = 8;
import {
  builtinPrompts,
  BUILTIN_PERSONAS,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  DEFAULT_MAX_ITERATIONS,
  SEARCH_PRESETS,
  WEB_SEARCH_SECRET_NAME,
  describeWebSearchState,
  getSearchPreset,
  isSearchPresetId,
  PERMISSION_MODE_INFO,
  applyModeToPersona,
  cyclePermissionMode,
  filterToolsForPersona,
  getPermissionModeInfo,
  getPersona,
  intersectPersonas,
  isPermissionMode,
  resolveCapabilities,
  ASK_USER_COUNTDOWN_MS,
  ASK_USER_NO_ANSWER,
  IdleDeadline,
  INIT_TASK,
  METHODS,
  askUserAnswerMessage,
  askUserBlocksAction,
  askUserIdleMessage,
  parseSlashCommand,
  renderTemplate,
  type AgentEvent,
  type AgentEventParams,
  type AgentPersona,
  type AgentRunParams,
  type AgentRunResult,
  type Conversation,
  type KeyRequestParams,
  type KeyRequestResult,
  type ListModelsParams,
  type ListModelsResult,
  type McpManager,
  type PermissionChoice,
  type PermissionMode,
  type PermissionRequestParams,
  type PermissionRequestResult,
  type ProviderProfileConfig,
  type RagEventParams,
  type RagIndexParams,
  type RagIndexResult,
  type RagQueryParams,
  type RagQueryResult,
  type RagStatusResult,
  type ReviewClient,
  type ReviewConfirmParams,
  type ReviewConfirmResult,
  type ReviewEvent,
  type ReviewEventParams,
  type ReviewRunParams,
  type ReviewRunResult,
  type SnapshotBeforeParams,
  type StoredMessage,
  type ToolCall,
  type ToolDefinition,
  type ToolExecuteParams,
  type ToolResult,
  buildAgentTask,
} from '@heapcode/core';
import {
  DELEGATE_TASK_TOOL,
  configFile,
  createContextWindowResolver,
  describeMcpServer,
  loadMcpServerSources,
  mcpNameProblem,
  parseMcpServerSpec,
  listPermissionGrants,
  listSkillsFormatted,
  permissionsFile,
  secretsFile,
  trimHistoryForAgent,
  type ConfigStore,
  type JsonConversationStore,
  type PermissionEngine,
  type RepoMapIndexer,
  type SecretsStore,
  type SessionCheckpoint,
  type ShadowGit,
  type WorkspaceToolExecutor,
} from '@heapcode/host';
import { loadProjectInstructions } from '../memory.js';
import { connectToServer, type ConnectOptions, type ServerConnection } from '../server/client.js';
import { Composer, type SlashCommand } from './Composer.js';
import { FilterableList } from './FilterableList.js';
import { Header } from './Header.js';
import { Setup } from './Setup.js';
import { TextInput } from './TextInput.js';
import { MessageView } from './MessageView.js';
import { renderMarkdown } from '../markdown.js';
import { PermissionPrompt, type PermissionRequest } from './PermissionPrompt.js';
import { AskUserPrompt, type AskUserRequest } from './AskUserPrompt.js';
import { ToolChip } from './ToolChip.js';
import { languageForPath } from './codeLanguage.js';
import type { TranscriptItem } from './types.js';

// Matches ToolChip's own SUMMARY_CHARS — no point sending more to the chip
// than it will ever show, but this is the true "how much can survive" cap.
// Generous on purpose: run_command output (test failures, stack traces) and
// edit_file/multi_edit's diff both need real room, not a one-line preview.
const TOOL_SUMMARY_CHARS = 4000;

const COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Show available commands' },
  { name: '/model', args: '[id]', description: 'Switch the model (fetches the provider’s list)' },
  { name: '/profile', args: '[add|list|remove|name]', description: 'Switch, add, list, or remove provider profiles' },
  { name: '/persona', args: '[name]', description: 'Switch persona: agent, architect, debug, reviewer' },
  { name: '/mode', args: '[name]', description: 'Permission mode: plan, default, auto-edit, full-auto (Shift+Tab cycles)' },
  { name: '/websearch', args: '[provider|on|off]', description: 'Web search for the agent — off until you configure a provider' },
  { name: '/permissions', args: '[reset]', description: 'Show or clear saved "Always allow" grants for this project' },
  { name: '/nativetools', args: '[on|off]', description: 'Native tool calling vs the text protocol — turn off for models that reject tools' },
  { name: '/settings', description: 'Show current configuration' },
  { name: '/init', description: 'Set up .heapcode/HEAPCODE.md & memory.md for this project (runs as an agent task)' },
  { name: '/memory', description: 'Show the project instructions & memory the agent sees' },
  { name: '/skills', description: 'List available Skills' },
  { name: '/search', args: '<query>', description: 'Search the workspace (semantic if indexed, plain text otherwise)' },
  { name: '/index', description: 'Rebuild the semantic search + repo map indexes' },
  { name: '/pr-review', args: '[deep]', description: "Review the current branch's PR and (on confirmation) post it to GitHub — needs the gh CLI" },
  { name: '/mcp', args: '[add <name> <command…|url>|remove <name>]', description: 'List, add, or remove MCP servers' },
  { name: '/subagents', args: '[on|off]', description: 'Toggle delegate_task — lets the agent hand off sub-tasks to a fresh sub-agent' },
  { name: '/clear', description: 'Clear the screen and start a new conversation' },
  { name: '/new', description: 'Start a new conversation' },
  { name: '/resume', description: 'Pick an earlier conversation to continue' },
  { name: '/rewind', args: '[n]', description: 'Undo the last n checkpoints — works even across /new or /resume' },
  { name: '/revert', description: 'Restore every file this session touched' },
  { name: '/checkpoints', description: 'List recent checkpoints for this project' },
  { name: '/exit', description: 'Quit heapcode' },
  // Prompt templates (core's builtinPrompts): /explain, /fix, /review, … —
  // rendered into a task and run through the normal agent loop.
  ...builtinPrompts.map((p) => ({ name: `/${p.command}`, args: '<input>', description: p.title })),
];

const HELP_TEXT = COMMANDS.map((c) => `  ${(c.name + (c.args ? ` ${c.args}` : '')).padEnd(18)}${c.description}`).join('\n');

/** How /pr-review identifies itself in the posted review body — the extension passes its own. */
const CLI_REVIEW_CLIENT: ReviewClient = {
  attribution: 'the Heap Code CLI',
  deepHint: 'run "/pr-review deep"',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Picker {
  title: string;
  items: Array<{ label: string; value: string }>;
  /**
   * Renders a type-to-filter list instead of a plain arrow-key one. Only for
   * lists long enough to need it — on a short confirm ("yes"/"no") swallowing
   * keystrokes into a filter box would be surprising, not helpful.
   */
  filterable?: boolean;
  onPick(value: string): void;
  /** Called when the picker is dismissed with esc/ctrl+c instead of picked. Required by any caller awaiting a choice — without it, esc leaves that promise pending forever. */
  onCancel?(): void;
}

/** Dismisses the picker and runs its cancel handler — the single path both esc and ctrl+c go through. */
function cancelPicker(picker: Picker | undefined, clear: () => void): void {
  clear();
  picker?.onCancel?.();
}

export interface AppProps {
  profile: ProviderProfileConfig;
  conversation: Conversation;
  historyStore: JsonConversationStore;
  executor: WorkspaceToolExecutor;
  checkpoint: SessionCheckpoint;
  permissions: PermissionEngine;
  shadowGit?: ShadowGit;
  tools: ToolDefinition[];
  workspaceName: string;
  contextWindow: number;
  /** Enables /model and /profile persistence; omitted in tests. */
  configStore?: ConfigStore;
  /** Needed by "/profile add" (stores the API key) and "/profile remove" (deletes it). */
  secretsStore?: SecretsStore;
  /** Re-resolves the context window for a /profile switch. No Provider: nothing host-side calls one. */
  switchProvider?(profile: ProviderProfileConfig): Promise<{ contextWindow: number }>;
  version?: string;
  cwd?: string;
  safeMode?: boolean;
  /** Mode this session starts in (--permission-mode). Shift+Tab cycles from here. */
  permissionMode?: PermissionMode;
  /**
   * Reports a Shift+Tab (or /mode) change back to the host, which owns the
   * getter the PermissionEngine reads. Without this the engine would keep
   * answering from the mode the session launched with.
   */
  onPermissionModeChange?(mode: PermissionMode): void;
  /** Hands the host a sink for permission-engine log lines, so they reach the transcript. */
  onPermissionLogReady?(log: (message: string) => void): void;
  /** Earlier conversations exist in this project at launch — shows the /resume hint. */
  canResume?: boolean;
  /** Lazy source for `@` mention autocomplete (ignore-aware workspace paths, folders end with `/`). */
  listWorkspaceFiles?(): Promise<string[]>;
  /** Structural repo outline — the @workspace fallback when the semantic index has nothing. */
  repoMapIndexer?: RepoMapIndexer;
  /** MCP servers — reconnected at the start of every task; their tools go through the same permission system as workspace tools. */
  mcpManager?: McpManager;
  /** Local audit log (see audit.ts) — best-effort, never blocks on failure. */
  onTrack?(name: string, meta?: Record<string, unknown>): void;
  /** Fired once on mount and again whenever the active conversation changes (/new, /resume) — lets the host print the session id on exit. */
  onSessionChange?(id: string): void;
  /** Best-effort registry check for a newer published version — omitted (no-op) when disabled via --no-update-check or config, or in tests/headless. */
  checkUpdate?(): Promise<{ current: string; latest: string } | undefined>;
  /**
   * Opt-in idle bound on an ask_user question, in ms — from
   * `askUserQuestionTimeout` in ~/.heapcode/config.json. Undefined (the
   * default) means the question waits indefinitely, exactly as before.
   */
  askUserIdleMs?: number;
  /**
   * Ceiling on model turns per run, from `maxIterations` in
   * ~/.heapcode/config.json. Undefined means core's own default.
   */
  maxIterations?: number;
  /** Test seam: point at an already-running core server instead of autostarting one. */
  server?: ConnectOptions;
}

export function App({
  profile,
  conversation,
  historyStore,
  executor,
  checkpoint,
  permissions,
  shadowGit,
  tools,
  workspaceName,
  contextWindow,
  configStore,
  secretsStore,
  switchProvider,
  version,
  cwd,
  safeMode,
  permissionMode: initialPermissionMode,
  onPermissionModeChange,
  onPermissionLogReady,
  canResume,
  listWorkspaceFiles,
  repoMapIndexer,
  mcpManager,
  onTrack,
  onSessionChange,
  checkUpdate,
  askUserIdleMs,
  maxIterations,
  server,
}: AppProps): React.ReactElement {
  const { exit } = useApp();

  // Session state that /model and /profile can change mid-session. The props
  // are just the initial values resolved by cli.tsx.
  const [active, setActive] = useState({ profile, contextWindow });
  const [model, setModel] = useState(profile.agentModel || profile.model);
  /**
   * Derived from the live profile, not from the launch-time prop. The prop is
   * resolved once in cli.tsx, so it went stale the moment the session switched
   * profiles with /profile — a run could keep using native tool calling after
   * moving to a profile that disables it. /nativetools has the same
   * requirement, so both are served by reading the current profile here.
   */
  const effectiveNativeToolCalls = resolveCapabilities(active.profile).nativeToolCalls;

  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(
    initialPermissionMode ?? DEFAULT_PERMISSION_MODE,
  );
  /**
   * Read by runTask, which is called from handlers registered once — the
   * state value there would be whichever mode was current when the handler
   * closed over it, so a mid-run Shift+Tab would not reach the next task.
   */
  const permissionModeRef = useRef(permissionMode);

  function setPermissionMode(mode: PermissionMode): void {
    permissionModeRef.current = mode;
    setPermissionModeState(mode);
    onPermissionModeChange?.(mode);
  }

  const headerItem = (messageCount: number): TranscriptItem => ({
    kind: 'header',
    version,
    profileName: active.profile.name,
    model,
    baseUrl: active.profile.baseUrl,
    cwd,
    messageCount,
    canResume,
  });

  const initialMessages = conversation.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const [items, setItems] = useState<TranscriptItem[]>([
    headerItem(initialMessages.length),
    ...initialMessages.map((m) => ({ kind: 'message' as const, message: m })),
  ]);
  const itemsRef = useRef(items);
  // Remount key for <Static>: Static only ever appends, so /new replaces the
  // whole element (fresh key) instead of trying to shrink its item list.
  const [staticKey, setStaticKey] = useState(0);
  const pushItem = (item: TranscriptItem) => {
    itemsRef.current = [...itemsRef.current, item];
    setItems(itemsRef.current);
  };
  const pushSystem = (text: string) => pushItem({ kind: 'system', text });

  const conversationRef = useRef(conversation);
  // Reports only the initial id, once — /new and /resume report their own changes at the point they happen.
  useEffect(() => {
    onSessionChange?.(conversationRef.current.id);
  }, []);

  // Fire-and-forget, once per process — never blocks startup, never a
  // prompt. Renders as one dim line under the banner, same as any other
  // system notice, whenever (if ever) the registry check resolves.
  useEffect(() => {
    void checkUpdate?.().then((result) => {
      if (result) pushSystem(`Update available: v${result.current} → v${result.latest} · npm i -g @heaplabs/heapcode-cli`);
    });
  }, []);

  // Terminal columns, for the footer's manual truncation below — Ink boxes
  // stretch to fill exactly what stdout reports, with no safety margin, so a
  // long dynamic string (e.g. an Ollama model tag) can overflow by a column
  // or two and wrap ugly instead of just getting clipped. The hook (unlike
  // reading stdout.columns inline) re-renders on resize, so the truncation
  // tracks the live width.
  const { stdout } = useStdout();
  const columns = useTerminalColumns();

  // Full-UI repaint on terminal resize — transcript included. Ink's own
  // resize handler re-lays-out only the live region (composer, footer, any
  // open prompt); everything already emitted through <Static> was written
  // physically at the old width, and on a narrower window the terminal
  // rewraps those lines itself. That both leaves the visible transcript
  // mis-wrapped and invalidates the line counts Ink's incremental eraser
  // relies on, which is where the stray border fragments came from. So on
  // the (debounced — see cli.tsx) resize event: wipe screen + scrollback
  // and remount <Static>, which re-emits the entire transcript laid out
  // against the new width — the same full-reset mechanism resetTranscript
  // uses for /clear. Listening on Ink's context stdout (not process.stdout)
  // keeps this inert under tests' fake streams.
  useEffect(() => {
    const repaintOnResize = (): void => {
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setStaticKey((k) => k + 1);
    };
    stdout.on('resize', repaintOnResize);
    return () => {
      stdout.off('resize', repaintOnResize);
    };
  }, [stdout]);

  const [liveText, setLiveText] = useState('');
  const [liveTool, setLiveTool] = useState<Extract<TranscriptItem, { kind: 'tool' }>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingPermission, setPendingPermission] = useState<{ req: PermissionRequest; resolve: (c: PermissionChoice) => void }>();
  const [pendingQuestion, setPendingQuestion] = useState<{ req: AskUserRequest; resolve: (a: string) => void }>();
  /**
   * Seconds left on a pending question's idle bound, once inside the countdown
   * window. Undefined whenever there is nothing to count down — no timeout
   * configured, a blocksAction question, or still more than
   * ASK_USER_COUNTDOWN_MS away.
   */
  const [questionCountdown, setQuestionCountdown] = useState<number>();
  /** Whatever the user has typed or highlighted so far, for an expiring question to hand over. */
  const questionPartial = useRef('');
  /** Activity resets the pending question's deadline — see the useInput handler. */
  const questionDeadline = useRef<IdleDeadline>();
  const [picker, setPicker] = useState<Picker>();
  /** A masked inline prompt for a secret (currently the web-search API key). */
  const [pendingSecret, setPendingSecret] = useState<{ label: string; onSubmit(value: string): void | Promise<void> }>();
  const [setupActive, setSetupActive] = useState(false);
  const [persona, setPersona] = useState<AgentPersona>(getPersona(undefined));
  // Sub-agent orchestration (delegate_task) is opt-in — a new,
  // autonomy-increasing capability, same posture as the extension's own
  // subAgents setting: off by default, toggled explicitly.
  const [subAgentsEnabled, setSubAgentsEnabled] = useState(false);
  const [liveSubTool, setLiveSubTool] = useState<Extract<TranscriptItem, { kind: 'tool' }>>();
  const [mentionCandidates, setMentionCandidates] = useState<string[]>();
  const mentionLoadStarted = useRef(false);

  const handleMentionTrigger = (): void => {
    if (mentionLoadStarted.current || !listWorkspaceFiles) return;
    mentionLoadStarted.current = true;
    void listWorkspaceFiles()
      .then((files) => setMentionCandidates(['workspace', ...files]))
      .catch(() => {
        // Autocomplete is best-effort — mentions still work as typed text.
      });
  };

  /**
   * The review currently running, so the connection's own handlers can route
   * review/event and review/confirm to it — the same shape activeRun has for
   * agent runs.
   */
  const reviewRun = useRef<{
    runId: string;
    onEvent(event: ReviewEvent): void;
    confirm(confirmation: ReviewConfirmParams['confirmation']): Promise<boolean>;
  }>();

  // Drives the pending question's countdown. One interval for the whole app
  // rather than a timer per prompt, and it only exists while a bounded question
  // is actually up.
  useEffect(() => {
    if (!pendingQuestion) return;
    const tick = (): void => {
      const remaining = questionDeadline.current?.remainingMs() ?? Number.POSITIVE_INFINITY;
      setQuestionCountdown(
        Number.isFinite(remaining) && remaining <= ASK_USER_COUNTDOWN_MS ? Math.ceil(remaining / 1_000) : undefined,
      );
    };
    tick();
    const handle = setInterval(tick, 500);
    return () => clearInterval(handle);
  }, [pendingQuestion]);

  const [indexProgress, setIndexProgress] = useState<{ embedded: number; total: number }>();

  // Build both indexes once at mount, in the background — never blocks the
  // composer. The repo map stays in-process (pure parsing, no key needed); the
  // semantic index lives in the server, so building it means connecting. That
  // is why this is best-effort: an unreachable server must not turn launching
  // the CLI into an error, it just means no semantic search until a task
  // connects for real.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await repoMapIndexer?.init();
      if (cancelled) return;
      void repoMapIndexer?.buildIndex();
      await requestIndex({ full: true }).catch(() => {});
      if (!cancelled) setIndexProgress(undefined);
    })();
    return () => {
      cancelled = true;
    };
    // The repo-map indexer is a stable instance for the process lifetime
    // (constructed once in cli.tsx) — run once on mount only.
  }, []);

  /**
   * Ask the server to index. Progress arrives as `rag/event` notifications
   * rather than a callback, since the work is in another process now.
   *
   * contextualRetrieval is passed explicitly and always on: the CLI has no
   * setting for it and never did, unlike the extension where it ships off.
   * Decision 6 of the RAG migration keeps that per-host difference by making
   * it a request parameter instead of something the index reads for itself.
   */
  async function requestIndex(params: Omit<RagIndexParams, 'contextualRetrieval'>): Promise<RagIndexResult | undefined> {
    const connection = await ensureConnection();
    return connection.peer.request<RagIndexResult>(METHODS.ragIndex, {
      ...params,
      contextualRetrieval: true,
    } satisfies RagIndexParams);
  }

  /** Index state from the server; undefined when it cannot be reached at all. */
  async function requestStatus(): Promise<RagStatusResult | undefined> {
    try {
      const connection = await ensureConnection();
      return await connection.peer.request<RagStatusResult>(METHODS.ragStatus);
    } catch {
      return undefined;
    }
  }

  /** Semantic retrieval from the server. Empty (never throwing) when there is nothing to retrieve. */
  async function requestQuery(text: string, k?: number): Promise<RagQueryResult> {
    try {
      const connection = await ensureConnection();
      return await connection.peer.request<RagQueryResult>(METHODS.ragQuery, { text, k } satisfies RagQueryParams);
    } catch {
      return { formatted: '', hits: [] };
    }
  }

  /**
   * Keeps both indexes in sync with the agent's own file edits. The host is
   * what knows a file changed, so the trigger stays here even though the work
   * moved — see docs/phase3-rag-design.md §4. There is still no filesystem
   * watcher: a terminal session has no open editor, and the agent's own write
   * tools are the only mutations that matter in practice.
   *
   * One `rag/index` call covers every case. A delete needs no shape of its
   * own because indexing a path the server cannot read drops it, and a rename
   * is the two paths together for the same reason.
   */
  async function syncIndexesAfterTool(name: string, args: Record<string, unknown>): Promise<void> {
    const path = typeof args.path === 'string' ? args.path : undefined;
    const newPath = typeof args.newPath === 'string' ? args.newPath : undefined;
    const sync = async (paths: string[], repoMap: () => Promise<void> | void): Promise<void> => {
      await Promise.all([requestIndex({ paths }).catch(() => undefined), repoMap()]);
    };
    switch (name) {
      case 'write_file':
      case 'edit_file':
      case 'multi_edit':
        if (!path) return;
        repoMapIndexer?.noteRecent(path);
        return sync([path], () => repoMapIndexer?.indexOne(path));
      case 'rename_file':
        if (!path || !newPath) return;
        repoMapIndexer?.noteRecent(newPath);
        return sync([path, newPath], () => repoMapIndexer?.renameFile(path, newPath));
      case 'delete_file':
        if (!path) return;
        return sync([path], () => repoMapIndexer?.removeFile(path));
      default:
        return;
    }
  }

  // Ctrl+C protocol: clear typed input first; on an empty prompt, arm a
  // two-second "press again to exit" window instead of exiting outright.
  const [composerHasText, setComposerHasText] = useState(false);
  const [clearToken, setClearToken] = useState(0);
  /**
   * Images staged by Ctrl+V, as data URLs, sent with the next message.
   *
   * A ref alongside the state because `runTask` reads them while assembling
   * the request and clears them straight after — reading through state there
   * would send whatever the last render saw, which on a fast second Ctrl+V is
   * not what is on screen.
   */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const pendingImagesRef = useRef<string[]>([]);
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout>>();

  const abortRef = useRef<AbortController>();
  const toolDescriptions = useRef(new Map<string, string>());
  /** highlight.js language per in-flight call, inferred from a `path` arg — read_file's numbered content is the case this exists for. */
  const toolLanguages = useRef(new Map<string, string | undefined>());

  /**
   * The connection to the core server, opened lazily on the first task and
   * kept for the session (docs/phase3-protocol-design.md §2: a session IS a
   * connection). Reopened when the active profile changes, since profiles
   * and key material are pushed at hello and the server never reads either
   * host's config for itself.
   */
  const connectionRef = useRef<ServerConnection>();
  const connectedProfile = useRef<string>();
  /** The run currently streaming, so one notification handler can serve every task. */
  const activeRun = useRef<{ runId: string; onEvent(event: AgentEvent): void }>();
  /** Read inside handlers registered once — a ref, not the state value, or they'd close over a stale one. */
  const subAgentsRef = useRef(false);
  /**
   * Tool definitions by name for the current run. `permission/request`
   * carries the call and its permission class, but PermissionEngine wants
   * the ToolDefinition — which the host already has, since it is the host
   * that offered the tools in the first place.
   */
  const toolByName = useRef(new Map<string, ToolDefinition>());

  useEffect(() => {
    // Only the auto-allow/deny lines matter to a user; they explain an action
    // that happened without a prompt. Rendered dim, like other system notes.
    onPermissionLogReady?.((message) => pushSystem(message.replace(/^\[perm\]\s*/, 'Permission: ')));
  }, [onPermissionLogReady]);

  useEffect(() => {
    permissions.attachRequester(
      (req) => new Promise<PermissionChoice>((resolve) => setPendingPermission({ req, resolve })),
    );
  }, [permissions]);

  useEffect(() => {
    subAgentsRef.current = subAgentsEnabled;
  }, [subAgentsEnabled]);

  // The socket outlives individual tasks but not the app.
  useEffect(
    () => () => {
      connectionRef.current?.close();
      connectionRef.current = undefined;
    },
    [],
  );

  /**
   * The window the model really has, asked of the endpoint through the daemon.
   *
   * The prop from cli.tsx is the preset's number, and a preset is a guess
   * about a family of endpoints. Too small only wastes context by compacting
   * early; too large is worse — the loop never compacts, the endpoint drops
   * the oldest part of the prompt instead, and the agent forgets what it just
   * read and reads it again.
   */
  const contextWindowFor = useRef(
    createContextWindowResolver(async (profileName, m) => {
      const { peer } = await ensureConnection();
      const { models } = await peer.request<ListModelsResult>(METHODS.listModels, {
        profileName,
        model: m,
      } satisfies ListModelsParams);
      return models;
    }),
  ).current;

  /**
   * Connect (starting the server if needed) and register the four
   * server→host request handlers. The bodies are the same code that used to
   * sit inline in the runAgent options object; only their trigger changed —
   * the split docs/phase3-protocol-design.md §7 describes, and the same
   * shape headless.ts already uses.
   */
  async function ensureConnection(): Promise<ServerConnection> {
    const existing = connectionRef.current;
    if (existing && connectedProfile.current === active.profile.name) return existing;
    existing?.close();

    const apiKey = await secretsStore?.getApiKey(active.profile.name);
    const connection = await connectToServer(
      {
        client: { name: 'heapcode-cli', version },
        root: cwd ?? process.cwd(),
        profiles: [active.profile],
        activeProfile: active.profile.name,
        keys: apiKey ? { [active.profile.name]: apiKey } : {},
      },
      server,
    );
    connectionRef.current = connection;
    connectedProfile.current = active.profile.name;
    const { peer } = connection;

    // The daemon outlives this process by design, and it also exits without
    // asking: it goes idle, it retires because its bundle was rebuilt, someone
    // kills it. Holding the dead peer meant every later request rejected with
    // "connection closed" until the CLI itself was restarted. Dropping the
    // reference is the whole recovery — the next call reconnects.
    peer.onClose(() => {
      if (connectionRef.current !== connection) return;
      connectionRef.current = undefined;
      connectedProfile.current = undefined;
    });

    // Ask how big the window really is now, not on first use. `known()`
    // answers with the preset's guess until the endpoint replies, and the
    // first read used to happen inside the first run — the run it matters
    // for, since a guess that is too small compacts it early and it re-does
    // work it had already done.
    void contextWindowFor.resolve(active.profile, model).catch(() => {
      /* Falls back to the preset exactly as before. */
    });

    // edit_file's fast-apply fallback, now that there is something to call it
    // with. Rebound on every reconnect so it follows a profile switch — the
    // apply model belongs to the profile, not to the session.
    executor.setApplyMerge(async (original, snippet) => {
      try {
        const res = await peer.request<{ merged?: string }>(METHODS.applyMerge, {
          original,
          snippet,
          profileName: active.profile.name,
        });
        return res.merged;
      } catch {
        // The edit failure this was rescuing is the real result.
        return undefined;
      }
    });

    peer.onRequest(METHODS.toolExecute, async (raw, signal) => {
      const { call } = raw as ToolExecuteParams;
      return executeTool(call, signal);
    });

    peer.onRequest(METHODS.permissionRequest, async (raw) => {
      const { call } = raw as PermissionRequestParams;
      // delegate_task while sub-agents are off resolves to an informative
      // error server-side — prompting the user to approve something that
      // cannot run would be noise.
      if (call.name === 'delegate_task' && !subAgentsRef.current) return { granted: true } satisfies PermissionRequestResult;
      const tool = toolByName.current.get(call.name);
      const granted = tool ? await permissions.request(call, tool, executor.describe(call)) : false;
      return { granted } satisfies PermissionRequestResult;
    });

    peer.onRequest(METHODS.snapshotBefore, async (raw) => {
      const { call } = raw as SnapshotBeforeParams;
      await shadowGit?.snapshot(`${call.name}: ${executor.describe(call).slice(0, 80)}`);
      return null;
    });

    peer.onRequest(METHODS.keyRequest, async (raw) => {
      const { profileName } = raw as KeyRequestParams;
      const target = await configStore?.getProfile(profileName);
      // Unknown profile or no stored key → the server falls back to the
      // parent's provider, which is what /subagents did before this moved.
      if (!target) return {} satisfies KeyRequestResult;
      return { profile: target, apiKey: await secretsStore?.getApiKey(profileName) } satisfies KeyRequestResult;
    });

    peer.onRequest(METHODS.reviewConfirm, async (raw) => {
      const { runId, confirmation } = raw as ReviewConfirmParams;
      const review = reviewRun.current;
      if (!review || review.runId !== runId) return { ok: false } satisfies ReviewConfirmResult;
      return { ok: await review.confirm(confirmation) } satisfies ReviewConfirmResult;
    });

    peer.onNotification(METHODS.reviewEvent, (raw) => {
      const { runId, event } = raw as ReviewEventParams;
      const review = reviewRun.current;
      if (review && review.runId === runId) review.onEvent(event);
    });

    // Indexing progress. The status surface stays host-side and becomes a
    // renderer (docs/phase3-rag-design.md §4) — this is the whole of it.
    peer.onNotification(METHODS.ragEvent, (raw) => {
      const { event } = raw as RagEventParams;
      if (event.kind === 'progress') setIndexProgress({ embedded: event.embedded, total: event.total });
      else if (event.state !== 'indexing') setIndexProgress(undefined);
    });

    peer.onNotification(METHODS.agentEvent, (raw) => {
      const { runId, event } = raw as AgentEventParams;
      const run = activeRun.current;
      if (run && run.runId === runId) run.onEvent(event);
    });

    return connection;
  }

  /**
   * The host half of a tool call. MCP dispatch stays here rather than moving
   * server-side: hosting MCP subprocesses in the server is deliberately out
   * of scope (docs/phase3-protocol-design.md §4 recommends it but flags it
   * as needing its own look), and this is the same resolution headless.ts
   * arrived at.
   */
  async function executeTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (call.name === 'ask_user') {
      const options = Array.isArray(call.args.options) ? call.args.options.map(String) : undefined;
      // The wait is unbounded by default and stays that way unless the user
      // opted into askUserQuestionTimeout — and never bounded at all for a
      // question the model marked as gating an action, however it is
      // configured. Three things can end it: an answer, cancellation (which
      // behaves exactly as it did before this), or the idle bound expiring.
      const bounded = askUserIdleMs !== undefined && !askUserBlocksAction(call.args);
      questionPartial.current = '';
      let idle = false;
      const answer = await new Promise<string | undefined>((resolve) => {
        const settle = (value: string | undefined): void => {
          questionDeadline.current?.stop();
          questionDeadline.current = undefined;
          setQuestionCountdown(undefined);
          resolve(value);
        };
        const deadline = new IdleDeadline(bounded ? askUserIdleMs : undefined, () => {
          idle = true;
          settle(undefined);
        });
        questionDeadline.current = deadline;
        deadline.start();
        setPendingQuestion({ req: { question: String(call.args.question ?? ''), options }, resolve: settle });
        // If the run is cancelled while the question is up, stop waiting and
        // take the prompt down rather than leaving it on screen forever.
        // Cancellation wins over the idle bound: `idle` stays false, so this
        // resolves the way it always has.
        signal.addEventListener('abort', () => settle(undefined), { once: true });
      });
      setPendingQuestion(undefined);
      if (answer?.trim()) return { id: call.id, name: call.name, content: askUserAnswerMessage(answer) };
      return {
        id: call.id,
        name: call.name,
        content: idle ? askUserIdleMessage(questionPartial.current) : ASK_USER_NO_ANSWER,
      };
    }
    if (mcpManager?.isMcpTool(call.name)) {
      try {
        return { id: call.id, name: call.name, content: await mcpManager.call(call.name, call.args) };
      } catch (err) {
        return { id: call.id, name: call.name, content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }
    const result = await executor.execute(call, signal);
    if (!result.isError) await syncIndexesAfterTool(call.name, call.args);
    return result;
  }

  useEffect(() => () => clearTimeout(exitTimer.current), []);

  function doExit(): void {
    exit();
  }

  useInput((input, key) => {
    // Any keypress means the user is still here — push a pending question's
    // idle deadline back rather than cutting them off mid-thought. Runs before
    // the Esc/Ctrl+C handling below because it applies to those too.
    questionDeadline.current?.touch();
    // Shift+Tab cycles the permission mode, the way it does in the editors
    // people arrive from. Plain Tab is the composer's slash-command
    // completion, so only the shifted form is taken. Allowed mid-run: the
    // engine reads the mode per request, so escalating out of a wall of
    // prompts without stopping the agent is the main reason to have a
    // keystroke for this at all. Suppressed while a modal (permission
    // prompt, picker, setup) owns the screen — changing the policy
    // underneath a question about that policy is nobody's intent.
    if (key.tab && key.shift) {
      if (!pendingPermission && !pendingQuestion && !picker && !pendingSecret && !setupActive) {
        const next = cyclePermissionMode(permissionModeRef.current);
        setPermissionMode(next);
        onTrack?.('permission.mode.changed', { mode: next, via: 'shift-tab' });
      }
      return;
    }
    if (key.escape) {
      if (pendingSecret) {
        setPendingSecret(undefined);
        pushSystem('Cancelled — no key stored, web search stays off.');
      } else if (setupActive) {
        setSetupActive(false);
        pushSystem('Profile setup cancelled.');
      } else if (picker) cancelPicker(picker, () => setPicker(undefined));
      else if (busy && abortRef.current) abortRef.current.abort();
      return;
    }
    if (key.ctrl && input === 'c') {
      if (busy && abortRef.current) {
        abortRef.current.abort();
        return;
      }
      if (setupActive) {
        setSetupActive(false);
        pushSystem('Profile setup cancelled.');
        return;
      }
      if (picker) {
        cancelPicker(picker, () => setPicker(undefined));
        return;
      }
      if (composerHasText) {
        setClearToken((t) => t + 1);
        setComposerHasText(false);
        return;
      }
      if (exitArmed) {
        doExit();
        return;
      }
      setExitArmed(true);
      clearTimeout(exitTimer.current);
      exitTimer.current = setTimeout(() => setExitArmed(false), 2_000);
    }
  });

  async function persist(): Promise<void> {
    const messages: StoredMessage[] = itemsRef.current
      .filter((i): i is Extract<TranscriptItem, { kind: 'message' }> => i.kind === 'message')
      .map((i) => i.message);
    conversationRef.current.messages = messages;
    conversationRef.current.updatedAt = Date.now();
    // Title from the first user message so /resume shows something meaningful.
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser && (!conversationRef.current.title || conversationRef.current.title === 'New conversation')) {
      conversationRef.current.title = firstUser.content.length > 60 ? `${firstUser.content.slice(0, 60)}…` : firstUser.content;
    }
    await historyStore.save(conversationRef.current);
  }

  /** /rewind [n] — undo the effects of the last n tool calls (default 1) via their shadow-git checkpoints. */
  /** Real, user-facing checkpoints — restore/pre-restore markers `/rewind` itself creates are noise, not steps to rewind to. */
  async function listCheckpoints(): Promise<Array<{ hash: string; label: string; date: number }>> {
    if (!shadowGit) return [];
    const entries = await shadowGit.history();
    return entries.filter((e) => !/^(pre-restore state|restored to )/.test(e.label));
  }

  /**
   * Reads straight from the shadow-git commit log (via listCheckpoints), not
   * any in-memory transcript state — so /rewind and /checkpoints keep
   * working across /new, /resume, or a fresh process, unlike CLI-M1's
   * original version (see ShadowGit.log()'s own comment for the real-usage
   * bug this fixes).
   */
  async function handleRewind(arg: string): Promise<void> {
    if (!shadowGit) {
      pushSystem('Rewind is unavailable — shadow git could not be initialized.');
      return;
    }
    const n = Math.max(1, Number.parseInt(arg, 10) || 1);
    const checkpoints = await listCheckpoints();
    const target = checkpoints[n - 1];
    if (!target) {
      pushSystem(`No checkpoint ${n} step(s) back.`);
      return;
    }
    const restored = await shadowGit.restore(target.hash);
    if (restored === undefined) {
      pushSystem('Rewind failed.');
      return;
    }
    onTrack?.('checkpoint.restoreStep', { count: restored.length });
    pushSystem(
      restored.length === 0
        ? `Nothing changed since "${target.label}".`
        : `Rewound to before "${target.label}": ${restored.join(', ')}`,
    );
  }

  /** Reset the transcript view to `initial` under a fresh screen — shared by /new, /clear, and /resume. */
  function resetTranscript(initial: TranscriptItem[]): void {
    itemsRef.current = initial;
    setItems(itemsRef.current);
    setStaticKey((k) => k + 1);
    setError(undefined);
    // Clear the screen and scrollback so the fresh header starts at the top,
    // like Claude Code's /clear. Skipped off-TTY (tests, pipes).
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  }

  function startNewConversation(): void {
    conversationRef.current = { id: randomUUID(), title: 'New conversation', updatedAt: Date.now(), messages: [] };
    onSessionChange?.(conversationRef.current.id);
    resetTranscript([headerItem(0)]);
  }

  async function handleResume(): Promise<void> {
    const metas = await historyStore.list();
    if (metas.length === 0) {
      pushSystem('No saved conversations in this project yet.');
      return;
    }
    setPicker({
      title: 'Resume a conversation',
      items: metas.map((m) => ({
        label: `${m.title} · ${new Date(m.updatedAt).toLocaleString()} · ${m.id.slice(0, 8)}${m.id === conversationRef.current.id ? ' — current' : ''}`,
        value: m.id,
      })),
      onPick: (id) => {
        setPicker(undefined);
        void (async () => {
          const conv = await historyStore.get(id);
          if (!conv) {
            pushSystem('That conversation could not be loaded.');
            return;
          }
          conversationRef.current = conv;
          onSessionChange?.(conv.id);
          const loaded = conv.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
          resetTranscript([headerItem(loaded.length), ...loaded.map((m) => ({ kind: 'message' as const, message: m }))]);
        })();
      },
    });
  }

  async function applyModel(id: string): Promise<void> {
    setModel(id);
    // Keep agentModel in sync when the profile pins one — otherwise the
    // switch would silently not apply (runAgent prefers agentModel).
    const updated: ProviderProfileConfig = {
      ...active.profile,
      model: id,
      ...(active.profile.agentModel ? { agentModel: id } : {}),
    };
    setActive((a) => ({ ...a, profile: updated }));
    if (configStore) {
      await configStore.saveProfile(updated);
      pushSystem(`Model set to ${id} (saved to profile "${updated.name}").`);
    } else {
      pushSystem(`Model set to ${id} for this session.`);
    }
  }

  async function handleModel(arg?: string): Promise<void> {
    if (arg) return applyModel(arg);
    try {
      // Server-side: it already holds this profile's key and Provider, so the
      // CLI has no reason to build a second one just to read a model list.
      const { peer } = await ensureConnection();
      const { models } = await peer.request<ListModelsResult>(METHODS.listModels, {
        profileName: active.profile.name,
      } satisfies ListModelsParams);
      if (models.length === 0) {
        pushSystem('This endpoint does not list models. Set one directly with "/model <id>".');
        return;
      }
      setPicker({
        title: `Select a model (current: ${model})`,
        items: models.map((m) => ({ label: m.id === model ? `${m.id} (current)` : m.id, value: m.id })),
        // Provider lists run to the hundreds — arrow-keying to a known id is
        // the slowest possible way to pick one.
        filterable: true,
        onPick: (id) => {
          setPicker(undefined);
          void applyModel(id);
        },
      });
    } catch (err) {
      pushSystem(`Could not fetch models: ${err instanceof Error ? err.message : String(err)}. Set one directly with "/model <id>".`);
    }
  }

  async function handleProfile(sub?: string, arg?: string): Promise<void> {
    if (!configStore || !switchProvider) {
      pushSystem('Profile management is unavailable in this session.');
      return;
    }
    if (sub === 'add') {
      setSetupActive(true);
      return;
    }
    const profiles = await configStore.listProfiles();
    if (sub === 'list') {
      pushSystem(
        profiles.length === 0
          ? 'No profiles configured yet — "/profile add" creates one.'
          : profiles
              .map((p) => `${p.name === active.profile.name ? '*' : ' '} ${p.name}  (${p.preset}, ${p.model})`)
              .join('\n'),
      );
      return;
    }
    if (sub === 'remove') {
      if (!arg) {
        pushSystem('Usage: /profile remove <name>');
        return;
      }
      if (!profiles.some((p) => p.name === arg)) {
        pushSystem(`No profile named "${arg}".`);
        return;
      }
      if (arg === active.profile.name) {
        pushSystem('That profile is currently in use — switch to another with /profile first.');
        return;
      }
      await configStore.deleteProfile(arg);
      await secretsStore?.deleteApiKey(arg);
      pushSystem(`Removed profile "${arg}".`);
      return;
    }
    if (profiles.length === 0) {
      // Nothing to switch to — go straight into adding one.
      setSetupActive(true);
      return;
    }
    const apply = async (name: string): Promise<void> => {
      const target = profiles.find((p) => p.name === name);
      if (!target) {
        pushSystem(`No profile named "${name}". Configured: ${profiles.map((p) => p.name).join(', ')}.`);
        return;
      }
      try {
        const next = await switchProvider(target);
        await configStore.setActiveProfile(target.name);
        setActive({ profile: target, contextWindow: next.contextWindow });
        setModel(target.agentModel || target.model);
        pushSystem(`Switched to profile "${target.name}" (${target.preset}, ${target.agentModel || target.model}).`);
      } catch (err) {
        pushSystem(`Could not switch profile: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (sub) return apply(sub);
    setPicker({
      title: 'Select a profile',
      items: [
        ...profiles.map((p) => ({
          label: `${p.name} (${p.preset}, ${p.model})${p.name === active.profile.name ? ' — current' : ''}`,
          value: p.name,
        })),
        { label: '+ Add a new profile…', value: '__add__' },
      ],
      onPick: (name) => {
        setPicker(undefined);
        if (name === '__add__') setSetupActive(true);
        else void apply(name);
      },
    });
  }

  /**
   * The typed equivalent of Shift+Tab. Worth having even with the keystroke:
   * it is discoverable from /help, scriptable in tests, and the only way to
   * jump straight to a mode instead of cycling to it.
   */
  function handleMode(arg?: string): void {
    const describe = (mode: PermissionMode): string => {
      const info = getPermissionModeInfo(mode);
      return `Permission mode: ${info.label} — ${info.hint}`;
    };
    if (arg) {
      if (!isPermissionMode(arg)) {
        pushSystem(`No permission mode "${arg}". Available: ${PERMISSION_MODES.join(', ')}.`);
        return;
      }
      setPermissionMode(arg);
      onTrack?.('permission.mode.changed', { mode: arg, via: 'command' });
      pushSystem(describe(arg));
      return;
    }
    setPicker({
      title: `Select a permission mode (current: ${getPermissionModeInfo(permissionMode).label})`,
      items: PERMISSION_MODE_INFO.map((info) => ({
        label: `${info.label} — ${info.hint}${info.id === permissionMode ? ' (current)' : ''}`,
        value: info.id,
      })),
      onPick: (id) => {
        setPicker(undefined);
        if (!isPermissionMode(id)) return;
        setPermissionMode(id);
        onTrack?.('permission.mode.changed', { mode: id, via: 'command' });
        pushSystem(describe(id));
      },
    });
  }

  /**
   * Set up, toggle, or inspect web search. Search is off until a provider is
   * chosen here (or in config.json); the key goes to secrets.json, never the
   * config file, so this walks the user through both.
   */
  async function handleWebSearch(arg?: string): Promise<void> {
    if (!configStore) {
      pushSystem('Web search configuration is unavailable in this session.');
      return;
    }
    const current = (await configStore.load()).webSearch ?? {};
    const key = await secretsStore?.getApiKey(WEB_SEARCH_SECRET_NAME);
    const status = (): string =>
      `Web search: ${describeWebSearchState(current, key)}\nConfigure with "/websearch <${SEARCH_PRESETS.join('|')}>", or "/websearch off".`;

    if (!arg) {
      pushSystem(status());
      return;
    }
    if (arg === 'off') {
      await configStore.saveWebSearch({ enabled: false });
      pushSystem('Web search turned off. "/websearch on" re-enables it with the same provider.');
      return;
    }
    if (arg === 'on') {
      if (!current.provider) {
        pushSystem(`No search provider configured yet. Pick one: /websearch <${SEARCH_PRESETS.join('|')}>`);
        return;
      }
      await configStore.saveWebSearch({ enabled: true });
      const refreshed = { ...current, enabled: true };
      pushSystem(`Web search: ${describeWebSearchState(refreshed, key)}`);
      return;
    }
    if (!isSearchPresetId(arg)) {
      pushSystem(`Unknown search provider "${arg}". Available: ${SEARCH_PRESETS.join(', ')}.`);
      return;
    }
    const preset = getSearchPreset(arg);
    await configStore.saveWebSearch({ provider: arg, enabled: true });
    if (preset.requiresApiKey && !key) {
      // The key is the only part that can't be set from a flag — ask for it
      // inline rather than telling the user to go edit a file.
      setPendingSecret({
        label: `${preset.label} API key`,
        onSubmit: async (value) => {
          setPendingSecret(undefined);
          if (!value.trim()) {
            pushSystem(`No key entered — web search stays off. Run "/websearch ${arg}" again to retry.`);
            return;
          }
          await secretsStore?.setApiKey(WEB_SEARCH_SECRET_NAME, value.trim());
          pushSystem(`Web search: on (${preset.label}). Endpoint: ${preset.defaultBaseUrl}`);
        },
      });
      return;
    }
    pushSystem(
      `Web search: on (${preset.label}). Endpoint: ${current.baseUrl || preset.defaultBaseUrl}` +
        (preset.selfHosted ? '\nSet "webSearch.baseUrl" in ~/.heapcode/config.json to point at your own instance.' : ''),
    );
  }

  /**
   * List or clear persisted "Always allow" grants. The engine's auto-allow
   * message has always pointed at "/permissions reset" — the command simply
   * did not exist, so the one instruction a surprised user was given led
   * nowhere.
   */
  async function handlePermissions(arg?: string): Promise<void> {
    if (arg === 'reset') {
      const cleared = await permissions.reset();
      pushSystem(
        cleared === 0
          ? 'No saved permission grants to clear.'
          : `Cleared ${cleared} saved permission grant${cleared === 1 ? '' : 's'}. Every action will ask again.`,
      );
      return;
    }
    if (arg) {
      pushSystem('Usage: /permissions [reset]');
      return;
    }
    const grants = await listPermissionGrants(permissionsFile(cwd ?? process.cwd()));
    pushSystem(
      [
        grants.length === 0
          ? 'No saved "Always allow" grants for this project.'
          : `Saved "Always allow" grants for this project:\n${grants.map((g) => `  ${g}`).join('\n')}`,
        '',
        `These apply in auto-edit and Auto modes only — in ${getPermissionModeInfo('default').label} mode every action asks, whatever is saved here.`,
        '"/permissions reset" clears them.',
      ].join('\n'),
    );
  }

  /**
   * Switch this profile between native tool calling and the text protocol.
   * A config field with no UI is a field nobody finds: models whose chat
   * template lacks tool support reject every request carrying `tools`, and
   * the only documented cure was hand-editing config.json.
   */
  async function handleNativeTools(arg?: string): Promise<void> {
    const current = effectiveNativeToolCalls;
    if (arg !== 'on' && arg !== 'off') {
      pushSystem(
        [
          `Native tool calling: ${current ? 'on' : 'off'} (profile "${active.profile.name}")`,
          current
            ? 'Turn it off ("/nativetools off") if the model rejects requests that carry tools — common for local GGUF builds whose chat template has no tool support.'
            : 'heapcode is describing tools in the prompt instead of using the tool-calling API.',
          'Usage: /nativetools on|off',
        ].join('\n'),
      );
      return;
    }
    const next = arg === 'on';
    const updated: ProviderProfileConfig = {
      ...active.profile,
      capabilities: { ...active.profile.capabilities, nativeToolCalls: next },
    };
    setActive((a) => ({ ...a, profile: updated }));
    if (configStore) {
      await configStore.saveProfile(updated);
      pushSystem(
        `Native tool calling ${next ? 'on' : 'off'} for profile "${updated.name}" (saved). ` +
          'Takes effect on the next task.',
      );
    } else {
      pushSystem(`Native tool calling ${next ? 'on' : 'off'} for this session.`);
    }
  }

  function handlePersona(arg?: string): void {
    const describe = (p: AgentPersona): string => `Persona: ${p.label} — ${p.description}`;
    if (arg) {
      const target = BUILTIN_PERSONAS.find((p) => p.id === arg.toLowerCase());
      if (!target) {
        pushSystem(`No persona "${arg}". Available: ${BUILTIN_PERSONAS.map((p) => p.id).join(', ')}.`);
        return;
      }
      setPersona(target);
      pushSystem(describe(target));
      return;
    }
    setPicker({
      title: `Select a persona (current: ${persona.label})`,
      items: BUILTIN_PERSONAS.map((p) => ({
        label: `${p.label} — ${p.description}${p.id === persona.id ? ' (current)' : ''}`,
        value: p.id,
      })),
      onPick: (id) => {
        setPicker(undefined);
        const target = getPersona(id);
        setPersona(target);
        pushSystem(describe(target));
      },
    });
  }

  /** /search — semantic when the index is ready, otherwise a plain regex text search via the existing `search` tool. */
  async function handleSearch(query: string): Promise<void> {
    if (!query) {
      pushSystem('Usage: /search <query>');
      return;
    }
    // Ask the server first; an empty result means no index (or no embeddings
    // model), which is the same condition the old `ready` gate stood for.
    const { hits } = await requestQuery(query);
    if (hits.length > 0) {
      pushSystem(hits.map((h) => `${h.path}:${h.startLine}-${h.endLine}  (score ${h.score.toFixed(2)})`).join('\n'));
      return;
    }
    const words = query.split(/\W+/).filter((w) => w.length > 2).map(escapeRegExp);
    const pattern = words.length > 0 ? words.join('|') : escapeRegExp(query);
    const result = await executor.execute({ id: 'search-cmd', name: 'search', args: { pattern } });
    pushSystem(`(no semantic index — plain text search for /${pattern}/)\n${result.content}`);
  }

  /**
   * /pr-review — the same review the VS Code extension runs, now in the same
   * *process* as well: core's reviewCurrentPr runs server-side behind
   * `review/run`. This is only the transcript adapter — progress and warnings
   * as system lines, the preview rendered as markdown, and the post/cancel
   * decision as a picker. Nothing is posted to GitHub without that explicit
   * pick, and the review's read-only tool calls come back over the same
   * `tool/execute` channel an agent run uses.
   */
  async function handlePrReview(arg?: string): Promise<void> {
    const mode = arg?.toLowerCase();
    if (mode && mode !== 'deep' && mode !== 'fast') {
      pushSystem('Usage: /pr-review [deep] — reviews the current branch\'s PR (requires the "gh" CLI, authenticated).');
      return;
    }
    if (busy) {
      pushSystem('Busy — wait for the current task to finish, or press esc to interrupt it.');
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setError(undefined);
    try {
      const onEvent = (event: ReviewEvent): void => {
        // The extension writes `log` to an output channel; here it would bury
        // the transcript under per-tool-call noise, so it's dropped — tool
        // activity is already visible in the progress lines.
        if (event.kind === 'warn' || event.kind === 'progress') pushSystem(`PR review: ${event.message}`);
        else if (event.kind === 'error') setError(event.message);
      };

      const confirm = ({
        pr,
        preview,
        findingCount,
        inlineCount,
        plainText,
      }: ReviewConfirmParams['confirmation']): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          pushItem({ kind: 'markdown', text: preview });
          let settled = false;
          const finish = (value: boolean): void => {
            if (settled) return;
            settled = true;
            abort.signal.removeEventListener('abort', onAbort);
            resolve(value);
          };
          // Esc/ctrl+c during the confirm aborts the run — the picker's own
          // cancel path and the abort signal both have to settle this promise,
          // or the command hangs with the composer locked.
          function onAbort(): void {
            setPicker(undefined);
            finish(false);
          }
          abort.signal.addEventListener('abort', onAbort, { once: true });
          setPicker({
            title: plainText
              ? `Post this review as a comment on PR #${pr.number}? (posts publicly on GitHub)`
              : `Post this review on PR #${pr.number}? ${findingCount} finding(s), ${inlineCount} as inline comments — posts publicly on GitHub`,
            items: [
              { label: plainText ? 'Post comment' : 'Post review', value: 'post' },
              { label: "Don't post", value: 'cancel' },
            ],
            onPick: (value) => {
              setPicker(undefined);
              finish(value === 'post');
            },
            onCancel: () => finish(false),
          });
        });

      const connection = await ensureConnection();
      const runId = `review-${randomUUID()}`;
      abort.signal.addEventListener('abort', () => connection.peer.notify(METHODS.agentCancel, { runId }), { once: true });
      reviewRun.current = { runId, onEvent, confirm };
      let result: ReviewRunResult;
      try {
        result = await connection.peer.request<ReviewRunResult>(METHODS.reviewRun, {
          model,
          temperature: active.profile.temperature,
          maxTokens: active.profile.maxTokens,
          contextWindow: contextWindowFor.known(active.profile, model).window,
          tools,
          client: CLI_REVIEW_CLIENT,
          deep: mode === 'deep',
          runId,
        } satisfies ReviewRunParams);
      } finally {
        if (reviewRun.current?.runId === runId) reviewRun.current = undefined;
      }
      onTrack?.(mode === 'deep' ? 'command.reviewPrDeep' : 'command.reviewPr', { status: result.status });
      if (result.status === 'posted') pushSystem(`PR review: posted on PR #${result.pr.number} — ${result.pr.url}`);
      else if (result.status === 'cancelled') pushSystem('PR review: nothing was posted.');
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      abortRef.current = undefined;
    }
  }

  async function showSettings(): Promise<void> {
    const p = active.profile;
    const ragStatus = await requestStatus();
    const webSearchStatus = configStore
      ? describeWebSearchState(
          (await configStore.load()).webSearch,
          await secretsStore?.getApiKey(WEB_SEARCH_SECRET_NAME),
        )
      : 'unavailable in this session';
    pushSystem(
      [
        `Session     ${conversationRef.current.id.slice(0, 8)}  (heapcode --resume ${conversationRef.current.id.slice(0, 8)} to continue this later)`,
        `Profile     ${p.name} (${p.preset})`,
        `Endpoint    ${p.baseUrl}`,
        `Model       ${model}${p.agentModel && p.agentModel !== p.model ? ` (agent: ${p.agentModel})` : ''}`,
        `Persona     ${persona.label}`,
        `Sub-agents  ${subAgentsEnabled ? 'on' : 'off'} (/subagents to toggle)`,
        `Safe mode   ${safeMode ? 'on (--safe-mode)' : 'off'}`,
        `Mode        ${getPermissionModeInfo(permissionMode).label} — ${getPermissionModeInfo(permissionMode).hint}`,
        `Web search  ${webSearchStatus}`,
        `Tool proto  ${effectiveNativeToolCalls ? 'native tool calling' : 'text protocol (nativeToolCalls: false)'}`,
        `Search      ${ragStatus?.available ? `${ragStatus.state} — ${ragStatus.files} files, ${ragStatus.chunks} chunks` : 'unavailable'}${ragStatus?.state === 'no-embedder' ? ' (set embeddingsModel on the profile, e.g. nomic-embed-text)' : ''}`,
        `Repo map    ${repoMapIndexer?.ready ? 'ready' : 'empty'}`,
        `Config      ${configFile()}`,
        `Secrets     ${secretsFile()}`,
        '',
        'Change with /model and /profile · add providers with "/profile add" · /index rebuilds search',
      ].join('\n'),
    );
  }

  async function handleCommand(input: string): Promise<boolean> {
    const [cmd, ...rest] = input.trim().split(/\s+/);
    switch (cmd) {
      case '/help':
        pushSystem(`Commands:\n${HELP_TEXT}`);
        return true;
      case '/model':
        await handleModel(rest[0]);
        return true;
      case '/profile':
      case '/provider':
        await handleProfile(rest[0], rest[1]);
        return true;
      case '/mode':
        handleMode(rest[0]);
        return true;
      case '/websearch':
        await handleWebSearch(rest[0]?.toLowerCase());
        return true;
      case '/permissions':
        await handlePermissions(rest[0]?.toLowerCase());
        return true;
      case '/nativetools':
        await handleNativeTools(rest[0]?.toLowerCase());
        return true;
      case '/persona':
        handlePersona(rest[0]);
        return true;
      // Shares core's INIT_TASK with the extension so a project initialized
      // from the terminal and one initialized from the IDE get the same files.
      // Runs as an ordinary agent turn: `/init` is what the transcript shows,
      // the full task is what the agent receives.
      case '/init':
        await runTask('/init', INIT_TASK);
        return true;
      case '/memory': {
        const instructions = await loadProjectInstructions(cwd ?? process.cwd());
        pushSystem(
          instructions
            ? `Project context loaded into every agent run:\n\n${instructions}`
            : 'No project memory yet. Create .heapcode/HEAPCODE.md (project instructions) or .heapcode/memory.md (notes) — AGENTS.md is honored as a fallback.',
        );
        return true;
      }
      case '/skills':
        pushSystem(await listSkillsFormatted(cwd ?? process.cwd()));
        return true;
      case '/search':
        await handleSearch(rest.join(' ').trim());
        return true;
      case '/pr-review':
        await handlePrReview(rest[0]);
        return true;
      case '/subagents': {
        const arg = rest[0]?.toLowerCase();
        const next = arg === 'on' ? true : arg === 'off' ? false : !subAgentsEnabled;
        setSubAgentsEnabled(next);
        pushSystem(
          next
            ? 'Sub-agents (delegate_task): on — the agent can now hand off self-contained sub-tasks to a fresh sub-agent.'
            : 'Sub-agents (delegate_task): off.',
        );
        return true;
      }
      case '/mcp': {
        if (!mcpManager) {
          pushSystem('MCP is unavailable in this session.');
          return true;
        }
        const action = rest[0]?.toLowerCase();

        // Adding one used to mean closing the terminal and editing JSON, which
        // is a strange thing for a tool with a settings command to ask. The
        // extension had an add flow and wrote it to VS Code's own settings, so
        // what it added was invisible here; this writes to the config both
        // this CLI and the browser already read.
        if (action === 'add') {
          const name = rest[1];
          const spec = rest.slice(2).join(' ');
          if (!name || !spec) {
            pushSystem('Usage: /mcp add <name> <command…|url>\ne.g. /mcp add filesystem npx -y @modelcontextprotocol/server-filesystem ~/code');
            return true;
          }
          const nameProblem = mcpNameProblem(name);
          if (nameProblem) {
            pushSystem(nameProblem);
            return true;
          }
          const parsed = parseMcpServerSpec(spec);
          if ('error' in parsed) {
            pushSystem(parsed.error);
            return true;
          }
          await configStore?.saveMcpServer(name, parsed);
          await mcpManager.ensureConnected();
          const live = mcpManager.connectedServerNames().includes(name);
          pushSystem(
            live
              ? `Added "${name}" — ${mcpManager.getToolDefinitions().filter((t) => t.name.startsWith(`mcp__${name}__`)).length} tool(s) available now.`
              : `Saved "${name}", but it did not connect. Check the command or URL, then run /mcp to retry.`,
          );
          return true;
        }

        if (action === 'remove') {
          const name = rest[1];
          if (!name) {
            pushSystem('Usage: /mcp remove <name>');
            return true;
          }
          await configStore?.deleteMcpServer(name);
          await mcpManager.ensureConnected();
          pushSystem(`Removed "${name}".`);
          return true;
        }

        await mcpManager.ensureConnected();
        const { global, project } = configStore
          ? await loadMcpServerSources(cwd ?? process.cwd(), configStore)
          : { global: {}, project: {} };
        const connected = new Set(mcpManager.connectedServerNames());
        const all = { ...global, ...project };
        // Config and reality, unioned. Listing only what config names would
        // hide a server that is connected without one — and this session may
        // have no config store at all.
        const names = [...new Set([...Object.keys(all), ...connected])];
        if (names.length === 0) {
          pushSystem('No MCP servers connected. Add one with "/mcp add <name> <command…|url>".');
          return true;
        }
        pushSystem(
          [
            ...names.map((name) => {
              // Named, not counted: a server that is configured and not
              // connected is the thing worth seeing, and a "3 connected" line
              // hides exactly that.
              const where = name in project ? ' [project]' : '';
              const state = connected.has(name) ? 'connected' : 'not connected';
              const spec = all[name] ? `\n  ${describeMcpServer(all[name]!)}` : '';
              return `${name}${where} — ${state}${spec}`;
            }),
            `${mcpManager.getToolDefinitions().length} tool(s) total. "/mcp add <name> <command…|url>" to add, "/mcp remove <name>" to remove.`,
          ].join('\n'),
        );
        return true;
      }
      case '/index': {
        pushSystem('Rebuilding indexes…');
        await Promise.all([requestIndex({ full: true }), repoMapIndexer?.buildIndex()]);
        const status = await requestStatus();
        const rmReady = repoMapIndexer?.ready;
        pushSystem(
          [
            status?.available
              ? `Semantic search: ${status.state} — ${status.files} files, ${status.chunks} chunks.`
              : 'Semantic search: unavailable.',
            `Repo map: ${rmReady ? 'ready' : 'empty'}.`,
          ].join('\n'),
        );
        return true;
      }
      case '/settings':
      case '/config':
        await showSettings();
        return true;
      case '/new':
      case '/clear':
        startNewConversation();
        return true;
      case '/resume':
        await handleResume();
        return true;
      case '/exit':
      case '/quit':
        doExit();
        return true;
      case '/rewind':
        await handleRewind(rest[0] ?? '1');
        return true;
      case '/revert': {
        const reverted = await checkpoint.revertAll();
        if (reverted.length > 0) onTrack?.('checkpoint.revertAll', { count: reverted.length });
        pushSystem(reverted.length > 0 ? `Reverted: ${reverted.join(', ')}` : 'Nothing to revert.');
        return true;
      }
      case '/checkpoints': {
        const checkpoints = await listCheckpoints();
        pushSystem(
          checkpoints.length === 0
            ? 'No checkpoints yet.'
            : checkpoints.map((c, i) => `${i + 1}. ${c.label} (${new Date(c.date).toLocaleTimeString()})`).join('\n'),
        );
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Ctrl+V: attach the clipboard's image, if it holds one.
   *
   * Silent when the clipboard holds text or nothing. That is the ordinary
   * outcome for a key people press out of habit expecting a text paste, and a
   * banner every time would train them to ignore banners. Only a real problem
   * — too big, unreadable, no helper installed — says anything.
   */
  async function handleAttachImage(): Promise<void> {
    if (pendingImagesRef.current.length >= MAX_ATTACHED_IMAGES) {
      pushSystem(`At most ${MAX_ATTACHED_IMAGES} images per message.`);
      return;
    }
    const result = await readClipboardImage();
    if (result === undefined) return;
    if (isFailure(result)) {
      pushSystem(result.reason);
      return;
    }
    const next = [...pendingImagesRef.current, result.dataUrl];
    pendingImagesRef.current = next;
    setPendingImages(next);
    pushSystem(`Attached an image from the clipboard (${Math.max(1, Math.round(result.bytes / 1024))} KB).`);
  }

  /** Ctrl+X: unattach the most recent image. Silent when there is nothing staged. */
  function handleRemoveImage(): void {
    const staged = pendingImagesRef.current;
    if (staged.length === 0) return;
    const next = staged.slice(0, -1);
    pendingImagesRef.current = next;
    setPendingImages(next);
    pushSystem(next.length === 0 ? 'Removed the attached image.' : `Removed an image — ${next.length} still attached.`);
  }

  async function handleSubmit(text: string): Promise<void> {
    if (text.startsWith('/')) {
      if (await handleCommand(text)) return;
      // Prompt templates (/explain, /fix, /review, …) render into a task and
      // run through the normal agent loop.
      const prompt = parseSlashCommand(text);
      if (prompt) {
        if (!prompt.input) {
          pushSystem(`Usage: /${prompt.prompt.command} <code, file path, or question>`);
          return;
        }
        await runTask(text, renderTemplate(prompt.prompt.template, { input: prompt.input }), prompt.prompt.readOnly ? getPersona('reviewer') : undefined);
        return;
      }
      const [cmd] = text.trim().split(/\s+/);
      if (/^\/[a-z-]+$/.test(cmd ?? '')) {
        pushSystem(`Unknown command ${cmd}. Type /help for the list.`);
        return;
      }
    }
    await runTask(text, text);
  }

  /**
   * Run one agent turn: `display` is what the transcript shows; `task` is
   * what the agent gets. `personaOverride` scopes just this turn to a
   * stricter persona (e.g. a readOnly builtin prompt like /review) without
   * touching the session's actual active persona — intersected with it, so
   * it can only ever be as-or-more restrictive, never less.
   */
  async function runTask(display: string, task: string, personaOverride?: AgentPersona): Promise<void> {
    // Plan mode narrows on top of whatever the persona already allows, so the
    // model is never offered a tool it would only be denied at call time.
    const effectivePersona = applyModeToPersona(
      personaOverride ? intersectPersonas(persona, personaOverride) : persona,
      permissionModeRef.current,
    );
    setError(undefined);
    setBusy(true);
    const images = pendingImagesRef.current;
    pendingImagesRef.current = [];
    setPendingImages([]);
    // Snapshot prior turns BEFORE pushing the new task message.
    const history = trimHistoryForAgent(
      itemsRef.current
        .filter((i): i is Extract<TranscriptItem, { kind: 'message' }> => i.kind === 'message')
        .map((i) => i.message),
    );
    pushItem({ kind: 'message', message: { role: 'user', content: display } });
    setLiveText('');
    let acc = '';
    const abort = new AbortController();
    abortRef.current = abort;

    // Task preamble, same shape as the extension's controller: persona
    // constraints + project instructions/memory, then the task itself.
    const instructions = await loadProjectInstructions(cwd ?? process.cwd()).catch(() => '');
    let workspaceContext = '';
    if (/(^|\s)@workspace\b/.test(display)) {
      const query = display.replace(/(^|\s)@workspace\b/g, ' ').trim() || display;
      const { formatted } = await requestQuery(query);
      if (formatted) workspaceContext = `Relevant workspace context (semantic search):\n${formatted}`;
      else if (repoMapIndexer?.ready) workspaceContext = `Workspace structure overview (no semantic index configured):\n${repoMapIndexer.format()}`;
    }
    const mentionNote = /(^|\s)@[^\s@]+/.test(display)
      ? 'Paths prefixed with @ in the task are file/folder references in this workspace — read them for context.'
      : '';
    const fullTask = buildAgentTask({
      personaAddendum: effectivePersona.taskAddendum,
      instructions,
      workspaceContext,
      mentionNote,
      task,
    });

    // Reconnect (idempotent) at the start of every task rather than once at
    // launch — config edits and dropped servers take effect on the next
    // message with no restart, same pattern as the extension's controller.
    await mcpManager?.ensureConnected();
    const mcpTools = mcpManager?.getToolDefinitions() ?? [];
    // delegate_task is always OFFERED so the model can respond honestly when
    // the user asks it to delegate; while /subagents is off, calling it
    // returns an informative "disabled" error instead of running. (Hiding it
    // entirely left the model with no concept of delegation — a live session
    // answered "delegate investigating X" by fabricating a completed
    // delegation out of the repo map already in its context.)
    const offeredTools = [...tools, DELEGATE_TASK_TOOL];
    const offered = filterToolsForPersona([...offeredTools, ...mcpTools], effectivePersona);
    toolByName.current = new Map(offered.map((t) => [t.name, t]));

    try {
      const { peer } = await ensureConnection();
      // Read after the connection exists, so the first turn of a session can
      // already have the endpoint's real answer rather than the preset's.
      const runWindow = contextWindowFor.known(active.profile, model).window;
      const runId = randomUUID();
      // Cancellation stays on the existing Esc / Ctrl+C wiring above: the
      // controller is still what the UI aborts, but aborting now sends one
      // `agent/cancel` notification to the server holding the real
      // AbortSignal (docs/phase3-protocol-design.md §5). The server also
      // cancels any in-flight tool/execute, so a running command stops too —
      // not just the model call.
      abort.signal.addEventListener('abort', () => peer.notify(METHODS.agentCancel, { runId }), { once: true });

      activeRun.current = {
        runId,
        onEvent: (event) => {
          switch (event.type) {
            case 'text':
              pushItem({ kind: 'message', message: { role: 'assistant', content: event.text } });
              return;
            case 'text_delta':
              acc += event.text;
              setLiveText(acc);
              return;
            case 'text_end':
              if (acc.trim()) pushItem({ kind: 'message', message: { role: 'assistant', content: acc } });
              acc = '';
              setLiveText('');
              return;
            case 'plan':
              pushItem({ kind: 'plan', text: event.text });
              return;
            case 'todo_update': {
              // One card per run, replaced in place — a list that scrolled a
              // new copy in on every write would be a history of bookkeeping,
              // not the answer to "what is left". Scoped to the current turn:
              // the scan stops at the last user message, so a new run gets
              // its own card rather than rewriting the previous run's.
              let at = -1;
              for (let i = itemsRef.current.length - 1; i >= 0; i--) {
                const it = itemsRef.current[i]!;
                if (it.kind === 'message' && it.message.role === 'user') break;
                if (it.kind === 'todo') {
                  at = i;
                  break;
                }
              }
              if (at >= 0) {
                const next = [...itemsRef.current];
                next[at] = { kind: 'todo', todos: event.todos };
                itemsRef.current = next;
              } else {
                itemsRef.current = [...itemsRef.current, { kind: 'todo', todos: event.todos }];
              }
              setItems(itemsRef.current);
              return;
            }
            case 'tool_call': {
              const description =
                event.name === 'ask_user'
                  ? `Ask: ${String(event.args.question ?? '').slice(0, 80)}`
                  : executor.describe({ id: event.id, name: event.name, args: event.args });
              toolDescriptions.current.set(event.id, description);
              if (event.name === 'read_file') toolLanguages.current.set(event.id, languageForPath(String(event.args.path ?? '')));
              // A sub-agent's calls carry the delegate_task call id as
              // `parent` — that is the whole of what the delegate_task
              // branch's rendering used to do, exactly as the protocol
              // design predicted.
              const chip = { kind: 'tool' as const, id: event.id, name: event.name, description, status: 'running' as const };
              if (event.parent) setLiveSubTool({ ...chip, indent: true });
              else setLiveTool(chip);
              return;
            }
            case 'tool_result': {
              if (event.parent) setLiveSubTool(undefined);
              else setLiveTool(undefined);
              pushItem({
                kind: 'tool',
                id: event.id,
                name: event.name,
                description: toolDescriptions.current.get(event.id) ?? event.name,
                status: event.isError ? 'error' : 'ok',
                summary: event.content.slice(0, TOOL_SUMMARY_CHARS),
                language: toolLanguages.current.get(event.id),
                ...(event.parent ? { indent: true } : {}),
              });
              return;
            }
            default:
              // reasoning/tool_stream/context_usage/compaction/memory_candidate
              // are produced by the loop but have no rendering here yet — the
              // same set headless.ts deliberately ignores.
              return;
          }
        },
      };

      const { outcome } = await peer.request<AgentRunResult>(METHODS.agentRun, {
        runId,
        profileName: active.profile.name,
        model,
        task: fullTask,
        history,
        // Taken and cleared together: an image belongs to the message it was
        // attached to, and leaving it staged would silently re-send it with
        // the next one.
        images: images.length > 0 ? images : undefined,
        workspaceName,
        tools: offered,
        nativeToolCalls: effectiveNativeToolCalls,
        // What the endpoint says its window is, where it has said so — the
        // preset's guess until then, which is what this always used to send.
        // Never awaited: sizing a window must not delay a turn, still less
        // hang one behind an endpoint that has stopped answering.
        contextWindow: runWindow,
        subAgents: subAgentsEnabled,
        persona: effectivePersona,
        maxIterations,
        // There is a human at this terminal, so the limit becomes a question
        // ("keep going?") instead of a wall.
        askToContinueAtLimit: true,
      } satisfies AgentRunParams);
      if (outcome === 'stopped') pushSystem('Interrupted — send a new message to continue.');
      else if (outcome === 'max-iterations')
        // Without this the run's cut-off summary — done so far, what remains —
        // is the only thing on screen, and it reads as the agent choosing to
        // stop and plan rather than being cut off mid-task.
        pushSystem(
          `Ended at the ${maxIterations ?? DEFAULT_MAX_ITERATIONS}-step limit, mid-task — the summary above is not a finished job. ` +
            'A follow-up starts fresh from that summary (the run\'s own transcript is gone), so say where to pick up — ' +
            'or raise "maxIterations" in ~/.heapcode/config.json.',
        );
      else if (outcome === 'incomplete')
        pushSystem(
          'The model kept replying without taking action and never confirmed a real completion — ' +
            'treat its last reply with suspicion. Rephrase the request or try again.',
        );
      await persist();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      activeRun.current = undefined;
      setLiveText('');
      setLiveTool(undefined);
      setLiveSubTool(undefined);
      setBusy(false);
      abortRef.current = undefined;
    }
  }

  /** A freshly added profile becomes the active one for both the config and this session. */
  function completeSetup(added: ProviderProfileConfig): void {
    setSetupActive(false);
    void (async () => {
      try {
        const next = await switchProvider!(added);
        await configStore!.setActiveProfile(added.name);
        setActive({ profile: added, contextWindow: next.contextWindow });
        setModel(added.agentModel || added.model);
        pushSystem(`Profile "${added.name}" added and active (${added.preset}, ${added.model}).`);
      } catch (err) {
        pushSystem(`Profile "${added.name}" was saved, but activating it failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  const inputBlocked =
    busy || Boolean(pendingPermission) || Boolean(pendingQuestion) || Boolean(picker) || Boolean(pendingSecret) || setupActive;

  // The footer's right side (hint text / exit-armed warning / indexing
  // progress) is short and fixed-ish; the left side embeds the active
  // model's name, which for some providers (e.g. an Ollama tag) can run
  // long enough on its own to blow past the terminal width. Box's
  // justifyContent="space-between" doesn't truncate or wrap either side, so
  // an overlong left string collides with the right one instead of just
  // getting clipped — truncate it ourselves to whatever's actually left.
  const footerRight = exitArmed
    ? 'press Ctrl+C again to exit'
    : indexProgress
      ? `indexing… ${indexProgress.embedded}/${indexProgress.total} files`
      : busy
        ? 'esc to interrupt'
        : '/ for commands · Ctrl+C twice to exit';
  const footerLeftFull = `${active.profile.name} · ${model} · ${workspaceName}${persona.id !== 'agent' ? ` · ${persona.label}` : ''}`;
  /**
   * The mode gets its own colored segment rather than being folded into the
   * dim left string: it is the one footer item that changes what the agent
   * can do without asking, so it has to stay legible at a glance — and it
   * must survive the left side's truncation, which an overlong model name
   * would otherwise eat.
   */
  const modeInfo = getPermissionModeInfo(permissionMode);
  const modeBadge = `[${modeInfo.label}]`;
  const modeColor =
    permissionMode === 'full-auto' ? 'yellow' : permissionMode === 'plan' ? 'cyan' : undefined;
  const footerGap = 2;
  const footerLeftMax = Math.max(0, columns - footerRight.length - modeBadge.length - footerGap - 1);
  const footerLeft =
    footerLeftFull.length > footerLeftMax ? `${footerLeftFull.slice(0, Math.max(0, footerLeftMax - 1))}…` : footerLeftFull;

  return (
    // marginRight reserves one empty column on the right for the whole UI —
    // a defensive buffer so full-width borders and the footer never render
    // flush against the terminal's literal last column, which is where a
    // one-cell width mismatch (an off-by-one in the terminal's own reported
    // size, a resize the app hasn't repainted for yet, etc.) turns into a
    // wrapped line and a stale, un-erased fragment on the next redraw.
    <Box flexDirection="column" marginRight={1}>
      <Static key={staticKey} items={items}>
        {(item, i) => {
          switch (item.kind) {
            case 'header':
              return (
                <Header
                  key={`h${i}`}
                  version={item.version}
                  profileName={item.profileName}
                  model={item.model}
                  baseUrl={item.baseUrl}
                  cwd={item.cwd}
                  messageCount={item.messageCount}
                  canResume={item.canResume}
                />
              );
            case 'message':
              return <MessageView key={i} message={item.message} />;
            case 'tool':
              return <ToolChip key={item.id} item={item} />;
            case 'plan':
              return (
                <Box key={i} flexDirection="column" marginBottom={1} borderStyle="round" borderColor="blue" paddingX={1}>
                  <Text color="blue" bold>
                    Plan
                  </Text>
                  <Text>{item.text}</Text>
                </Box>
              );
            case 'todo':
              return (
                <Box key={i} flexDirection="column" marginBottom={1} borderStyle="round" borderColor="magenta" paddingX={1}>
                  <Text color="magenta" bold>
                    Tasks
                  </Text>
                  {item.todos.map((todo, j) => (
                    <Text key={j} color={todo.status === 'completed' ? 'green' : todo.status === 'in_progress' ? 'yellow' : 'gray'}>
                      {todo.status === 'completed' ? '✔' : todo.status === 'in_progress' ? '▸' : '·'} {todo.content}
                      {todo.status === 'in_progress' ? ' (in progress)' : ''}
                    </Text>
                  ))}
                </Box>
              );
            case 'markdown':
              return (
                <Box key={i} marginBottom={1} flexDirection="column">
                  <Text>{renderMarkdown(item.text)}</Text>
                </Box>
              );
            case 'system':
              return (
                <Box key={i} marginBottom={1}>
                  <Text dimColor>{item.text}</Text>
                </Box>
              );
          }
        }}
      </Static>
      {liveTool && <ToolChip item={liveTool} />}
      {liveSubTool && <ToolChip item={liveSubTool} />}
      {busy && (
        <Box marginBottom={1} flexDirection="column">
          {liveText ? (
            <MessageView message={{ role: 'assistant', content: liveText }} />
          ) : !liveTool ? (
            <Text dimColor>
              <Spinner type="dots" /> working… <Text dimColor>(esc to interrupt)</Text>
            </Text>
          ) : null}
        </Box>
      )}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
      {pendingPermission && (
        <PermissionPrompt
          request={pendingPermission.req}
          onChoice={(choice) => {
            pendingPermission.resolve(choice);
            setPendingPermission(undefined);
          }}
        />
      )}
      {pendingQuestion && (
        <AskUserPrompt
          countdownSeconds={questionCountdown}
          onPartial={(partial) => {
            questionPartial.current = partial;
            questionDeadline.current?.touch();
          }}
          request={pendingQuestion.req}
          onAnswer={(answer) => {
            pendingQuestion.resolve(answer);
            setPendingQuestion(undefined);
          }}
        />
      )}
      {picker && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
          <Text color="cyan" bold>
            {picker.title}
          </Text>
          <Box marginTop={1}>
            {picker.filterable ? (
              <FilterableList items={picker.items} onSelect={(value) => picker.onPick(value)} />
            ) : (
              <SelectInput items={picker.items} onSelect={(item) => picker.onPick(item.value)} />
            )}
          </Box>
          <Text dimColor>esc to cancel</Text>
        </Box>
      )}
      {pendingSecret && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
          <Text color="cyan" bold>
            {pendingSecret.label}
          </Text>
          <TextInput
            label={pendingSecret.label}
            mask
            onSubmit={(value) => void pendingSecret.onSubmit(value)}
          />
          <Text dimColor>stored in {secretsFile()} (chmod 600) · esc to cancel</Text>
        </Box>
      )}
      {setupActive && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
          <Text color="cyan" bold>
            Add a provider profile
          </Text>
          <Setup banner={false} configStore={configStore} secretsStore={secretsStore} onComplete={completeSetup} />
          <Text dimColor>esc to cancel</Text>
        </Box>
      )}
      <Composer
        onSubmit={handleSubmit}
        disabled={inputBlocked}
        commands={COMMANDS}
        mentionCandidates={mentionCandidates}
        onMentionTrigger={handleMentionTrigger}
        onActivity={setComposerHasText}
        clearToken={clearToken}
        onAttachImage={() => void handleAttachImage()}
        onRemoveImage={handleRemoveImage}
        attachmentCount={pendingImages.length}
      />
      <Box justifyContent="space-between">
        <Box>
          <Text color={modeColor} bold={permissionMode !== 'default'}>
            {modeBadge}
          </Text>
          <Text dimColor> {footerLeft}</Text>
        </Box>
        <Text color={exitArmed ? 'yellow' : undefined} dimColor={!exitArmed}>
          {footerRight}
        </Text>
      </Box>
    </Box>
  );
}
