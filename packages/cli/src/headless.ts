import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  METHODS,
  filterToolsForPersona,
  getPersona,
  intersectPersonas,
  resolveCapabilities,
  resolveContextWindow,
  type AgentEvent,
  type AgentEventParams,
  type AgentOutcome,
  type AgentRunParams,
  type AgentRunResult,
  type Conversation,
  type KeyRequestParams,
  type KeyRequestResult,
  type PermissionClass,
  type PermissionRequestParams,
  type PermissionRequestResult,
  type SnapshotBeforeParams,
  type StoredMessage,
  type ToolCall,
  type ToolExecuteParams,
  type ToolResult,
} from '@heapcode/core';
import { ConfigStore } from './config/store.js';
import { SecretsStore } from './config/secrets.js';
import { JsonConversationStore } from './history/store.js';
import { canonicalize, auditFile, conversationsFile } from './paths.js';
import { buildAgentSession } from './agentSession.js';
import { CLI_INDEX_OPTIONS } from './rag/indexer.js';
import { trimHistoryForAgent } from './agent/historyWindow.js';
import { loadProjectInstructions } from './memory.js';
import { AuditLog } from './audit.js';
import { DELEGATE_TASK_TOOL } from './agent/delegate.js';
import { connectToServer, type ConnectOptions } from './server/client.js';
import { cliVersion } from './version.js';

/**
 * A closed, small set of non-interactive permission policies — deliberately
 * not a free-form allowlist DSL, to keep the safety surface reviewable.
 * There is no human to prompt in headless mode, so every mode must resolve
 * every permission decision on its own:
 *   plan      — read-only tools only; nothing to approve, nothing offered
 *               that could mutate anything.
 *   default   — every tool is offered so the model can see what exists and
 *               explain what it would need, but write/execute/destructive
 *               calls are denied (the agent adapts or finishes with a
 *               report) — the safe choice when no mode is specified.
 *   auto-edit — file edits auto-approved; shell commands still denied.
 *   full-auto — everything auto-approved. For CI automation that's meant
 *               to actually finish a task unattended.
 */
export type PermissionMode = 'plan' | 'default' | 'auto-edit' | 'full-auto';

function autoApprove(permission: PermissionClass, mode: PermissionMode): boolean {
  if (permission === 'read') return true;
  if (mode === 'full-auto') return true;
  if (mode === 'auto-edit') return permission === 'write';
  return false; // 'default' and 'plan' (plan additionally never offers non-read tools at all)
}

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
  | { type: 'result'; outcome: AgentOutcome; response: string; model: string; profile: string; sessionId: string };

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

    const { executor, shadowGit, ragIndexer, repoMapIndexer, mcpManager, tools } = buildAgentSession(root, profile, config, secrets);
    const telemetryEnabled = opts.telemetryEnabled ?? (await config.load()).telemetryEnabled ?? true;
    const audit = new AuditLog(auditFile(), () => telemetryEnabled);
    await Promise.all([ragIndexer.init(), repoMapIndexer.init(), mcpManager.ensureConnected()]);
    if (opts.reindex) await Promise.all([ragIndexer.buildIndex(CLI_INDEX_OPTIONS), repoMapIndexer.buildIndex()]);

    const mode: PermissionMode = opts.permissionMode ?? 'default';
    // "plan" forces read-only regardless of the chosen persona — the same
    // effect as always intersecting with Architect, reusing the exact logic
    // that already keeps a restricted parent from granting a sub-agent more
    // than it has itself.
    let persona = getPersona(opts.personaId);
    if (mode === 'plan') persona = intersectPersonas(persona, getPersona('architect'));

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
      const decision = autoApprove(permission, mode);
      if (permission !== 'read') {
        void audit.track('permission.decision', { tool: call.name, permission, decision: decision ? 'auto-allow' : 'auto-deny' });
      }
      return { granted: decision } satisfies PermissionRequestResult;
    });

    peer.onRequest(METHODS.snapshotBefore, async (raw) => {
      const { call } = raw as SnapshotBeforeParams;
      await shadowGit.snapshot(`${call.name}: ${executor.describe(call).slice(0, 80)}`);
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
        // No human to ask in headless mode — same "proceed with best
        // judgment" fallback the interactive UI uses for an unanswered question.
        return { id: call.id, name: call.name, content: 'The user did not answer. Proceed with your best judgment.' };
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
      if (!result.isError) await syncIndexesAfterTool(call.name, call.args, ragIndexer, repoMapIndexer);
      return result;
    }

    // ---- server → host events ---------------------------------------------
    // Multiple assistant messages can occur in one run (narration before a
    // tool call, then a final summary) — lastText tracks only the most
    // recently COMPLETED one, mirroring App.tsx's acc/onTextEnd reset so a
    // streamed turn's deltas don't get concatenated onto an earlier turn's.
    let lastText = '';
    let deltaAcc = '';
    const runId = randomUUID();

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

    const { outcome } = await peer.request<AgentRunResult>(METHODS.agentRun, {
      runId,
      profileName: profile.name,
      model: profile.agentModel || profile.model,
      task: fullTask,
      history,
      workspaceName: basename(root),
      tools: offeredTools,
      nativeToolCalls: capabilities.nativeToolCalls,
      contextWindow,
      subAgents: opts.subAgents,
      persona,
    } satisfies AgentRunParams);

    conversation.messages.push(
      { role: 'user', content: opts.prompt } as StoredMessage,
      { role: 'assistant', content: lastText } as StoredMessage,
    );
    conversation.updatedAt = Date.now();
    await historyStore.save(conversation);

    emit({ type: 'result', outcome, response: lastText, model: profile.model, profile: profile.name, sessionId: conversation.id });
    if (!opts.json) {
      // Plain-text mode prints the final response exactly once — tool
      // activity and streamed deltas are headless-JSON-only concerns.
      process.stdout.write(`${lastText}\n`);
      // Same discoverability as the interactive exit line — stderr so it never pollutes a piped stdout.
      process.stderr.write(`Session: ${conversation.id.slice(0, 8)}  (--resume ${conversation.id.slice(0, 8)} to continue this later)\n`);
    }
    return exitCodeFor(outcome);
  } catch (err) {
    printError(opts.json, err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    connection?.close();
  }
}

/** Mirrors App.tsx's syncIndexesAfterTool — keeps both indexes in sync with the agent's own file edits, no filesystem watcher needed. */
async function syncIndexesAfterTool(
  name: string,
  args: Record<string, unknown>,
  ragIndexer: Awaited<ReturnType<typeof buildAgentSession>>['ragIndexer'],
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
      await Promise.all([ragIndexer.indexOne(path, CLI_INDEX_OPTIONS), repoMapIndexer.indexOne(path)]);
      return;
    case 'rename_file':
      if (!path || !newPath) return;
      repoMapIndexer.noteRecent(newPath);
      await Promise.all([ragIndexer.renameFile(path, newPath, CLI_INDEX_OPTIONS), repoMapIndexer.renameFile(path, newPath)]);
      return;
    case 'delete_file':
      if (!path) return;
      ragIndexer.removeFile(path);
      repoMapIndexer.removeFile(path);
      return;
    default:
      return;
  }
}

function printError(json: boolean, message: string): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
}
