import { randomUUID } from 'node:crypto';
import { basename, relative, resolve } from 'node:path';
import {
  ASK_USER_NO_ANSWER,
  DEFAULT_PERMISSION_MODE,
  METHODS,
  applyModeToPersona,
  filterToolsForPersona,
  getPersona,
  resolveCapabilities,
  resolveContextWindow,
  resolveUnattended,
  type PermissionMode,
  type AgentEvent,
  type AgentEventParams,
  type AgentOutcome,
  type AgentRunParams,
  type AgentRunResult,
  type ChatMessage,
  type Conversation,
  type KeyRequestParams,
  type KeyRequestResult,
  type PermissionRequestParams,
  type PermissionRequestResult,
  type RagIndexParams,
  type RagIndexResult,
  type SnapshotBeforeParams,
  type StoredMessage,
  type TokenUsage,
  type ToolCall,
  type ToolExecuteParams,
  type ToolResult,
} from '@heapcode/core';
import {
  ConfigStore,
  DELEGATE_TASK_TOOL,
  JsonConversationStore,
  SecretsStore,
  auditFile,
  buildAgentSession,
  canonicalize,
  conversationsFile,
  trimHistoryForAgent,
  type WorkspaceChange,
} from '@heapcode/host';
import { loadProjectInstructions } from './memory.js';
import { buildFixPrompt, clampOutput, parseVerifyCommand, runVerifyCommand, type VerifyRun } from './verify.js';
import { AuditLog } from './audit.js';
import { connectToServer, type ConnectOptions } from './server/client.js';
import { cliVersion } from './version.js';

/**
 * The permission modes are core's now (agent/permissionModes.ts) — the
 * terminal UI and the extension toggle between the same four, so the policy
 * cannot live here. Re-exported because `--permission-mode` is this module's
 * public surface and callers already import the type from it.
 *
 * There is no human to prompt in headless mode, so `resolveUnattended` is
 * what turns core's allow/ask/deny into a yes or no: everything fails closed
 * except under full-auto, the mode whose entire purpose is finishing a run
 * with nobody watching. That keeps CI behavior exactly as documented while
 * the interactive hosts resolve the same `ask` by putting up a prompt.
 */
export type { PermissionMode };

export interface HeadlessOptions {
  prompt: string;
  json: boolean;
  profileName?: string;
  newConversation?: boolean;
  /** Continue a specific conversation by id (exact or unambiguous prefix) instead of the most recent — see the "Session:" line printed on interactive exit. */
  resumeId?: string;
  cwd?: string;
  personaId?: string;
  permissionMode?: PermissionMode;
  /** Offers delegate_task — off by default, same opt-in posture as the interactive /subagents toggle. */
  subAgents?: boolean;
  /** false disables local audit-log recording (no remote sending exists to opt out of — see audit.ts). Default true. */
  telemetryEnabled?: boolean;
  /**
   * Rebuild the semantic-search + repo-map indexes before running the task.
   * Unlike the interactive UI (which kicks off a background build on every
   * launch), headless mode only loads whatever was already persisted —
   * cheap and fast for a CI job that runs the same repo repeatedly, but
   * blind to any file the agent's own tool calls haven't touched yet on a
   * fresh checkout. Off by default (indexing takes real time); pass this
   * for the first run against a repo, or after files changed outside heapcode.
   */
  reindex?: boolean;
  /**
   * `--verify "<command>"`: the project's own checks, run once the agent
   * believes it is finished. A failure is fed back as a new turn and the
   * agent gets to fix it, up to `verifyMax` cycles.
   *
   * The string is the INVOKER's, captured here and parsed exactly once into
   * an argv that is spawned without a shell — see verify.ts, which explains
   * why that property is what makes running commands acceptable in a mode
   * where `run_command` itself is denied.
   */
  verify?: string;
  /** Maximum number of times the verify command runs (so at most `verifyMax - 1` fix turns). Default 3. */
  verifyMax?: number;
  /** Include the run's unified diff in the result. The `filesChanged` summary is always included. */
  diff?: boolean;
  /** Test seam: point at an already-running server instead of autostarting one. */
  server?: ConnectOptions;
}

