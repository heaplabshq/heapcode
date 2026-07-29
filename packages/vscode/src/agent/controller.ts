import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  METHODS,
  connectToServer,
  filterToolsForPersona,
  getPersona,
  lineDiffStats,
  resolveCapabilities,
  type AgentEvent,
  type AgentEventParams,
  type AgentRunParams,
  type AgentRunResult,
  type ConnectOptions,
  type ContextWindowSource,
  type ExtensionToWebview,
  type KeyRequestParams,
  type KeyRequestResult,
  type McpManager,
  type FileEditInfo,
  type PermissionRequestParams,
  type PermissionRequestResult,
  type ServerConnection,
  type SnapshotBeforeParams,
  type ToolCall,
  type ToolDefinition,
  type ToolExecuteParams,
  type ToolResult,
} from '@heapcode/core';
import { agentToolDefinitions, WorkspaceToolExecutor } from './workspaceTools.js';
import { SessionCheckpoint } from './checkpoint.js';
import { PermissionEngine } from './permissions.js';
import { callLmTool, getLmToolDefinitions, getLmToolGroups, isLmTool } from './lmTools.js';
import { getActiveEditor } from '../contextCollector.js';
import { mergeWithApplyModel } from '../inlineEdit.js';
import type { ProfileManager } from '../profileManager.js';
import type { RepoMapIndexer } from '../rag/repoMapIndexer.js';
import type { ShadowGit } from './shadowGit.js';
import { appendMemoryNote, loadProjectInstructions } from '../memory.js';

/** How this host reaches the core server; `daemonEntry` is set by extension.ts, the rest by tests. */
export interface AgentServerOptions extends ConnectOptions {
  /** Reported to the server's log only, never used for authorization. */
  clientVersion?: string;
}

export class AgentController {
  private abort?: AbortController;
  private checkpoint?: SessionCheckpoint;
  /** A plan awaiting explicit approval (heapcode.agent.planGate) — see approvePlan(). */
  private pendingPlan?: { task: string; images?: string[]; personaId?: string; planText: string };

  /**
   * The connection to the core server, opened lazily on the first agent run
   * and kept afterwards (docs/phase3-protocol-design.md §2: a session IS a
   * connection). Lazily rather than at activation because most windows
   * activate this extension and never run an agent — the same reason
   * extension.ts keeps indexing off the activation path.
   */
  private connection?: ServerConnection;
  private connectedProfile?: string;
  /** Set when profile config changes under us; the next run reconnects, since profiles are pushed at hello. */
  private profilesStale = false;
  /** The run currently streaming, so one notification handler serves every run. */
  private activeRun?: { runId: string; onEvent(event: AgentEvent): void };

  /**
   * Per-run state the server→host handlers read. These were locals inside
   * `start()` when the loop ran in this process; they became fields when the
   * loop moved, because the handlers are registered once per connection and
   * outlive any single run.
   */
  private executor?: WorkspaceToolExecutor;
  private toolByName = new Map<string, ToolDefinition>();
  private fileEdits = new Map<string, FileEditInfo>();
  /** Per-tool-call shadow-git checkpoints (PLAN.md M8), keyed by call id. */
  private toolCheckpoints = new Map<string, string>();
  private contextWindowSource?: ContextWindowSource;

  /** ask_user tool: forwards the agent's question to the chat UI; set by extension.ts. */
  askUser?: (question: string, options?: string[]) => Promise<string | undefined>;

  /** Built-in tools grouped the way Copilot groups its own (read/search/edit/execute/other). */
  private static readonly BUILTIN_CATEGORIES: Array<{ label: string; names: string[] }> = [
    {
      label: 'Built-in · Read',
      names: ['read_file', 'list_dir', 'get_symbols', 'find_references', 'go_to_definition', 'get_diagnostics'],
    },
    { label: 'Built-in · Search', names: ['search', 'semantic_search', 'repo_map'] },
    {
      label: 'Built-in · Edit',
      names: ['write_file', 'edit_file', 'multi_edit', 'rename_file', 'delete_file', 'create_directory'],
    },
    { label: 'Built-in · Execute', names: ['run_command', 'run_tests', 'check_package_exists'] },
    { label: 'Built-in · Skills', names: ['list_skills', 'load_skill'] },
    { label: 'Built-in · Other', names: ['ask_user', 'fetch_url', 'delegate_task'] },
  ];

