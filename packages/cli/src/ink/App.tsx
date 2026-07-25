import { randomUUID } from 'node:crypto';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import { useTerminalColumns } from './useTerminalColumns.js';
import {
  builtinPrompts,
  parseSlashCommand,
  renderTemplate,
  runAgent,
  type Conversation,
  type PermissionChoice,
  type Provider,
  type ProviderProfileConfig,
  type StoredMessage,
  type ToolDefinition,
} from '@heapcode/core';
import type { ConfigStore } from '../config/store.js';
import type { SecretsStore } from '../config/secrets.js';
import type { JsonConversationStore } from '../history/store.js';
import type { WorkspaceToolExecutor } from '../agent/workspaceTools.js';
import type { SessionCheckpoint } from '../agent/checkpoint.js';
import type { PermissionEngine } from '../agent/permissions.js';
import type { ShadowGit } from '../agent/shadowGit.js';
import {
  BUILTIN_PERSONAS,
  filterToolsForPersona,
  getPersona,
  intersectPersonas,
  looksFilesystemMutating,
  type AgentPersona,
} from '../agent/personas.js';
import { listSkillsFormatted } from '../agent/skills.js';
import { trimHistoryForAgent } from '../agent/historyWindow.js';
import { loadProjectInstructions } from '../memory.js';
import { configFile, secretsFile } from '../paths.js';
import type { RagIndexer } from '../rag/indexer.js';
import type { RepoMapIndexer } from '../rag/repoMapIndexer.js';
import type { McpManager } from '../agent/mcp.js';
import { DELEGATE_TASK_TOOL, runSubAgent } from '../agent/delegate.js';
import { Composer, type SlashCommand } from './Composer.js';
import { Header } from './Header.js';
import { Setup } from './Setup.js';
import { MessageView } from './MessageView.js';
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
  { name: '/settings', description: 'Show current configuration' },
  { name: '/memory', description: 'Show the project instructions & memory the agent sees' },
  { name: '/skills', description: 'List available Skills' },
  { name: '/search', args: '<query>', description: 'Search the workspace (semantic if indexed, plain text otherwise)' },
  { name: '/index', description: 'Rebuild the semantic search + repo map indexes' },
  { name: '/mcp', description: 'List configured MCP servers and their connection status' },
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Picker {
  title: string;
  items: Array<{ label: string; value: string }>;
  onPick(value: string): void;
}

export interface AppProps {
  provider: Provider;
  profile: ProviderProfileConfig;
  conversation: Conversation;
  historyStore: JsonConversationStore;
  executor: WorkspaceToolExecutor;
  checkpoint: SessionCheckpoint;
  permissions: PermissionEngine;
  shadowGit?: ShadowGit;
  tools: ToolDefinition[];
  nativeToolCalls: boolean;
  workspaceName: string;
  contextWindow: number;
  /** Enables /model and /profile persistence; omitted in tests. */
  configStore?: ConfigStore;
  /** Needed by "/profile add" (stores the API key) and "/profile remove" (deletes it). */
  secretsStore?: SecretsStore;
  /** Re-resolves a provider (API key lookup + client construction) for /profile switches. */
  switchProvider?(profile: ProviderProfileConfig): Promise<{ provider: Provider; contextWindow: number }>;
  version?: string;
  cwd?: string;
  safeMode?: boolean;
  /** Earlier conversations exist in this project at launch — shows the /resume hint. */
  canResume?: boolean;
  /** Lazy source for `@` mention autocomplete (ignore-aware workspace paths, folders end with `/`). */
  listWorkspaceFiles?(): Promise<string[]>;
  /** Semantic search — omitted in tests/headless; /search and @workspace no-op gracefully without one. */
  ragIndexer?: RagIndexer;
  /** Structural repo outline — same tool/@workspace fallback path as ragIndexer when no embeddings model is configured. */
  repoMapIndexer?: RepoMapIndexer;
  /** MCP servers — reconnected at the start of every task; their tools go through the same permission system as workspace tools. */
  mcpManager?: McpManager;
  /** Local audit log (see audit.ts) — best-effort, never blocks on failure. */
  onTrack?(name: string, meta?: Record<string, unknown>): void;
  /** Fired once on mount and again whenever the active conversation changes (/new, /resume) — lets the host print the session id on exit. */
  onSessionChange?(id: string): void;
  /** Best-effort registry check for a newer published version — omitted (no-op) when disabled via --no-update-check or config, or in tests/headless. */
  checkUpdate?(): Promise<{ current: string; latest: string } | undefined>;
}

