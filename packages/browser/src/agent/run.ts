import { runAgent, type AgentOutcome, type ToolCall, type ToolResult } from '@heapcode/core/agent';
import { createProvider, resolveContextWindow, resolveCapabilities } from '@heapcode/core/providers';
import type { ChatMessage } from '@heapcode/core/providers';
import { loadApiKey, type StoredProfile } from '../shared/settings.js';
import { BrowserToolExecutor } from './executor.js';
import { READ_ONLY_TOOLS } from './tools.js';
import { BROWSER_AGENT_PROMPT } from './prompt.js';
import { activeSite } from '../sidepanel/page.js';

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
}

export interface RunRequest {
  profile: StoredProfile;
  task: string;
  history: ChatMessage[];
  events: RunEvents;
  signal: AbortSignal;
}

export async function runBrowserAgent(request: RunRequest): Promise<AgentOutcome> {
  const { profile, task, history, events, signal } = request;

  const apiKey = await loadApiKey();
  const provider = createProvider(profile, apiKey);
  const executor = new BrowserToolExecutor(task);

  // The site the panel is pointed at stands in for heapcode's workspace name:
  // it is the thing the agent is working on, and naming it stops the model
  // asking which page the user means.
  const site = await activeSite();

  return runAgent({
    provider,
    model: profile.agentModel ?? profile.model,
    task,
    history,
    workspaceName: site ? `the web page at ${site.host}` : 'the current web page',
    systemPrompt: BROWSER_AGENT_PROMPT,
    tools: READ_ONLY_TOOLS,
    nativeToolCalls: resolveCapabilities(profile).nativeToolCalls,
    execute: (call) => executor.execute(call),
    // M2 is read-only, so nothing here can need a decision. Every tool is
    // `permission: 'read'` and the loop only asks for the others. M3 replaces
    // this with the real engine, and no mutating tool ships before it does
    // (PLAN guardrail 5).
    requestPermission: async () => true,
    events: {
      onText: (text) => events.onText(text),
      onTextDelta: (text) => events.onTextDelta(text),
      onTextEnd: () => events.onTextEnd(),
      onToolCall: (call) => events.onToolCall(call),
      onToolResult: (result) => events.onToolResult(result),
      onContextUsage: (used, window) => events.onContextUsage(used, window),
      onCompaction: (before, after) => events.onCompaction(before, after),
    },
    contextWindow: resolveContextWindow(profile),
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    signal,
  });
}