  /** All tools the agent could use, grouped by source (for the composer's tools picker). */
  listToolGroups(): Array<{
    id: string;
    label: string;
    tools: Array<{ name: string; label: string; description: string }>;
  }> {
    const groups: Array<{ id: string; label: string; tools: Array<{ name: string; label: string; description: string }> }> = [];

    const byName = new Map(agentToolDefinitions.map((t) => [t.name, t]));
    for (const cat of AgentController.BUILTIN_CATEGORIES) {
      const tools = cat.names
        .map((n) => byName.get(n))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .map((t) => ({ name: t.name, label: t.name, description: t.description }));
      if (tools.length > 0) groups.push({ id: cat.label, label: cat.label, tools });
    }

    const mcpByServer = new Map<string, Array<{ name: string; label: string; description: string }>>();
    for (const t of this.mcp?.getToolDefinitions() ?? []) {
      const withoutPrefix = t.name.replace(/^mcp__/, '');
      const sep = withoutPrefix.indexOf('__');
      const server = sep >= 0 ? withoutPrefix.slice(0, sep) : withoutPrefix;
      const label = sep >= 0 ? withoutPrefix.slice(sep + 2) : withoutPrefix;
      if (!mcpByServer.has(server)) mcpByServer.set(server, []);
      mcpByServer.get(server)!.push({ name: t.name, label, description: t.description });
    }
    for (const [server, tools] of mcpByServer) {
      groups.push({ id: `mcp-${server}`, label: `MCP · ${server}`, tools });
    }

    for (const g of getLmToolGroups()) {
      groups.push({
        id: `lm-${g.label}`,
        label: g.label,
        tools: g.tools.map((t) => ({ name: t.name, label: t.label, description: t.description })),
      });
    }

    return groups;
  }

  constructor(
    private readonly profiles: ProfileManager,
    private readonly permissions: PermissionEngine,
    private readonly log: vscode.OutputChannel,
    private readonly post: (msg: ExtensionToWebview) => void,
    private readonly mcp?: McpManager,
    private readonly repoMapIndexer?: RepoMapIndexer,
    private readonly track?: (name: string, meta?: Record<string, unknown>) => void,
    private readonly shadowGit?: ShadowGit,
    private readonly server: AgentServerOptions = {},
  ) {}

  get running(): boolean {
    return this.abort !== undefined;
  }

  /**
   * Profiles and key material are pushed at `session/hello` and the server
   * never reads this host's settings for itself (§2), so a settings edit has
   * to reach it as a new session. Deferred rather than applied immediately:
   * closing a live connection would abort whatever run is on it, and a user
   * toggling an unrelated `heapcode.*` setting mid-run should not kill it.
   */
  markProfilesChanged(): void {
    this.profilesStale = true;
  }

