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
import { availableLabels, loadProfileEnabled, loadUserProfile } from '../shared/profile.js';
import { DriverPool } from './driverPool.js';
import { BrowserToolExecutor } from './executor.js';
import { READ_ONLY_TOOLS, SCREENSHOT } from './tools.js';
import { BROWSER_AGENT_PROMPT } from './prompt.js';
import {
  activeSite,
  sendToPage,
  ensurePage,
  ensureTab,
  type GrantNeeded,
} from '../sidepanel/page.js';
import { decide, mayOfferAlwaysAllow, type BrowserMode } from './originPolicy.js';
import { recordAudit } from './audit.js';
import { ATTACH_FILE, AUTOFILL_FORM, DRAG, MUTATING_TOOLS } from './actions.js';
import { RunBudget } from './limits.js';
import type { Dataset } from '../shared/dataset.js';
import { toolLabel } from '../shared/toolLabels.js';

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
  /**
   * Thinking, kept apart from what the model is saying to the user.
   *
   * Reasoning models produce a great deal of it, and rendered as narration it
   * reads as the assistant talking to itself in the transcript. Core already
   * separates it when the endpoint puts it in its own field; models that inline
   * it as `<think>` tags are split in the panel.
   */
  onReasoningDelta(text: string): void;
  onReasoningEnd(): void;
  onToolCall(call: ToolCall): void;
  onToolResult(result: ToolResult): void;
  onContextUsage(used: number, window: number): void;
  onCompaction(before: number, after: number): void;
  /** A picture of what the agent is looking at. For the panel only. */
  onView(dataUrl: string): void;
  /**
   * Rows the agent has collected so far. For the panel only.
   *
   * Deliberately not sent back to the model, which already knows what it
   * extracted and does not need fifty rows re-read to it on every turn — that
   * is the cost this whole mechanism exists to avoid.
   */
  onData(dataset: Dataset): void;
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
   * Ask for a host the run cannot reach. Resolves when the user answers.
   *
   * Blocking, like `confirm`. The agent's only other recourse is to say
   * "blocked, please go and grant it" -- a dead end printed into a transcript
   * that will still be showing it after the user has, and by then the run has
   * given up and written a conclusion around the thing it could not read.
   */
  requestGrant(needed: GrantNeeded): Promise<boolean>;
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

  // Named, not implied. The run holds the profile it was started with, and
  // asking for "the active profile's key" would fetch a different one if the
  // user switched profiles while a run was in flight.
  const apiKey = await loadApiKey(profile.name);
  const provider = createProvider(profile, apiKey);

  const [useDebugger, files, profileEnabled, savedProfile] = await Promise.all([
    loadUseDebugger(),
    loadFiles(),
    loadProfileEnabled(),
    loadUserProfile(),
  ]);
  // Switched off means the run does not receive them at all, rather than
  // receiving them and being asked not to use them.
  const userProfile = profileEnabled ? savedProfile : {};
  const pool = new DriverPool(
    useDebugger,
    (reason) => request.onBlocked(reason),
    (needed) => request.requestGrant(needed),
  );
  const executor = new BrowserToolExecutor(task, {
    pool,
    files,
    profile: userProfile,
    onView: (dataUrl) => events.onView(dataUrl),
    onData: (dataset) => events.onData(dataset),
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
    const { classification, target, url, describe } = await executor.classify(call);
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
    // approves what is actually there rather than a name in a prompt. In the
    // tab the run is working in, which is not necessarily the one in front.
    const page = pool.target !== undefined ? await ensureTab(pool.target) : await ensurePage();
    const generation = executor.lastSnapshot?.generation;
    const handle = Number(call.args.handle);
    const asked = describe ?? describeTarget(call, target?.name);
    if (page.ok && generation !== undefined && Number.isInteger(handle)) {
      // The label is drawn beside the ring, so the description in the panel and
      // the thing on the page can be checked against each other without the
      // user's eyes leaving the element.
      await sendToPage(page.tabId, {
        type: 'highlight',
        handle,
        generation,
        label: `${call.name} — ${asked}`.replace(/\s+/g, ' ').slice(0, 120),
      });
    }

    pool.note('Waiting for you', asked);

    let answer: ConfirmAnswer;
    try {
      answer = await confirm({
        tool: call.name,
        permission: classification.permission,
        // The executor's own description when it has one: some calls decide
        // what they will do rather than carrying it in their arguments.
        target: asked,
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
    systemPrompt: `${BROWSER_AGENT_PROMPT}${savedDetails(availableLabels(userProfile))}`,
    // Read-only mode does not merely refuse the mutating tools -- it does not
    // offer them, so the model spends no turns proposing what it cannot do.
    tools:
      mode === 'read-only'
        ? [...READ_ONLY_TOOLS, SCREENSHOT]
        : [
            // Offered on both paths now. The debugger captures any tab it is
            // attached to; without it Chrome will only photograph the tab in
            // front, and the tool says so rather than returning the wrong page.
            SCREENSHOT,
            ...READ_ONLY_TOOLS,
            ...MUTATING_TOOLS,
            // Offered only when it can actually work. A tool the model is told
            // about and then refused every time is worse than no tool: it spends
            // turns proposing it and explaining the failure. A synthesized drag
            // is ignored by every implementation worth dragging in, so it is in
            // the same position as file attachment: real with the debugger, and
            // absent without it.
            ...(useDebugger ? [DRAG] : []),
            // Offered only when there is something to fill from. A tool that
            // always answers "nothing is saved" costs a turn to discover that.
            ...(Object.keys(userProfile).length > 0 ? [AUTOFILL_FORM] : []),
            ...(useDebugger && files.length > 0 ? [ATTACH_FILE] : []),
          ],
    nativeToolCalls: resolveCapabilities(profile).nativeToolCalls,
    execute: async (call) => {
      // The bar heapbrowse draws along the bottom of the page it is driving.
      // Named from the same table the transcript uses, in the present tense:
      // this one is reporting what is happening, not what happened.
      pool.note(toolLabel(call.name).present, activityDetail(call));

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
      onReasoningDelta: (text) => events.onReasoningDelta(text),
      onReasoningEnd: () => events.onReasoningEnd(),
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

/**
 * What the model is told about the user's saved details.
 *
 * The names, never the values. It plans with "there is an email address on
 * file" and refers to it by name; the substitution happens in the executor
 * after the user has approved the call. A page that talks the model into
 * repeating the user's address cannot succeed, because the model does not have
 * it to repeat.
 *
 * In the prompt rather than behind a tool so it costs no round trip, and
 * because a list of field names is small and static for the whole run.
 */
function savedDetails(labels: string[]): string {
  if (labels.length === 0) return '';
  return `\n\nTHE USER'S SAVED DETAILS
The user has saved these details for filling in forms: ${labels.join(', ')}.

You cannot see their values and never will. To use one, call autofill_form -- which matches the page's fields to them for you -- or name it in a fill_form field's "detail" argument. The value is filled in locally after the user approves the action.

Do not ask the user for anything in that list; it is already known. Do ask about anything that is not, rather than guessing.`;
}

/**
 * The second line on the page's own bar: which thing, in the user's terms.
 *
 * Deliberately short and deliberately not the model's own description. It is
 * rendered on a page the model can read, so it must not become a channel for
 * the model to write text of its choosing onto that page -- these come from the
 * call's arguments, truncated, and nothing else.
 */
function activityDetail(call: ToolCall): string {
  const cut = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);
  const text = (key: string): string | undefined =>
    typeof call.args[key] === 'string' && call.args[key] ? (call.args[key] as string) : undefined;

  if (call.name === 'navigate' || call.name === 'open_tab') {
    const url = text('url');
    if (!url) return '';
    try {
      return new URL(url).host;
    } catch {
      return cut(url);
    }
  }
  if (call.name === 'type') return cut(text('text') ?? '');
  if (call.name === 'select') return cut(text('option') ?? '');
  if (call.name === 'get_elements') return cut(text('filter') ?? text('role') ?? '');
  if (call.name === 'fill_form') {
    const count = Array.isArray(call.args.fields) ? call.args.fields.length : 0;
    return count ? `${count} field${count === 1 ? '' : 's'}` : '';
  }
  if (call.name === 'scroll') return cut(text('direction') ?? '');
  return '';
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
  if (call.name === 'open_tab') return `${String(call.args.url ?? '')} (in a new tab)`;
  if (call.name === 'close_tab') return `tab ${String(call.args.tab ?? '')}`;
  if (call.name === 'go_back') return 'the previous page';

  if (call.name === 'fill_form') {
    const fields = Array.isArray(call.args.fields) ? call.args.fields : [];
    // Every field, not a count. The user is approving one action that touches
    // several places, and "5 fields" is not something anyone can check.
    const lines = fields.map((entry) => {
      const field = entry as { handle?: unknown; value?: unknown };
      return `  [${String(field.handle)}] <- ${JSON.stringify(String(field.value ?? ''))}`;
    });
    return `${fields.length} field(s):\n${lines.join('\n')}`;
  }

  const label = name ? `"${name}"` : `handle [${call.args.handle}]`;
  if (call.name === 'type') return `${label} <- ${JSON.stringify(String(call.args.text ?? ''))}`;
  if (call.name === 'select') return `${label} -> ${JSON.stringify(String(call.args.option ?? ''))}`;
  if (call.name === 'press_key') {
    const key = String(call.args.key ?? '');
    return call.args.handle === undefined ? `press ${key}` : `press ${key} in ${label}`;
  }
  if (call.name === 'drag') return `drag [${String(call.args.from)}] onto [${String(call.args.to)}]`;
  return label;
}