/**
 * NDJSON event shape streamed to stdout in `--json` mode — one line per
 * event, so a CI script can tail progress instead of waiting for a single
 * final blob.
 *
 * The agent-progress members now come from @heapcode/core's `AgentEvent`
 * (the protocol type — see docs/phase3-protocol-design.md §4, which called
 * for exactly this move); `result` stays here because it is headless's own
 * summary line, not something the agent loop produces. The emitted shapes
 * are unchanged, so anything already consuming `heapcode -p --json` sees the
 * same stream it always did.
 */
export type HeadlessEvent =
  | Extract<AgentEvent, { type: 'text' | 'text_delta' | 'plan' | 'tool_call' | 'tool_result' }>
  | {
      type: 'result';
      outcome: AgentOutcome;
      response: string;
      model: string;
      profile: string;
      sessionId: string;
      /**
       * Everything the run changed on disk, so a supervising caller can review
       * without opening each file. Additive — the six fields above are byte
       * for byte what they always were, in the same order.
       *
       * Always present (an empty array when nothing changed); `diff` only
       * when `--diff` asked for it.
       */
      filesChanged: WorkspaceChange[];
      /** Files the run opened, in the order it first opened them — see the recorder in runHeadless. */
      filesRead: string[];
      diff?: string;
      verify?: VerifyReport;
      /** What the run cost, for a caller weighing this model against a more expensive one. */
      usage: RunUsage;
    };

/**
 * The run's own bill. Token counts are summed over every model call the run
 * made — agent turns, the compaction summary, sub-agents, and any `--verify`
 * fix cycles — and are `null` when the endpoint reported nothing, which is
 * deliberately different from 0: "not measured" and "free" are not the same
 * answer to "did delegating this save anything?".
 */
export interface RunUsage extends TokenUsage {
  /** Wall-clock for the whole run, including tool execution and verify cycles. */
  elapsedMs: number;
  model: string;
  profile: string;
}

/** `--verify`'s outcome, for a caller that needs "green after 2 attempts" vs "still red, here's why" without running anything itself. */
export interface VerifyReport {
  /** Exactly as the invoker wrote it. */
  command: string;
  passed: boolean;
  /**
   * How many times the command ran. 1 = passed (or failed) first try with no
   * fix turn; 0 = never ran, because the agent run itself errored or was
   * interrupted before there was anything to check.
   */
  cycles: number;
  /** The last failure's stdout+stderr — present only when it never passed. */
  lastFailureOutput?: string;
}

/** Default for `--verify-max`. Three runs = two chances to fix, which is where the observed lint/format failures land. */
const DEFAULT_VERIFY_MAX = 3;

/** A diff is for review, not for flooding a context window; past this it is cut with a marker saying so. */
const MAX_DIFF_CHARS = 200_000;

/** outcome → process exit code: a clean finish is 0; anything that didn't actually complete the task is non-zero. */
function exitCodeFor(outcome: AgentOutcome): number {
  switch (outcome) {
    case 'done':
    case 'planned':
      return 0;
    case 'stopped':
      return 130;
    case 'max-iterations':
    case 'incomplete':
    case 'error':
      return 1;
  }
}