  /** Extension deactivation / disposal — the socket outlives runs, not the extension. */
  dispose(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  /**
   * Connect (starting the server if nothing is listening) and register the
   * four server→host request handlers.
   *
   * Their bodies are the same code that used to sit inline in the `runAgent`
   * options object; only the trigger changed — the split
   * docs/phase3-protocol-design.md §7 describes, and the same shape both CLI
   * clients already use (packages/cli/src/headless.ts:219-249,
   * packages/cli/src/ink/App.tsx:434-469).
   */
  private async ensureConnection(profileName: string, root: vscode.Uri): Promise<ServerConnection> {
    const existing = this.connection;
    if (existing && !this.profilesStale && this.connectedProfile === profileName) return existing;
    existing?.close();
    this.profilesStale = false;

    const profile = this.profiles.getProfiles().find((p) => p.name === profileName);
    const apiKey = profile ? await this.profiles.getApiKey(profile) : undefined;
    const connection = await connectToServer(
      {
        client: { name: 'heapcode-vscode', version: this.server.clientVersion },
        root: root.fsPath,
        // See ServerLink's note: the server only indexes a root it can read.
        localRoot: root.scheme === 'file',
        // Only the profile this run uses, per §2's least-exposure argument;
        // a sub-agent naming another one resolves it through key/request.
        profiles: profile ? [profile] : [],
        activeProfile: profileName,
        keys: apiKey ? { [profileName]: apiKey } : {},
      },
      this.server,
    );
    this.connection = connection;
    this.connectedProfile = profileName;
    const { peer } = connection;

    peer.onRequest(METHODS.toolExecute, async (raw, signal) => {
      const { call } = raw as ToolExecuteParams;
      return this.executeTool(call, signal);
    });

    peer.onRequest(METHODS.permissionRequest, async (raw) => {
      const { call } = raw as PermissionRequestParams;
      const tool = this.toolByName.get(call.name);
      const granted = tool ? await this.permissions.request(call, tool, this.describe(call)) : false;
      return { granted } satisfies PermissionRequestResult;
    });

    peer.onRequest(METHODS.snapshotBefore, async (raw) => {
      const { call } = raw as SnapshotBeforeParams;
      const hash = await this.shadowGit?.snapshot(`${call.name}: ${this.describe(call).slice(0, 80)}`);
      if (hash) this.toolCheckpoints.set(call.id, hash);
      return null;
    });

    peer.onRequest(METHODS.keyRequest, async (raw) => {
      const { profileName: wanted } = raw as KeyRequestParams;
      const target = this.profiles.getProfiles().find((p) => p.name === wanted);
      // Unknown profile or no stored key → the server falls back to the
      // parent's provider, the same lenient behavior runSubAgent had
      // (controller.ts:430-431 before this moved).
      if (!target) return {} satisfies KeyRequestResult;
      return { profile: target, apiKey: await this.profiles.getApiKey(target) } satisfies KeyRequestResult;
    });

    peer.onNotification(METHODS.agentEvent, (raw) => {
      const { runId, event } = raw as AgentEventParams;
      const run = this.activeRun;
      if (run && run.runId === runId) run.onEvent(event);
    });

    return connection;
  }

  /**
   * The host half of a tool call — the part that is irreducibly host-side.
   *
   * Everything here needs something only the extension host has: the chat UI
   * (ask_user), MCP subprocesses, VS Code's own language-model tools, and the
   * executor with its terminals, shell integration and LSP diagnostics
   * (workspaceTools.ts:60, :685-688, :407-408).
   *
   * MCP dispatch stays here rather than moving server-side: hosting MCP
   * subprocesses in the server is deliberately out of scope (§4 recommends it
   * but flags it as needing its own look), and this is the resolution both
   * CLI clients arrived at.
   */
  private async executeTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (call.name === 'ask_user') {
      const options = Array.isArray(call.args.options) ? call.args.options.map(String) : undefined;
      // No timeout, deliberately: a human reading a chat card may take
      // minutes. How a slow human is told apart from a wedged host is still
      // open (§7's open question 2) — neither CLI client settled it and this
      // one doesn't either.
      const answer = await this.askUser?.(String(call.args.question ?? ''), options);
      return {
        id: call.id,
        name: call.name,
        content: answer?.trim()
          ? `User answered: ${answer}`
          : 'The user did not answer. Proceed with your best judgment.',
      };
    }
    if (this.mcp?.isMcpTool(call.name)) {
      const content = await this.mcp.call(call.name, call.args);
      return { id: call.id, name: call.name, content };
    }
    if (isLmTool(call.name)) {
      try {
        const content = await callLmTool(call.name, call.args);
        return { id: call.id, name: call.name, content };
      } catch (err) {
        return {
          id: call.id,
          name: call.name,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }
    const executor = this.executor;
    if (!executor) {
      return { id: call.id, name: call.name, content: 'No agent session is active.', isError: true };
    }
    // `signal` is the RPC request's own, so a cancelled run aborts the
    // command that is running right now — not just the model call (§5).
    const result = await executor.execute(call, signal);
    if (!result.isError && (call.name === 'write_file' || call.name === 'edit_file')) {
      const info = await this.computeFileEdit(String(call.args.path ?? ''));
      if (info) this.fileEdits.set(call.id, info);
    }
    return result;
  }

  async start(
    task: string,
    images?: string[],
    opts?: { personaId?: string; resumePlanText?: string },
  ): Promise<void> {
    if (this.running) {
      this.post({ type: 'error', message: 'An agent session is already running. Stop it first.' });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.post({ type: 'error', message: 'Agent mode needs an open workspace folder.' });
      return;
    }
    const cfg = vscode.workspace.getConfiguration('heapcode.agent');
    if (!cfg.get<boolean>('enable', true)) {
      this.post({ type: 'error', message: 'Agent mode is disabled (heapcode.agent.enable).' });
      return;
    }
    // A fresh task (not a plan resume) invalidates any previously pending plan.
    if (!opts?.resumePlanText) this.pendingPlan = undefined;
    const persona = getPersona(opts?.personaId);

    // resolveRoleProfile, not resolveRole: the agent path no longer builds a
    // host-side Provider at all — the server resolves the profile to one
    // itself from the key pushed at hello (custody note, Option A2).
    const profile = this.profiles.resolveRoleProfile('agentModel');
    if (!profile.model) {
      this.post({ type: 'error', message: `Profile "${profile.name}" has no model configured.` });
      return;
    }
    const capabilities = resolveCapabilities(profile);
    if (images && images.length > 0 && !capabilities.vision) {
      this.post({
        type: 'error',
        message:
          `Profile "${profile.name}" is not marked vision-capable, so images can't be sent. ` +
          'If your model does support images, set "capabilities": {"vision": true} on the profile (heapcode.profiles).',
      });
      return;
    }

    this.track?.('agent.task.started');
    this.checkpoint = new SessionCheckpoint();
    this.permissions.resetSession();
    this.executor = new WorkspaceToolExecutor(
      root,
      this.checkpoint,
      cfg.get<number>('commandTimeout', 60) * 1000,
      // No semanticSearch injection: the server dispatches semantic_search
      // from its own index and only hands the call back here when it has
      // nothing, at which point this executor's word-based text search is
      // exactly the fallback it always was (docs/phase3-rag-design.md §5.2).
      undefined,
      this.repoMapIndexer ? (pathPrefix) => this.repoMapIndexer!.format(pathPrefix) : undefined,
      // edit_file's fast-apply fallback (M10) — no-ops (returns undefined) when no
      // applyModel is configured for the profile, same as inline-edit's own Apply action.
      (original, snippet) => mergeWithApplyModel(original, snippet, this.profiles, this.log),
    );
    this.abort = new AbortController();
    this.post({ type: 'agentStatus', status: 'running', changedFiles: [] });
    this.log.appendLine(
      `[agent] start (${capabilities.nativeToolCalls ? 'native tools' : 'text fallback'}): ${task}`,
    );

    const contextWindow = await this.profiles.contextWindowFor(
      profile,
      profile.agentModel || profile.model,
    );
    this.contextWindowSource = contextWindow.source;
    this.fileEdits = new Map();
    // Per-tool-call shadow-git checkpoints (PLAN.md M8) — keyed by call id so
    // the tool_result event can attach the hash taken just before that call ran.
    this.toolCheckpoints = new Map();
    let lastToolStreamPost = 0;
    await this.mcp?.ensureConnected();
    const mcpTools = this.mcp?.getToolDefinitions() ?? [];
    const lmTools = getLmToolDefinitions();
    const activeEditor = getActiveEditor();
    const activeFilePath = activeEditor
      ? vscode.workspace.asRelativePath(activeEditor.document.uri, false)
      : undefined;
    const instructions = await loadProjectInstructions(activeFilePath);
    const preamble = [persona.taskAddendum, instructions].filter(Boolean).join('\n\n---\n\n');
    const fullTask = preamble ? `${preamble}\n\n---\n\nTask: ${task}` : task;
    const planGate = cfg.get<boolean>('planGate', false);
    const planFirst = cfg.get<boolean>('planFirst', true);
    let capturedPlanText: string | undefined;

    const subAgents = cfg.get<boolean>('subAgents', false);
    const offered = filterToolsForPersona([...agentToolDefinitions, ...mcpTools, ...lmTools], persona)
      .filter((t) => !new Set(cfg.get<string[]>('disabledTools', [])).has(t.name))
      // Sub-agent orchestration (M12) is opt-in — a new, autonomy-increasing
      // capability, same posture as planGate/requireTestsBeforeFinish.
      .filter((t) => t.name !== 'delegate_task' || subAgents);
    // permission/request carries the call and its permission class; the
    // PermissionEngine wants the ToolDefinition, which this host has because
    // it is the host that offered the tools in the first place.
    this.toolByName = new Map(offered.map((t) => [t.name, t]));

    try {
      const { peer } = await this.ensureConnection(profile.name, root);
      const runId = randomUUID();
      // Cancellation keeps the existing stop() wiring: the UI still aborts a
      // controller, but aborting now sends one `agent/cancel` notification to
      // the server holding the real AbortSignal (§5). The server cancels any
      // in-flight tool/execute too, so a running command dies with the run.
      this.abort.signal.addEventListener('abort', () => peer.notify(METHODS.agentCancel, { runId }), {
        once: true,
      });

      // (4) in §7's split: the `events` object became a switch over the
      // `agent/event` notification union, calling the same `post()` it did.
      this.activeRun = {
        runId,
        onEvent: (event) => {
          switch (event.type) {
            case 'text':
              return this.post({ type: 'agentText', text: event.text });
            case 'text_delta':
              return this.post({ type: 'agentTextDelta', text: event.text });
            case 'text_end':
              return this.post({ type: 'agentTextEnd' });
            case 'reasoning_delta':
              return this.post({ type: 'agentReasoningDelta', text: event.text });
            case 'reasoning_end':
              return this.post({ type: 'agentReasoningEnd' });
            case 'tool_stream':
              // Throttle: one progress post per ~512 chars is plenty.
              if (event.chars - lastToolStreamPost >= 512 || event.chars < lastToolStreamPost) {
                lastToolStreamPost = event.chars;
                this.post({ type: 'agentToolStream', chars: event.chars });
              }
              return;
            case 'plan':
              capturedPlanText = event.text;
              return this.post({ type: 'agentPlan', text: event.text });
            case 'tool_call': {
              const call: ToolCall = { id: event.id, name: event.name, args: event.args };
              const description = this.describe(call);
              this.log.appendLine(`[agent] tool: ${event.parent ? '↳ ' : ''}${description}`);
              return this.post({
                type: 'agentToolCall',
                id: event.id,
                name: event.name,
                description,
                terminalCommand:
                  event.name === 'run_command' || event.name === 'run_tests'
                    ? String(event.args.command ?? '')
                    : undefined,
                // A sub-agent's calls carry the delegate_task call id as
                // `parent`. Rendering them indented is the whole of what
                // sub-agent display is now that recursion is server-side —
                // exactly as the protocol design predicted (§2).
                parent: event.parent,
              });
            }
            case 'tool_result':
              return this.post({
                type: 'agentToolResult',
                id: event.id,
                ok: !event.isError,
                summary: event.content.slice(0, TOOL_SUMMARY_CHARS),
                label: resultLabel(event.name, event.content, event.isError),
                fileEdit: this.fileEdits.get(event.id),
                checkpoint: this.toolCheckpoints.get(event.id),
                parent: event.parent,
              });
            case 'context_usage':
              return this.post({
                type: 'contextUsage',
                used: event.usedTokens,
                window: event.windowTokens,
                source: this.contextWindowSource,
              });
            case 'compaction':
              this.log.appendLine(
                `[agent] compacted context: ~${event.beforeTokens} → ~${event.afterTokens} tokens`,
              );
              return this.post({ type: 'compacted', before: event.beforeTokens, after: event.afterTokens });
            case 'memory_candidate':
              void (async () => {
                const answer = await this.askUser?.(
                  `Worth remembering for next time?\n\n"${event.note}"`,
                  ['Save to memory', 'Skip'],
                );
                if (answer === 'Save to memory') await appendMemoryNote(event.note);
              })();
              return;
          }
        },
      };

      const { outcome } = await peer.request<AgentRunResult>(METHODS.agentRun, {
        runId,
        profileName: profile.name,
        model: profile.agentModel || profile.model,
        task: fullTask,
        images,
        workspaceName: path.basename(root.fsPath),
        tools: offered,
        nativeToolCalls: capabilities.nativeToolCalls,
        persona,
        subAgents,
        plan: planFirst,
        planOnly: !opts?.resumePlanText && planFirst && planGate,
        resumePlan: opts?.resumePlanText,
        proposeMemoryNote: cfg.get<boolean>('memoryDistillation', true),
        requireVerificationBeforeFinish: cfg.get<boolean>('requireTestsBeforeFinish', false),
        maxIterations: cfg.get<number>('maxIterations', 25),
        // Unset max_tokens defaults to ~1k on some providers (e.g. NVIDIA NIM),
        // which truncates large write_file calls mid-generation. Capped at a
        // quarter of the window so small local models don't reject the request.
        maxTokens: profile.maxTokens ?? Math.min(16_384, Math.floor(contextWindow.window / 4)),
        contextWindow: contextWindow.window,
      } satisfies AgentRunParams);
      this.log.appendLine(`[agent] finished: ${outcome}`);
      this.track?.('agent.task.completed', { outcome });
      this.pendingPlan =
        outcome === 'planned'
          ? { task, images, personaId: opts?.personaId, planText: capturedPlanText ?? '' }
          : undefined;
      // Snapshot the agent's final version of each touched file — this is
      // what makes Reapply possible after a revert or a manual undo.
      await this.checkpoint.captureFinals();
      this.post({
        type: 'agentStatus',
        status: outcome,
        changedFiles: this.checkpoint.changedFiles(),
      });
    } catch (err) {
      // The loop used to run in this process and swallowed its own failures
      // into outcome 'error'. Reaching it over a socket adds one new failure
      // mode — an unreachable server — which §6 says to surface once, loudly,
      // rather than spinning forever on a dead daemon.
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[agent] failed: ${message}`);
      this.post({ type: 'error', message });
      this.post({ type: 'agentStatus', status: 'error', changedFiles: this.checkpoint.changedFiles() });
      if (/Could not reach the Heap Code server/.test(message)) {
        void vscode.window
          .showErrorMessage(message, 'Show Log')
          .then((choice) => (choice === 'Show Log' ? this.log.show() : undefined));
      }
    } finally {
      this.abort = undefined;
      this.activeRun = undefined;
    }
  }

  /** Approve a pending plan (outcome 'planned') and let the agent execute it. */
  async approvePlan(): Promise<void> {
    const pending = this.pendingPlan;
    if (!pending) return;
    this.pendingPlan = undefined;
    await this.start(pending.task, pending.images, {
      personaId: pending.personaId,
      resumePlanText: pending.planText,
    });
  }

  /** +/− line counts for a just-edited file (checkpoint original vs current). */
  private async computeFileEdit(relPath: string): Promise<FileEditInfo | undefined> {
    const entry = this.checkpoint?.entryFor(relPath);
    if (!entry) return undefined;
    try {
      const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(entry.path));
      const original = entry.original ? new TextDecoder().decode(entry.original) : '';
      const { added, removed } = lineDiffStats(original, current);
      return { path: relPath, added, removed };
    } catch {
      return undefined;
    }
  }

  /**
   * Reads `this.executor` rather than taking one: the executor is per-run and
   * this is called from handlers registered once per connection. Falls back to
   * the bare call shape if a description is somehow wanted with no run active.
   */
  private describe(call: ToolCall): string {
    if (this.mcp?.isMcpTool(call.name)) {
      return `MCP tool ${call.name.replace(/^mcp__/, '').replace('__', ': ')} ${JSON.stringify(call.args).slice(0, 120)}`;
    }
    if (isLmTool(call.name)) {
      return `VS Code tool ${call.name.replace(/^vslm__/, '')} ${JSON.stringify(call.args).slice(0, 120)}`;
    }
    return this.executor?.describe(call) ?? `${call.name} ${JSON.stringify(call.args).slice(0, 120)}`;
  }

  stop(): void {
    this.abort?.abort();
  }

  async revert(): Promise<void> {
    const reverted = (await this.checkpoint?.revertAll()) ?? [];
    if (reverted.length > 0) this.track?.('checkpoint.revertAll', { count: reverted.length });
    this.post({
      type: 'agentText',
      text:
        reverted.length > 0
          ? `Reverted ${reverted.length} file(s): ${reverted.join(', ')}. Use Reapply to bring any back.`
          : 'Nothing to revert.',
    });
    this.postChangedFiles();
  }

  /** Native diff: checkpointed original (left) vs the agent's result (right). */
  async diffFile(relPath: string): Promise<void> {
    const entry = this.checkpoint?.entryFor(relPath);
    if (!entry) return;
    agentOriginals.set(relPath, entry.original ?? new Uint8Array());
    const originalUri = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${relPath}` });
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      entry.path,
      `Heap Code Agent: ${relPath}`,
      { preview: true },
    );
  }

