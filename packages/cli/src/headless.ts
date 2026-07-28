import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  filterToolsForPersona,
  getPersona,
  intersectPersonas,
  looksFilesystemMutating,
  resolveCapabilities,
  runAgent,
  type AgentOutcome,
  type Conversation,
  type PermissionClass,
  type StoredMessage,
  type ToolCall,
  type ToolResult,
} from '@heapcode/core';
import { ConfigStore } from './config/store.js';
import { SecretsStore } from './config/secrets.js';
import { JsonConversationStore } from './history/store.js';
import { canonicalize, auditFile, conversationsFile } from './paths.js';
import { resolveProvider } from './provider/resolve.js';
import { buildAgentSession } from './agentSession.js';
import { trimHistoryForAgent } from './agent/historyWindow.js';
import { loadProjectInstructions } from './memory.js';
import { AuditLog } from './audit.js';
import { DELEGATE_TASK_TOOL, runSubAgent } from './agent/delegate.js';

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
}

/**
 * NDJSON event shape streamed to stdout in `--json` mode — one line per
 * event, so a CI script can tail progress instead of waiting for a single
 * final blob. Mirrors core's `AgentEvents` almost 1:1 on purpose (guardrail
 * #8: headless is a peer of the interactive UI, not a different protocol).
 * A sub-agent's own tool_call/tool_result events carry `parent`: the
 * delegate_task call's id, so they're distinguishable from the top-level
 * agent's own activity without a separate event type.
 */
export type HeadlessEvent =
  | { type: 'text'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'plan'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; parent?: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean; parent?: string }
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
 * The `-p`/`--json` non-interactive path. Runs the FULL agent loop — tools,
 * checkpoints, RAG/repo-map, MCP — through the exact same `buildAgentSession`
 * construction and `runAgent` call the interactive Ink UI uses; this is not
 * a stripped-down copy of it (docs/CLI_PLAN.md guardrail #8). Never mounts
 * Ink — none of raw-mode stdin, a stable terminal width, or interactive
 * input can be assumed here (CI, a pipe, a redirected file).
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const config = new ConfigStore();
  const profile = opts.profileName ? await config.getProfile(opts.profileName) : await config.getActiveProfile();

  if (!profile) {
    printError(opts.json, 'No provider profile configured. Run "heapcode profile add" first.');
    return 1;
  }

  try {
    const secrets = new SecretsStore();
    const { provider, contextWindow } = await resolveProvider(profile, secrets);
    const root = canonicalize(opts.cwd ?? process.cwd());
    const capabilities = resolveCapabilities(profile);

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
    if (opts.reindex) await Promise.all([ragIndexer.buildIndex(), repoMapIndexer.buildIndex()]);

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

    const resolveProfileByName = async (name: string) => {
      const target = await config.getProfile(name);
      if (!target) return undefined;
      const resolved = await resolveProvider(target, secrets);
      return { provider: resolved.provider, profile: target };
    };

    const execute = async (call: ToolCall): Promise<ToolResult> => {
      if (call.name === 'delegate_task') {
        if (!opts.subAgents) {
          return {
            id: call.id,
            name: call.name,
            content:
              'Sub-agent delegation is disabled for this run (the --sub-agents flag was not passed). ' +
              'Handle the sub-task yourself in this conversation instead — do not claim it was delegated.',
            isError: true,
          };
        }
        return runSubAgent(call, {
          executor,
          provider,
          profile,
          nativeToolCalls: capabilities.nativeToolCalls,
          contextWindow,
          tools,
          mcpManager,
          persona,
          // A sub-agent's own tool calls resolve through the same
          // permission-mode policy as the top-level agent — no human to
          // ask here either.
          permissions: { request: (_subCall, tool) => Promise.resolve(autoApprove(tool.permission, mode)) },
          shadowGit,
          workspaceName: basename(root),
          signal: undefined,
          resolveProfile: resolveProfileByName,
          events: {
            onSubToolCall: (subCall) => emit({ type: 'tool_call', id: subCall.id, name: subCall.name, args: subCall.args, parent: call.id }),
            onSubToolResult: (result) =>
              emit({ type: 'tool_result', id: result.id, name: result.name, content: result.content, isError: result.isError, parent: call.id }),
          },
        });
      }
      if (call.name === 'ask_user') {
        // No human to ask in headless mode — same "proceed with best
        // judgment" fallback the interactive UI uses for an unanswered question.
        return { id: call.id, name: call.name, content: 'The user did not answer. Proceed with your best judgment.' };
      }
      if (mcpManager.isMcpTool(call.name)) {
        try {
          return { id: call.id, name: call.name, content: await mcpManager.call(call.name, call.args) };
        } catch (err) {
          return { id: call.id, name: call.name, content: err instanceof Error ? err.message : String(err), isError: true };
        }
      }
      if (
        call.name === 'run_command' &&
        persona.allowedPermissions &&
        !persona.allowedPermissions.includes('write') &&
        looksFilesystemMutating(String(call.args.command ?? ''))
      ) {
        return {
          id: call.id,
          name: call.name,
          content: `Blocked: this command looks like it would create, modify, or delete files, which the ${persona.label} persona does not allow.`,
          isError: true,
        };
      }
      const result = await executor.execute(call);
      if (!result.isError) await syncIndexesAfterTool(call.name, call.args, ragIndexer, repoMapIndexer);
      return result;
    };

    // Multiple assistant messages can occur in one run (narration before a
    // tool call, then a final summary) — lastText tracks only the most
    // recently COMPLETED one, mirroring App.tsx's acc/onTextEnd reset so a
    // streamed turn's deltas don't get concatenated onto an earlier turn's.
    let lastText = '';
    let deltaAcc = '';
    const outcome = await runAgent({
      provider,
      model: profile.agentModel || profile.model,
      task: fullTask,
      history,
      workspaceName: basename(root),
      tools: offeredTools,
      nativeToolCalls: capabilities.nativeToolCalls,
      contextWindow,
      execute,
      requestPermission: (call, tool) => {
        // delegate_task while sub-agents are disabled resolves to an
        // informative error in execute() — a generic permission denial here
        // would hide from the model WHY delegation can't happen.
        if (call.name === 'delegate_task' && !opts.subAgents) return Promise.resolve(true);
        const decision = autoApprove(tool.permission, mode);
        if (tool.permission !== 'read') {
          void audit.track('permission.decision', { tool: call.name, permission: tool.permission, decision: decision ? 'auto-allow' : 'auto-deny' });
        }
        return Promise.resolve(decision);
      },
      beforeToolCall: async (call) => {
        await shadowGit.snapshot(`${call.name}: ${executor.describe(call).slice(0, 80)}`);
      },
      events: {
        onText: (text) => {
          lastText = text;
          emit({ type: 'text', text });
        },
        onTextDelta: (text) => {
          deltaAcc += text;
          emit({ type: 'text_delta', text });
        },
        onTextEnd: () => {
          if (deltaAcc.trim()) lastText = deltaAcc;
          deltaAcc = '';
        },
        onPlan: (text) => emit({ type: 'plan', text }),
        onToolCall: (call) => emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args }),
        onToolResult: (result) => emit({ type: 'tool_result', id: result.id, name: result.name, content: result.content, isError: result.isError }),
      },
    });

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
      await Promise.all([ragIndexer.indexOne(path), repoMapIndexer.indexOne(path)]);
      return;
    case 'rename_file':
      if (!path || !newPath) return;
      repoMapIndexer.noteRecent(newPath);
      await Promise.all([ragIndexer.renameFile(path, newPath), repoMapIndexer.renameFile(path, newPath)]);
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