/**
 * The `-p`/`--json` non-interactive path.
 *
 * Runs the FULL agent loop — tools, checkpoints, RAG/repo-map, MCP — but no
 * longer in this process: the loop runs in the core server, and this is its
 * first protocol client (docs/phase3-protocol-design.md §7). What stays here
 * is everything genuinely host-shaped — the workspace executor, shadow-git,
 * the indexes, MCP dispatch, the permission policy above, and the NDJSON
 * output — reached by the server through `tool/execute`,
 * `permission/request`, `snapshot/before` and `key/request`.
 *
 * External behavior is deliberately unchanged: same flags, same NDJSON
 * events, same exit codes.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  /** Wall clock for the whole invocation — what a caller comparing two models against the same task actually waited. */
  const startedAt = Date.now();
  /**
   * Parsed once, here, from the invoker's own string — before a profile is
   * even loaded, so a malformed command fails the invocation instead of
   * surfacing after a model has already been paid for. Frozen because every
   * later cycle spawns THIS array; nothing rebuilds it from a string again.
   */
  let verifyArgv: readonly string[] | undefined;
  if (opts.verify !== undefined) {
    try {
      verifyArgv = Object.freeze(parseVerifyCommand(opts.verify));
    } catch (err) {
      printError(opts.json, err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
  const verifyMax = Math.max(1, Math.floor(opts.verifyMax ?? DEFAULT_VERIFY_MAX));

  const config = new ConfigStore();
  const profile = opts.profileName ? await config.getProfile(opts.profileName) : await config.getActiveProfile();

  if (!profile) {
    printError(opts.json, 'No provider profile configured. Run "heapcode profile add" first.');
    return 1;
  }

  let connection: Awaited<ReturnType<typeof connectToServer>> | undefined;
  try {
    const secrets = new SecretsStore();
    const root = canonicalize(opts.cwd ?? process.cwd());
    const capabilities = resolveCapabilities(profile);
    const contextWindow = resolveContextWindow(profile);

    const historyStore = new JsonConversationStore(conversationsFile(root));
    let conversation: Conversation | undefined;
    if (opts.resumeId) {
      conversation = await historyStore.findByIdOrPrefix(opts.resumeId);
      if (!conversation) {
        printError(opts.json, `No saved conversation matching "${opts.resumeId}" in this project (or the prefix is ambiguous).`);
        return 1;
      }
    } else if (!opts.newConversation) {
      conversation = await historyStore.mostRecent();
    }
    conversation ??= { id: randomUUID(), title: opts.prompt.slice(0, 60), updatedAt: Date.now(), messages: [] };
    const history = trimHistoryForAgent(conversation.messages);

    const { executor, shadowGit, repoMapIndexer, mcpManager, tools } = buildAgentSession(
      root,
      config,
      secrets,
      cliVersion(),
      // Reaches for `connection` at call time — it is assigned below, after
      // this session is built. edit_file's fast-apply fallback; see
      // agentSession.ts.
      async (original, snippet) => {
        if (!connection) return undefined;
        try {
          const res = await connection.peer.request<{ merged?: string }>(METHODS.applyMerge, {
            original,
            snippet,
            profileName: profile.name,
          });
          return res.merged;
        } catch {
          // The edit failure this was rescuing is the real result.
          return undefined;
        }
      },
    );
    const telemetryEnabled = opts.telemetryEnabled ?? (await config.load()).telemetryEnabled ?? true;
    const audit = new AuditLog(auditFile(), () => telemetryEnabled);
    await Promise.all([repoMapIndexer.init(), mcpManager.ensureConnected()]);

    const mode: PermissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
    // "plan" forces read-only regardless of the chosen persona — see
    // applyModeToPersona, which the interactive hosts call at the same point.
    const persona = applyModeToPersona(getPersona(opts.personaId), mode);

    const mcpTools = mcpManager.getToolDefinitions();
    // delegate_task is always OFFERED so the model can see it exists and
    // respond honestly when asked to delegate; without --sub-agents, calling
    // it returns an informative "disabled" error instead of running. (It used
    // to be hidden entirely when disabled — the model then had no way to know
    // delegation was even a concept, and a live session responded to
    // "delegate investigating X" by fabricating a completed delegation.)
    const offeredTools = filterToolsForPersona([...tools, DELEGATE_TASK_TOOL, ...mcpTools], persona);

    // Same task-preamble shape as the interactive UI's runTask: persona
    // constraints + project instructions/memory, then the task itself.
    const instructions = await loadProjectInstructions(root).catch(() => '');
    const preamble = [persona.taskAddendum, instructions].filter(Boolean).join('\n\n---\n\n');
    const fullTask = preamble ? `${preamble}\n\n---\n\nTask: ${opts.prompt}` : opts.prompt;

    const emit = (event: HeadlessEvent): void => {
      if (opts.json) process.stdout.write(`${JSON.stringify(event)}\n`);
    };

    /** Shadow-git commit of the workspace before the run changed anything; see the snapshot/before handler below. */
    let baseline: string | undefined;

    /**
     * Files the run actually opened, in the order it first opened them.
     *
     * Recorded from the tool calls themselves as they execute — never from the
     * model's own account of what it looked at, which is exactly the thing a
     * supervising caller cannot trust. A brief that says "an equivalent guard
     * already exists in X — follow that pattern" is checkable in one glance:
     * either X is in this list or the instruction was ignored.
     *
     * A Set preserves insertion order, so this reads as the run's actual
     * investigation sequence rather than an alphabetised inventory.
     */
    const filesRead = new Set<string>();
    const noteFileRead = (call: ToolCall): void => {
      // Only tools that open ONE named file. `search` and `semantic_search`
      // return snippets from files the run never opened, and `list_dir` shows
      // names and no content — counting either would turn "did it read X?"
      // into a question this list cannot actually answer.
      if (call.name !== 'read_file' && call.name !== 'get_symbols') return;
      const path = typeof call.args.path === 'string' ? call.args.path : undefined;
      if (!path) return;
      // Workspace-relative, to match filesChanged — the model is asked for
      // relative paths but nothing stops it sending an absolute one.
      const rel = relative(root, resolve(root, path));
      filesRead.add(!rel || rel.startsWith('..') ? path : rel.split('\\').join('/'));
    };

    // Key material for this session, pushed once at hello and held in the
    // server's memory only (custody note, Option A2). Other profiles are
    // resolved lazily through `key/request` below.
    const apiKey = await secrets.getApiKey(profile.name);
    connection = await connectToServer(
      {
        client: { name: 'heapcode-cli', version: cliVersion() },
        root,
        profiles: [profile],
        activeProfile: profile.name,
        keys: apiKey ? { [profile.name]: apiKey } : {},
      },
      opts.server,
    );
    const { peer } = connection;

    /**
     * Ask the server to index. contextualRetrieval is always on for the CLI,
     * passed explicitly rather than read server-side, so the extension's
     * "off by default" and this stay different on purpose (decision 6).
     */
    const requestIndex = (params: Omit<RagIndexParams, 'contextualRetrieval'>): Promise<RagIndexResult> =>
      peer.request<RagIndexResult>(METHODS.ragIndex, { ...params, contextualRetrieval: true } satisfies RagIndexParams);

    // --reindex now happens server-side, after hello, because that is where
    // the index and the embeddings key live. The repo map still builds here:
    // it needs no key and no model.
    if (opts.reindex) await Promise.all([requestIndex({ full: true }), repoMapIndexer.buildIndex()]);

    // ---- server → host requests -------------------------------------------
    // These are the same bodies that used to be inline in the runAgent
    // options object; only their trigger changed.

    peer.onRequest(METHODS.toolExecute, async (raw) => {
      const { call } = raw as ToolExecuteParams;
      return executeTool(call);
    });

    peer.onRequest(METHODS.permissionRequest, async (raw) => {
      const { call, permission } = raw as PermissionRequestParams;
      // delegate_task while sub-agents are disabled resolves to an
      // informative error server-side — a generic permission denial here
      // would hide from the model WHY delegation can't happen.
      if (call.name === 'delegate_task' && !opts.subAgents) return { granted: true } satisfies PermissionRequestResult;
      const decision = resolveUnattended(permission, mode);
      if (permission !== 'read') {
        void audit.track('permission.decision', { tool: call.name, permission, decision: decision ? 'auto-allow' : 'auto-deny' });
      }
      return { granted: decision } satisfies PermissionRequestResult;
    });

    peer.onRequest(METHODS.snapshotBefore, async (raw) => {
      const { call } = raw as SnapshotBeforeParams;
      const hash = await shadowGit.snapshot(`${call.name}: ${executor.describe(call).slice(0, 80)}`);
      // The run's FIRST snapshot is the workspace as it was before the agent
      // touched anything — exactly the base the change summary needs, already
      // being taken for checkpointing. Deriving it from these rather than
      // committing a baseline up front is what keeps a chat-only `-p` run as
      // cheap as it has always been: no tool call, no snapshot, no git at all.
      baseline ??= hash;
      return null;
    });

    peer.onRequest(METHODS.keyRequest, async (raw) => {
      const { profileName } = raw as KeyRequestParams;
      const target = await config.getProfile(profileName);
      // No such profile, or no key stored → the server falls back to the
      // parent's provider, matching the pre-server behavior exactly.
      if (!target) return {} satisfies KeyRequestResult;
      return { profile: target, apiKey: await secrets.getApiKey(profileName) } satisfies KeyRequestResult;
    });

    async function executeTool(call: ToolCall): Promise<ToolResult> {
      if (call.name === 'ask_user') {
        // No human to ask in headless mode — same "proceed with best judgment"
        // fallback the interactive UI uses for an unanswered question. It
        // answers synchronously, so the idle timeout the other two hosts honor
        // can never apply here, whatever the setting says: there is no wait to
        // bound. blocksAction is irrelevant for the same reason.
        return { id: call.id, name: call.name, content: ASK_USER_NO_ANSWER };
      }
      if (mcpManager.isMcpTool(call.name)) {
        // MCP stays host-side for now: hosting MCP subprocesses in the server
        // is deliberately out of scope here (docs/phase3-protocol-design.md
        // §4 recommends it but flags it as needing its own look).
        try {
          return { id: call.id, name: call.name, content: await mcpManager.call(call.name, call.args) };
        } catch (err) {
          return { id: call.id, name: call.name, content: err instanceof Error ? err.message : String(err), isError: true };
        }
      }
      const result = await executor.execute(call);
      if (!result.isError) {
        // Only a read that succeeded counts: a read_file on a path that does
        // not exist is the opposite of evidence that the run consulted it.
        noteFileRead(call);
        await syncIndexesAfterTool(call.name, call.args, requestIndex, repoMapIndexer);
      }
      return result;
    }

    // ---- server → host events ---------------------------------------------
    // Multiple assistant messages can occur in one run (narration before a
    // tool call, then a final summary) — lastText tracks only the most
    // recently COMPLETED one, mirroring App.tsx's acc/onTextEnd reset so a
    // streamed turn's deltas don't get concatenated onto an earlier turn's.
    let lastText = '';
    let deltaAcc = '';
    /** Not a const any more: a `--verify` fix cycle is a second `agent/run`, and each run needs its own id. */
    let runId = randomUUID();

    peer.onNotification(METHODS.agentEvent, (raw) => {
      const { runId: eventRun, event } = raw as AgentEventParams;
      if (eventRun !== runId) return;
      switch (event.type) {
        case 'text':
          lastText = event.text;
          emit(event);
          return;
        case 'text_delta':
          deltaAcc += event.text;
          emit(event);
          return;
        case 'text_end':
          if (deltaAcc.trim()) lastText = deltaAcc;
          deltaAcc = '';
          return; // never emitted — headless's NDJSON has no text_end line
        case 'plan':
        case 'tool_call':
        case 'tool_result':
          emit(event);
          return;
        default:
          // reasoning/tool_stream/context_usage/compaction/memory_candidate:
          // the loop produces them, headless has never emitted them, and
          // starting now would change this command's output contract.
          return;
      }
    });

    /**
     * Summed over every `agent/run` this invocation makes — the task itself
     * plus each `--verify` fix cycle — because the caller is billed for all of
     * them and is asking one question: what did this run cost?
     */
    const usage: TokenUsage = { promptTokens: null, completionTokens: null, totalTokens: null };

    /** One `agent/run`, with its own run id so a verify fix cycle's events aren't filtered out as a stale run's. */
    const runAgentTurn = async (task: string, turnHistory: ChatMessage[]): Promise<AgentOutcome> => {
      runId = randomUUID();
      deltaAcc = '';
      const result = await peer.request<AgentRunResult>(METHODS.agentRun, {
        runId,
        profileName: profile.name,
        model: profile.agentModel || profile.model,
        task,
        history: turnHistory,
        workspaceName: basename(root),
        tools: offeredTools,
        nativeToolCalls: capabilities.nativeToolCalls,
        contextWindow,
        subAgents: opts.subAgents,
        persona,
      } satisfies AgentRunParams);
      for (const key of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
        const reported = result.usage?.[key];
        if (reported !== null && reported !== undefined) usage[key] = (usage[key] ?? 0) + reported;
      }
      return result.outcome;
    };

    /**
     * With `--verify`, the baseline is taken up front instead of being
     * inherited from the agent's first snapshot.
     *
     * The check a caller should point this at is one that REPAIRS and then
     * checks (`ruff format && ruff check` behind a make target), and a repair
     * step edits files without any tool call of the agent's having done it.
     * Waiting for the agent's first snapshot would miss those edits entirely
     * whenever the agent itself changed nothing — reporting a clean tree that
     * the formatter had in fact rewritten. Paying for one `git add -A` here is
     * cheap next to the command this run is about to execute anyway.
     */
    if (verifyArgv) baseline = await shadowGit.snapshot('headless: before task');

    let outcome = await runAgentTurn(fullTask, history);

    // Accumulated rather than pushed straight onto the conversation, because
    // a fix cycle needs the turns so far as ITS history before any of them
    // are saved.
    const turns: StoredMessage[] = [
      { role: 'user', content: opts.prompt } as StoredMessage,
      { role: 'assistant', content: lastText } as StoredMessage,
    ];

    let verify: VerifyReport | undefined;
    if (verifyArgv) {
      let cycles = 0;
      let last: VerifyRun | undefined;
      // A run that errored or was interrupted never got to the point of
      // having something to check; leaving cycles at 0 says so without
      // inventing a failure the command never reported.
      if (outcome !== 'error' && outcome !== 'stopped') {
        for (;;) {
          cycles++;
          last = await runVerifyCommand(verifyArgv, root);
          // A command that could not be started at all is the invoker's typo,
          // not something the model can fix — spending model turns on it would
          // only bury the real problem.
          if (last.exitCode === 0 || last.spawnFailed || cycles >= verifyMax) break;
          const fixPrompt = buildFixPrompt(opts.verify!, last);
          // Same shape as the first turn: persona constraints and project
          // instructions still apply to a fix, and the stored turn is the
          // readable prompt, not the preamble-wrapped one.
          outcome = await runAgentTurn(
            preamble ? `${preamble}\n\n---\n\nTask: ${fixPrompt}` : fixPrompt,
            trimHistoryForAgent([...conversation.messages, ...turns]),
          );
          turns.push({ role: 'user', content: fixPrompt } as StoredMessage, { role: 'assistant', content: lastText } as StoredMessage);
        }
      }
      const passed = last?.exitCode === 0;
      verify = {
        command: opts.verify!,
        passed,
        cycles,
        ...(passed || !last ? {} : { lastFailureOutput: last.output }),
      };
    }

    conversation.messages.push(...turns);
    conversation.updatedAt = Date.now();
    await historyStore.save(conversation);

    // No baseline means nothing in this run ever took a snapshot, which means
    // no non-read tool was ever permitted to run — so there is nothing to
    // diff, and no git process worth starting to prove it.
    const changes = baseline ? await shadowGit.changesSince(baseline, opts.diff) : { files: [], diff: opts.diff ? '' : undefined };
    const diff = changes.diff === undefined ? undefined : clampDiff(changes.diff);

    // The agent model, not profile.model — that is what actually consumed the
    // tokens when a profile routes agent turns to a different model. The
    // long-standing `model` field above keeps reporting profile.model.
    const runUsage: RunUsage = {
      ...usage,
      elapsedMs: Date.now() - startedAt,
      model: profile.agentModel || profile.model,
      profile: profile.name,
    };

    emit({
      type: 'result',
      outcome,
      response: lastText,
      model: profile.model,
      profile: profile.name,
      sessionId: conversation.id,
      filesChanged: changes.files,
      filesRead: [...filesRead],
      diff,
      verify,
      usage: runUsage,
    });
    if (!opts.json) {
      // Plain-text mode prints the final response exactly once — tool
      // activity and streamed deltas are headless-JSON-only concerns.
      process.stdout.write(`${lastText}\n`);
      process.stdout.write(formatFooter(changes.files, diff, verify));
      // Both of these are about the RUN, not about the work — so they go where
      // the session line has always gone: stderr, never polluting a piped
      // stdout. `heapcode -p "explain this" > answer.txt` still writes exactly
      // the answer. The change table above is the opposite case: it IS the
      // work product, and a caller reviewing the run wants it in the same
      // stream as the summary.
      if (filesRead.size > 0) process.stderr.write(formatFilesRead([...filesRead]));
      process.stderr.write(`Usage: ${formatUsage(runUsage)}\n`);
      process.stderr.write(`Session: ${conversation.id.slice(0, 8)}  (--resume ${conversation.id.slice(0, 8)} to continue this later)\n`);
    }
    const code = exitCodeFor(outcome);
    // A run whose checks are still red did not succeed, whatever the agent
    // concluded — the whole point of --verify is that the caller doesn't have
    // to re-derive that.
    if (verify && !verify.passed) return code === 0 ? 1 : code;
    return code;
  } catch (err) {
    printError(opts.json, err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    connection?.close();
  }
}

/**
 * Mirrors App.tsx's syncIndexesAfterTool. The host is still what knows a file
 * changed — the trigger stays here, the work moved to the server (§4). One
 * `rag/index` call covers writes, renames and deletes alike: indexing a path
 * the server cannot read drops it.
 */
async function syncIndexesAfterTool(
  name: string,
  args: Record<string, unknown>,
  requestIndex: (params: { paths: string[] }) => Promise<unknown>,
  repoMapIndexer: Awaited<ReturnType<typeof buildAgentSession>>['repoMapIndexer'],
): Promise<void> {
  const path = typeof args.path === 'string' ? args.path : undefined;
  const newPath = typeof args.newPath === 'string' ? args.newPath : undefined;
  switch (name) {
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
      if (!path) return;
      repoMapIndexer.noteRecent(path);
      await Promise.all([requestIndex({ paths: [path] }), repoMapIndexer.indexOne(path)]);
      return;
    case 'rename_file':
      if (!path || !newPath) return;
      repoMapIndexer.noteRecent(newPath);
      await Promise.all([requestIndex({ paths: [path, newPath] }), repoMapIndexer.renameFile(path, newPath)]);
      return;
    case 'delete_file':
      if (!path) return;
      await Promise.all([requestIndex({ paths: [path] }), repoMapIndexer.removeFile(path)]);
      return;
    default:
      return;
  }
}

/** Capped for the terminal only — the --json array is never truncated. */
const MAX_LISTED_READS = 20;

/**
 * What the run opened, for stderr. A caller checking whether a specific file
 * was consulted greps this; the full list is always in --json.
 */
function formatFilesRead(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_READS);
  const rest = paths.length - shown.length;
  return `Read ${paths.length} file${paths.length === 1 ? '' : 's'}: ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}\n`;
}

/**
 * One line for stderr. "not reported" rather than zeros, because an
 * endpoint that sends no `usage` block and a turn that genuinely cost nothing
 * are different facts and only one of them is plausible.
 */
function formatUsage(usage: RunUsage): string {
  const seconds = `${(usage.elapsedMs / 1000).toFixed(1)}s`;
  const where = `${usage.model} (profile: ${usage.profile})`;
  if (usage.totalTokens === null && usage.promptTokens === null && usage.completionTokens === null) {
    return `tokens not reported by this endpoint · ${seconds} · ${where}`;
  }
  const n = (v: number | null): string => (v === null ? '?' : v.toLocaleString('en-US'));
  return `${n(usage.promptTokens)} prompt + ${n(usage.completionTokens)} completion = ${n(usage.totalTokens)} tokens · ${seconds} · ${where}`;
}

/** Truncated with a marker rather than silently: a caller reviewing a diff has to be able to tell it is not the whole one. */
function clampDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated at ${MAX_DIFF_CHARS} of ${diff.length} characters — pass --json for the same fields, or review the files directly\n`;
}

/**
 * The plain-text tail: what changed, then (optionally) the diff, then how the
 * project's own checks went.
 *
 * Deliberately greppable — one line per file, fixed `path | +n | -n` shape —
 * because the reader is as likely to be another agent piping this through
 * `grep` as a person reading it. Empty when there is nothing to say, so a
 * plain `heapcode -p "explain this"` prints exactly what it always printed.
 */
function formatFooter(files: WorkspaceChange[], diff: string | undefined, verify: VerifyReport | undefined): string {
  const parts: string[] = [];
  if (files.length > 0) {
    const insertions = files.reduce((n, f) => n + f.insertions, 0);
    const deletions = files.reduce((n, f) => n + f.deletions, 0);
    const width = files.reduce((n, f) => Math.max(n, f.path.length), 0);
    parts.push(
      `\nChanges: ${files.length} file${files.length === 1 ? '' : 's'}, +${insertions} -${deletions}\n` +
        files.map((f) => `  ${f.path.padEnd(width)} | +${f.insertions} | -${f.deletions} | ${f.status}`).join('\n') +
        '\n',
    );
  }
  if (diff) parts.push(`\n--- diff ---\n${diff.endsWith('\n') ? diff : `${diff}\n`}`);
  if (verify) {
    const verdict =
      verify.cycles === 0
        ? 'never ran — the agent run itself did not complete'
        : `${verify.passed ? 'passed' : 'FAILED'} after ${verify.cycles} attempt${verify.cycles === 1 ? '' : 's'}`;
    parts.push(`\nVerify: ${verdict} — ${verify.command}\n`);
    if (verify.lastFailureOutput) parts.push(`${clampOutput(verify.lastFailureOutput)}\n`);
  }
  return parts.join('');
}

function printError(json: boolean, message: string): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
}