  async revertFile(relPath: string): Promise<void> {
    const ok = await this.checkpoint?.revertFile(relPath);
    if (ok) {
      this.track?.('checkpoint.revertFile');
      this.post({ type: 'agentText', text: `Reverted ${relPath}.` });
    }
    this.postChangedFiles();
  }

  /** Restore the agent's version (after a Revert or a manual undo). */
  async reapplyFile(relPath: string): Promise<void> {
    const ok = await this.checkpoint?.reapplyFile(relPath);
    if (ok) this.track?.('checkpoint.reapplyFile');
    this.post({
      type: 'agentText',
      text: ok ? `Reapplied the agent's version of ${relPath}.` : `Could not reapply ${relPath}.`,
    });
    this.postChangedFiles();
  }

  keepFile(relPath: string): void {
    this.checkpoint?.keepFile(relPath);
    this.track?.('checkpoint.keepFile');
    this.postChangedFiles();
  }

  /** Accept every remaining (non-reverted) file at once — the "Keep all" counterpart to Revert all. */
  keepAll(): void {
    const kept = this.checkpoint?.keepAll() ?? [];
    if (kept.length > 0) this.track?.('checkpoint.keepAll', { count: kept.length });
    this.post({
      type: 'agentText',
      text: kept.length > 0 ? `Kept ${kept.length} file(s): ${kept.join(', ')}.` : 'Nothing to keep.',
    });
    this.postChangedFiles();
  }

