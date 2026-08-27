import {
  askUserAnswerMessage,
  runAgent,
  ASK_USER_NO_ANSWER,
  askUserBlocksAction,
  type AgentOutcome,
  type PermissionClass,
  type ToolCall,
  type ToolResult,
} from '@heapcode/core/agent';
import { createProvider, resolveContextWindow, resolveCapabilities } from '@heapcode/core/providers';
import type { ChatMessage } from '@heapcode/core/providers';
import { loadApiKey, loadFiles, loadUseDebugger, type StoredProfile } from '../shared/settings.js';
import { DriverPool } from './driverPool.js';
import { BrowserToolExecutor } from './executor.js';
import { READ_ONLY_TOOLS, SCREENSHOT } from './tools.js';
import { BROWSER_AGENT_PROMPT } from './prompt.js';
import { activeSite, sendToPage, ensurePage } from '../sidepanel/page.js';
import { decide, mayOfferAlwaysAllow, type BrowserMode } from './originPolicy.js';
import { recordAudit } from './audit.js';
import { ATTACH_FILE, MUTATING_TOOLS } from './actions.js';
import { RunBudget } from './limits.js';

/**
 * Runs one agent task in the side panel.
 *
 * The loop runs *here*, in the panel document, and never in the service worker.
 * Chrome terminates an idle MV3 worker after about 30 seconds while a run is
 * minutes of model calls, so a run hosted there cannot finish (PRD section 7.1,
 * PLAN guardrail 3). The panel is an ordinary document and lives as long as it
 * is open, at the cost that closing it ends the run -- which the UI states
 * rather than leaving to be discovered.
 *
 * Everything below is core's loop unmodified. The only browser-specific parts
 * are the tool belt, the executor, and the system prompt, which is exactly the
 * seam REUSE.md predicted: heapbrowse needs a new tool belt, not a new agent.
 */

export interface RunEvents {
  /**
   * The finish summary -- the answer the model meant to give, which core sends
   * separately from the narration it streams along the way. Dropping this and
   * showing the accumulated narration instead is what made a run read as the
   * model repeating itself.
   */
  onText(text: string): void;
  onTextDelta(text: string): void;
  onTextEnd(): void;
  onToolCall(call: ToolCall): void;
  onToolResult(result: ToolResult): void;
  onContextUsage(used: number, window: number): void;
  onCompaction(before: number, after: number): void;
  /** A picture of what the agent is looking at. For the panel only. */
  onView(dataUrl: string): void;
}

/** What the user is asked, in their own terms rather than the model's. */
export interface ConfirmRequest {
  tool: string;
  permission: PermissionClass;
  /** Our own description of the element, not the model's account of it. */
  target: string;
  host: string;
  /** Why this was escalated, when it was. */
  reason?: string;
  /** Whether "always allow on this site" may be offered for this action. */
  mayAlwaysAllow: boolean;
}

export type ConfirmAnswer = 'allow' | 'always' | 'deny';

export interface RunRequest {
  profile: StoredProfile;
  task: string;
  history: ChatMessage[];
  events: RunEvents;
  signal: AbortSignal;
  mode: BrowserMode;
  /** Hosts the user has trusted for writes, this session. */
  trustedHosts: Set<string>;
  /** Ask the human. Resolves when they answer; there is no timeout. */
  confirm(request: ConfirmRequest): Promise<ConfirmAnswer>;
  /** Told when the user trusts a host, so the panel can remember it. */
  onTrustHost(host: string): void;
  /** Told when policy refused outright, so the panel can explain it. */
  onBlocked(reason: string): void;
  /**
   * Put a question from the agent to the user. Resolves with their answer, or
   * undefined if they chose to let it decide.
   */
  ask(question: { question: string; options?: string[]; blocksAction: boolean }): Promise<string | undefined>;
}

export async function runBrowserAgent(request: RunRequest): Promise<AgentOutcome> {
  // The debugger banner must not outlive the run that raised it; a banner left
  // up after the agent has stopped reads to a user as something watching them.
  return withDriverPool(request);
}