export function App({
  provider,
  profile,
  conversation,
  historyStore,
  executor,
  checkpoint,
  permissions,
  shadowGit,
  tools,
  nativeToolCalls,
  workspaceName,
  contextWindow,
  configStore,
  secretsStore,
  switchProvider,
  version,
  cwd,
  safeMode,
  canResume,
  listWorkspaceFiles,
  ragIndexer,
  repoMapIndexer,
  mcpManager,
  onTrack,
  onSessionChange,
  checkUpdate,
}: AppProps): React.ReactElement {
  const { exit } = useApp();

  // Session state that /model and /profile can change mid-session. The props
  // are just the initial values resolved by cli.tsx.
  const [active, setActive] = useState({ provider, profile, contextWindow });
  const [model, setModel] = useState(profile.agentModel || profile.model);

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
  const [picker, setPicker] = useState<Picker>();
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

  const [indexProgress, setIndexProgress] = useState<{ embedded: number; total: number }>();

  // Build both indexes once at mount, in the background — never blocks the
  // composer. RepoMapIndexer needs no embeddings model, so it's always
  // useful; RagIndexer.buildIndex no-ops (logged, not shown) without one.
  useEffect(() => {
    if (!ragIndexer && !repoMapIndexer) return;
    let cancelled = false;
    void (async () => {
      await Promise.all([ragIndexer?.init(), repoMapIndexer?.init()]);
      if (cancelled) return;
      void repoMapIndexer?.buildIndex();
      void ragIndexer
        ?.buildIndex((embedded, total) => {
          if (!cancelled) setIndexProgress({ embedded, total });
        })
        .then(() => {
          if (!cancelled) setIndexProgress(undefined);
        });
    })();
    return () => {
      cancelled = true;
    };
    // Indexers are stable instances for the process lifetime (constructed once in cli.tsx) — run once on mount only.
  }, []);

  /** Keeps both indexes in sync with the agent's own file edits — see rag/indexer.ts's comment on why no filesystem watcher is used instead. */
  async function syncIndexesAfterTool(name: string, args: Record<string, unknown>): Promise<void> {
    if (!ragIndexer && !repoMapIndexer) return;
    const path = typeof args.path === 'string' ? args.path : undefined;
    const newPath = typeof args.newPath === 'string' ? args.newPath : undefined;
    switch (name) {
      case 'write_file':
      case 'edit_file':
      case 'multi_edit':
        if (!path) return;
        repoMapIndexer?.noteRecent(path);
        await Promise.all([ragIndexer?.indexOne(path), repoMapIndexer?.indexOne(path)]);
        return;
      case 'rename_file':
        if (!path || !newPath) return;
        repoMapIndexer?.noteRecent(newPath);
        await Promise.all([ragIndexer?.renameFile(path, newPath), repoMapIndexer?.renameFile(path, newPath)]);
        return;
      case 'delete_file':
        if (!path) return;
        ragIndexer?.removeFile(path);
        repoMapIndexer?.removeFile(path);
        return;
      default:
        return;
    }
  }

  // Ctrl+C protocol: clear typed input first; on an empty prompt, arm a
  // two-second "press again to exit" window instead of exiting outright.
  const [composerHasText, setComposerHasText] = useState(false);
  const [clearToken, setClearToken] = useState(0);
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout>>();

  const abortRef = useRef<AbortController>();
  const toolDescriptions = useRef(new Map<string, string>());
  /** highlight.js language per in-flight call, inferred from a `path` arg — read_file's numbered content is the case this exists for. */
  const toolLanguages = useRef(new Map<string, string | undefined>());

  useEffect(() => {
    permissions.attachRequester(
      (req) => new Promise<PermissionChoice>((resolve) => setPendingPermission({ req, resolve })),
    );
  }, [permissions]);

  useEffect(() => () => clearTimeout(exitTimer.current), []);

  function doExit(): void {
    exit();
  }

  useInput((input, key) => {
    if (key.escape) {
      if (setupActive) {
        setSetupActive(false);
        pushSystem('Profile setup cancelled.');
      } else if (picker) setPicker(undefined);
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
        setPicker(undefined);
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
      const models = await active.provider.listModels();
      if (models.length === 0) {
        pushSystem('This endpoint does not list models. Set one directly with "/model <id>".');
        return;
      }
      setPicker({
        title: `Select a model (current: ${model})`,
        items: models.map((m) => ({ label: m.id === model ? `${m.id} (current)` : m.id, value: m.id })),
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
        setActive({ provider: next.provider, profile: target, contextWindow: next.contextWindow });
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
    if (ragIndexer?.ready) {
      const hits = await ragIndexer.query(query);
      pushSystem(
        hits.length === 0
          ? `No semantic matches for "${query}".`
          : hits.map((h) => `${h.record.path}:${h.record.startLine}-${h.record.endLine}  (score ${h.score.toFixed(2)})`).join('\n'),
      );
      return;
    }
    const words = query.split(/\W+/).filter((w) => w.length > 2).map(escapeRegExp);
    const pattern = words.length > 0 ? words.join('|') : escapeRegExp(query);
    const result = await executor.execute({ id: 'search-cmd', name: 'search', args: { pattern } });
    pushSystem(`(no semantic index — plain text search for /${pattern}/)\n${result.content}`);
  }

  async function showSettings(): Promise<void> {
    const p = active.profile;
    const ragStatus = await ragIndexer?.status();
    pushSystem(
      [
        `Session     ${conversationRef.current.id.slice(0, 8)}  (heapcode --resume ${conversationRef.current.id.slice(0, 8)} to continue this later)`,
        `Profile     ${p.name} (${p.preset})`,
        `Endpoint    ${p.baseUrl}`,
        `Model       ${model}${p.agentModel && p.agentModel !== p.model ? ` (agent: ${p.agentModel})` : ''}`,
        `Persona     ${persona.label}`,
        `Sub-agents  ${subAgentsEnabled ? 'on' : 'off'} (/subagents to toggle)`,
        `Safe mode   ${safeMode ? 'on (--safe-mode)' : 'off'}`,
        `Search      ${ragStatus ? `${ragStatus.state} — ${ragStatus.files} files, ${ragStatus.chunks} chunks` : 'unavailable'}${ragStatus?.state === 'no-embedder' ? ' (set embeddingsModel on the profile, e.g. nomic-embed-text)' : ''}`,
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
      case '/persona':
        handlePersona(rest[0]);
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
        await mcpManager.ensureConnected();
        const names = mcpManager.connectedServerNames();
        pushSystem(
          names.length === 0
            ? 'No MCP servers connected. Configure them under "mcpServers" in ~/.heapcode/config.json or <cwd>/.heapcode/mcp.json.'
            : `Connected: ${names.join(', ')} (${mcpManager.getToolDefinitions().length} tool(s) total).`,
        );
        return true;
      }
      case '/index': {
        pushSystem('Rebuilding indexes…');
        await Promise.all([ragIndexer?.buildIndex(), repoMapIndexer?.buildIndex()]);
        const status = await ragIndexer?.status();
        const rmReady = repoMapIndexer?.ready;
        pushSystem(
          [
            status
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
    const effectivePersona = personaOverride ? intersectPersonas(persona, personaOverride) : persona;
    setError(undefined);
    setBusy(true);
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
      const semantic = ragIndexer?.ready ? await ragIndexer.queryFormatted(query).catch(() => '') : '';
      if (semantic) workspaceContext = `Relevant workspace context (semantic search):\n${semantic}`;
      else if (repoMapIndexer?.ready) workspaceContext = `Workspace structure overview (no semantic index configured):\n${repoMapIndexer.format()}`;
    }
    const mentionNote = /(^|\s)@[^\s@]+/.test(display)
      ? 'Paths prefixed with @ in the task are file/folder references in this workspace — read them for context.'
      : '';
    const preamble = [effectivePersona.taskAddendum, instructions, workspaceContext, mentionNote].filter(Boolean).join('\n\n---\n\n');
    const fullTask = preamble ? `${preamble}\n\n---\n\nTask: ${task}` : task;

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

    try {
      const outcome = await runAgent({
        provider: active.provider,
        model,
        task: fullTask,
        history,
        workspaceName,
        tools: filterToolsForPersona([...offeredTools, ...mcpTools], effectivePersona),
        nativeToolCalls,
        contextWindow: active.contextWindow,
        signal: abort.signal,
        execute: async (call) => {
          if (call.name === 'ask_user') {
            const options = Array.isArray(call.args.options) ? call.args.options.map(String) : undefined;
            const answer = await new Promise<string>((resolve) =>
              setPendingQuestion({ req: { question: String(call.args.question ?? ''), options }, resolve }),
            );
            setPendingQuestion(undefined);
            return {
              id: call.id,
              name: call.name,
              content: answer.trim() ? `User answered: ${answer}` : 'The user did not answer. Proceed with your best judgment.',
            };
          }
          if (call.name === 'delegate_task') {
            if (!subAgentsEnabled) {
              return {
                id: call.id,
                name: call.name,
                content:
                  'Sub-agent delegation is disabled in this session. Tell the user they can enable it with ' +
                  '/subagents on, and handle the sub-task yourself in this conversation — do not claim it was delegated.',
                isError: true,
              };
            }
            return runSubAgent(call, {
              executor,
              provider: active.provider,
              profile: active.profile,
              nativeToolCalls,
              contextWindow: active.contextWindow,
              tools,
              mcpManager,
              persona: effectivePersona,
              permissions,
              shadowGit,
              workspaceName,
              signal: abort.signal,
              resolveProfile: async (name) => {
                if (!configStore || !switchProvider) return undefined;
                const target = await configStore.getProfile(name);
                if (!target) return undefined;
                const next = await switchProvider(target);
                return { provider: next.provider, profile: target };
              },
              events: {
                onSubToolCall: (subCall) => {
                  const description = executor.describe(subCall);
                  toolDescriptions.current.set(subCall.id, description);
                  if (subCall.name === 'read_file') toolLanguages.current.set(subCall.id, languageForPath(String(subCall.args.path ?? '')));
                  setLiveSubTool({ kind: 'tool', id: subCall.id, name: subCall.name, description, status: 'running', indent: true });
                },
                onSubToolResult: (result) => {
                  setLiveSubTool(undefined);
                  pushItem({
                    kind: 'tool',
                    id: result.id,
                    name: result.name,
                    description: toolDescriptions.current.get(result.id) ?? result.name,
                    status: result.isError ? 'error' : 'ok',
                    summary: result.content.slice(0, TOOL_SUMMARY_CHARS),
                    language: toolLanguages.current.get(result.id),
                    indent: true,
                  });
                },
              },
            });
          }
          if (mcpManager?.isMcpTool(call.name)) {
            try {
              return { id: call.id, name: call.name, content: await mcpManager.call(call.name, call.args) };
            } catch (err) {
              return { id: call.id, name: call.name, content: err instanceof Error ? err.message : String(err), isError: true };
            }
          }
          // A shell command can mutate files as easily as write_file — block
          // it for write-restricted personas (same guard as the extension).
          if (
            call.name === 'run_command' &&
            effectivePersona.allowedPermissions &&
            !effectivePersona.allowedPermissions.includes('write') &&
            looksFilesystemMutating(String(call.args.command ?? ''))
          ) {
            return {
              id: call.id,
              name: call.name,
              content:
                `Blocked: this command looks like it would create, modify, or delete files, which the ` +
                `${effectivePersona.label} persona does not allow. Use a persona with file-editing tools instead.`,
              isError: true,
            };
          }
          const result = await executor.execute(call, abort.signal);
          if (!result.isError) await syncIndexesAfterTool(call.name, call.args);
          return result;
        },
        requestPermission: (call, tool) => {
          // delegate_task while sub-agents are off resolves to an informative
          // error in execute() — prompting the user to approve something that
          // cannot run would be noise.
          if (call.name === 'delegate_task' && !subAgentsEnabled) return Promise.resolve(true);
          return permissions.request(call, tool, executor.describe(call));
        },
        beforeToolCall: async (call) => {
          await shadowGit?.snapshot(`${call.name}: ${executor.describe(call).slice(0, 80)}`);
        },
        events: {
          onText: (text) => pushItem({ kind: 'message', message: { role: 'assistant', content: text } }),
          onTextDelta: (chunk) => {
            acc += chunk;
            setLiveText(acc);
          },
          onTextEnd: () => {
            if (acc.trim()) pushItem({ kind: 'message', message: { role: 'assistant', content: acc } });
            acc = '';
            setLiveText('');
          },
          onPlan: (planText) => pushItem({ kind: 'plan', text: planText }),
          onToolCall: (call) => {
            const description = call.name === 'ask_user' ? `Ask: ${String(call.args.question ?? '').slice(0, 80)}` : executor.describe(call);
            toolDescriptions.current.set(call.id, description);
            if (call.name === 'read_file') toolLanguages.current.set(call.id, languageForPath(String(call.args.path ?? '')));
            setLiveTool({ kind: 'tool', id: call.id, name: call.name, description, status: 'running' });
          },
          onToolResult: (result) => {
            setLiveTool(undefined);
            pushItem({
              kind: 'tool',
              id: result.id,
              name: result.name,
              description: toolDescriptions.current.get(result.id) ?? result.name,
              status: result.isError ? 'error' : 'ok',
              summary: result.content.slice(0, TOOL_SUMMARY_CHARS),
              language: toolLanguages.current.get(result.id),
            });
          },
        },
      });
      if (outcome === 'stopped') pushSystem('Interrupted — send a new message to continue.');
      else if (outcome === 'incomplete')
        pushSystem(
          'The model kept replying without taking action and never confirmed a real completion — ' +
            'treat its last reply with suspicion. Rephrase the request or try again.',
        );
      await persist();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLiveText('');
      setLiveTool(undefined);
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
        setActive({ provider: next.provider, profile: added, contextWindow: next.contextWindow });
        setModel(added.agentModel || added.model);
        pushSystem(`Profile "${added.name}" added and active (${added.preset}, ${added.model}).`);
      } catch (err) {
        pushSystem(`Profile "${added.name}" was saved, but activating it failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  const inputBlocked = busy || Boolean(pendingPermission) || Boolean(pendingQuestion) || Boolean(picker) || setupActive;

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
  const footerGap = 2;
  const footerLeftMax = Math.max(0, columns - footerRight.length - footerGap);
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
            <SelectInput items={picker.items} onSelect={(item) => picker.onPick(item.value)} />
          </Box>
          <Text dimColor>esc to cancel</Text>
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
      />
      <Box justifyContent="space-between">
        <Text dimColor>{footerLeft}</Text>
        <Text color={exitArmed ? 'yellow' : undefined} dimColor={!exitArmed}>
          {footerRight}
        </Text>
      </Box>
    </Box>
  );
}