  private postChangedFiles(): void {
    this.post({
      type: 'agentStatus',
      status: 'done',
      changedFiles: this.checkpoint?.changedFiles() ?? [],
    });
  }
}

const ORIGINAL_SCHEME = 'heapcode-agent-original';
const agentOriginals = new Map<string, Uint8Array>();

export function registerAgentDiffProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
      provideTextDocumentContent(uri: vscode.Uri): string {
        const bytes = agentOriginals.get(uri.path.slice(1));
        return bytes ? new TextDecoder().decode(bytes) : '';
      },
    }),
  );
}

/** How much tool output the expandable chip in the chat can show (it scrolls). */
export const TOOL_SUMMARY_CHARS = 5_000;

export function resultLabel(name: string, content: string, isError?: boolean): string {
  if (isError) return content.split('\n')[0]!.slice(0, 80);
  switch (name) {
    case 'read_file':
      return `${content.split('\n').length} lines`;
    case 'search':
    case 'semantic_search':
      return content === 'No matches.' ? 'no matches' : `${content.split('\n').length} result(s)`;
    case 'list_dir':
      return `${content.split('\n').length} entries`;
    case 'get_diagnostics':
      return content.startsWith('No errors') ? 'clean' : `${content.split('\n').length} problem(s)`;
    case 'run_command':
    case 'run_tests': {
      const match = /^exit code: (\S+)/.exec(content);
      return match ? `exit ${match[1]}` : 'done';
    }
    case 'check_package_exists':
      return content.includes('NOT found') ? 'not found' : 'exists';
    case 'delegate_task': {
      const match = /^outcome: (\S+)/.exec(content);
      return match ? `sub-agent ${match[1]}` : 'done';
    }
    default:
      return 'done';
  }
}