async function withDriverPool(request: RunRequest): Promise<AgentOutcome> {
  const { profile, task, history, events, signal, mode, trustedHosts, confirm } = request;

  const apiKey = await loadApiKey();
  const provider = createProvider(profile, apiKey);

  const [useDebugger, files] = await Promise.all([loadUseDebugger(), loadFiles()]);
  const pool = new DriverPool(useDebugger, (reason) => request.onBlocked(reason));
  const executor = new BrowserToolExecutor(task, {
    pool,
    files,
    onView: (dataUrl) => events.onView(dataUrl),
  });
  // One budget per run. Checked before anything is shown to the user, so a
  // page that gets the model to propose forty actions cannot turn that into
  // forty confirmations to click through.
  const budget = new RunBudget();

  // The site the panel is pointed at stands in for heapcode's workspace name:
  // it is the thing the agent is working on, and naming it stops the model
  // asking which page the user means.
  const site = await activeSite();

  /**
   * The permission decision for one call.
   *
   * The class is inferred from the page, not the tool name -- `click` on a
   * filter and `click` on "Place order" are the same call. Policy then decides
   * from that class *and* the origin, and only what policy says to ask about
   * reaches the human. Nothing here is delegated to the model: it requests, the
   * engine and the user decide (PRD section 6.1.3).
   */
  const requestPermission = async (
    call: ToolCall,
  ): Promise<boolean | { allowed: boolean; reason: string }> => {
    const { classification, target, url } = await executor.classify(call);
    const host = url ? safeHost(url) : (site?.host ?? '');

    const decision = decide({
      permission: classification.permission,
      host,
      mode,
      trustedHosts,
    });

    const base = {
      at: Date.now(),
      host,
      tool: call.name,
      args: call.args,
      permission: classification.permission,
      target: target ? `[${target.handle}] ${target.name}` : undefined,
      reason: classification.reason,
    };

    if (decision.effect === 'deny') {
      request.onBlocked(decision.reason);
      await recordAudit({ ...base, decision: 'blocked', decidedBy: 'policy', reason: decision.reason });
      // The real reason, not "the user denied this". A model told the user
      // refused will keep hunting for a route the user might accept; told the
      // site is off limits, it stops and says so.
      return { allowed: false, reason: decision.reason };
    }

    if (decision.effect === 'allow') {
      // Only unattended actions are charged — see RunBudget.spend.
      const affordable = budget.spend(call.name, host);
      if (!affordable.ok) {
        request.onBlocked(affordable.reason);
        await recordAudit({
          ...base,
          decision: 'blocked',
          decidedBy: 'policy',
          reason: affordable.reason,
        });
        return { allowed: false, reason: affordable.reason };
      }
      await recordAudit({ ...base, decision: 'auto-allowed', decidedBy: 'policy' });
      return true;
    }

    // Outline the real element while the question is on screen, so the user
    // approves what is actually there rather than a name in a prompt.
    const page = await ensurePage();
    const generation = executor.lastSnapshot?.generation;
    const handle = Number(call.args.handle);
    if (page.ok && generation !== undefined && Number.isInteger(handle)) {
      await sendToPage(page.tabId, { type: 'highlight', handle, generation });
    }

    let answer: ConfirmAnswer;
    try {
      answer = await confirm({
        tool: call.name,
        permission: classification.permission,
        target: describeTarget(call, target?.name),
        host,
        reason: classification.reason,
        mayAlwaysAllow: mayOfferAlwaysAllow(classification.permission, host),
      });
    } finally {
      if (page.ok) await sendToPage(page.tabId, { type: 'clearHighlight' });
    }

    if (answer === 'always') request.onTrustHost(host);
    const allowed = answer !== 'deny';
    await recordAudit({
      ...base,
      decision: allowed ? 'allowed' : 'denied',
      decidedBy: 'user',
    });
    return allowed;
  };

  return runAgent({
    provider,
    model: profile.agentModel ?? profile.model,
    task,
    history,
    workspaceName: site ? `the web page at ${site.host}` : 'the current web page',
    systemPrompt: BROWSER_AGENT_PROMPT,
    // Read-only mode does not merely refuse the mutating tools -- it does not
    // offer them, so the model spends no turns proposing what it cannot do.
    tools:
      mode === 'read-only'
        ? [...READ_ONLY_TOOLS, ...(useDebugger ? [SCREENSHOT] : [])]
        : [
            // Only when it can work: a content script cannot photograph its own
            // page, and a tool refused every time costs turns.
            ...(useDebugger ? [SCREENSHOT] : []),
            ...READ_ONLY_TOOLS,
            ...MUTATING_TOOLS,
            // Offered only when it can actually work. A tool the model is told
            // about and then refused every time is worse than no tool: it spends
            // turns proposing it and explaining the failure.
            ...(useDebugger && files.length > 0 ? [ATTACH_FILE] : []),
          ],
    nativeToolCalls: resolveCapabilities(profile).nativeToolCalls,
    execute: async (call) => {
      // `ask_user` is answered by the panel, not by the page, so it never
      // reaches the browser executor.
      if (call.name === 'ask_user') {
        const answer = await request.ask({
          question: String(call.args.question ?? ''),
          options: Array.isArray(call.args.options)
            ? call.args.options.map((option) => String(option))
            : undefined,
          blocksAction: askUserBlocksAction(call.args),
        });
        return {
          id: call.id,
          name: call.name,
          // Core's own wording for both cases, so "nobody answered" means the
          // same thing here as it does in the CLI -- notably that it is not
          // consent to anything.
          content: answer ? askUserAnswerMessage(answer) : ASK_USER_NO_ANSWER,
        };
      }
      return executor.execute(call);
    },
    requestPermission,
    events: {
      onText: (text) => events.onText(text),
      onTextDelta: (text) => events.onTextDelta(text),
      onTextEnd: () => events.onTextEnd(),
      onToolCall: (call) => events.onToolCall(call),
      onToolResult: (result) => events.onToolResult(result),
      onContextUsage: (used, window) => events.onContextUsage(used, window),
      onCompaction: (before, after) => events.onCompaction(before, after),
    },
    // An agent that clicked and then reported success without looking is the
    // failure M4 exists to prevent; `read_page` is marked `verifies`, so this
    // sends it back to check once before it may finish.
    requireVerificationBeforeFinish: true,
    // Now that `ask_user` exists, the step limit can ask instead of just
    // stopping — the run keeps its transcript, which a follow-up message would
    // not (core's own reasoning at the limit).
    askToContinueAtLimit: true,
    contextWindow: resolveContextWindow(profile),
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    signal,
  }).finally(() => {
    void pool.release();
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** What the user reads in the prompt. Built from our data, never the model's. */
function describeTarget(call: ToolCall, name?: string): string {
  if (call.name === 'navigate') return String(call.args.url ?? '');
  if (call.name === 'go_back') return 'the previous page';
  const label = name ? `"${name}"` : `handle [${call.args.handle}]`;
  if (call.name === 'type') return `${label} <- ${JSON.stringify(String(call.args.text ?? ''))}`;
  if (call.name === 'select') return `${label} -> ${JSON.stringify(String(call.args.option ?? ''))}`;
  return label;
}
