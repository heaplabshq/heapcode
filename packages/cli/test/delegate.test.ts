import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatResponse, Provider, ProviderProfileConfig, ToolCall, ToolDefinition } from '@heapcode/core';
import { WorkspaceToolExecutor, agentToolDefinitions } from '../src/agent/workspaceTools.js';
import { SessionCheckpoint } from '../src/agent/checkpoint.js';
import { PermissionEngine } from '../src/agent/permissions.js';
import { getPersona } from '../src/agent/personas.js';
import { DELEGATE_TASK_TOOL, runSubAgent } from '../src/agent/delegate.js';

/** Serves responses[i] for the i-th request (last one repeats) — same shape core's own agent.test.ts uses. */
function scriptedProvider(responses: ChatResponse[]): Provider & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    chat: (req) => {
      requests.push(req);
      return Promise.resolve(responses[Math.min(requests.length - 1, responses.length - 1)]!);
    },
    streamChat: () => {
      throw new Error('not used');
    },
    completion: () => Promise.reject(new Error('not used')),
    embeddings: () => Promise.reject(new Error('not used')),
    listModels: () => Promise.resolve([]),
  };
}

const profile: ProviderProfileConfig = { name: 'test', preset: 'custom', baseUrl: 'http://x', model: 'mock' };

let root: string;
let executor: WorkspaceToolExecutor;
let permissions: PermissionEngine;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-delegate-'));
  const checkpoint = new SessionCheckpoint(root);
  executor = new WorkspaceToolExecutor(root, checkpoint, 5_000);
  permissions = new PermissionEngine(join(root, 'permissions.json'));
  permissions.attachRequester(() => Promise.resolve('allow'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function baseCtx(overrides: Partial<Parameters<typeof runSubAgent>[1]> = {}) {
  return {
    executor,
    provider: scriptedProvider([{ content: 'nothing to do here' }]),
    profile,
    nativeToolCalls: false,
    contextWindow: 32_768,
    tools: agentToolDefinitions,
    persona: getPersona(undefined),
    permissions,
    workspaceName: 'test',
    ...overrides,
  };
}

describe('DELEGATE_TASK_TOOL', () => {
  it('is declared execute-permission, not offered by default (App.tsx gates it behind subAgentsEnabled)', () => {
    expect(DELEGATE_TASK_TOOL.name).toBe('delegate_task');
    expect(DELEGATE_TASK_TOOL.permission).toBe('execute');
    expect(agentToolDefinitions.some((t) => t.name === 'delegate_task')).toBe(false);
  });
});

describe('runSubAgent', () => {
  it('rejects a call with no task argument', async () => {
    const result = await runSubAgent({ id: 'c1', name: 'delegate_task', args: {} }, baseCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Missing "task"');
  });

  it('runs the sub-agent to completion and reports outcome + tool log + summary', async () => {
    const provider = scriptedProvider([
      { content: '<tool name="write_file">\n{"path": "notes.txt", "content": "sub-agent was here"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "Wrote the notes file."}\n</tool>' },
    ]);
    const call: ToolCall = { id: 'c1', name: 'delegate_task', args: { task: 'write a notes file' } };
    const result = await runSubAgent(call, baseCtx({ provider }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('outcome: done');
    expect(result.content).toContain('1 tool call(s)');
    expect(result.content).toContain('Wrote the notes file.');
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('sub-agent was here');
  });

  it("never offers delegate_task to its own sub-agent — one level of nesting only", async () => {
    // ctx.tools is agentToolDefinitions, which never includes delegate_task
    // (see the sibling describe block) — so the sub-agent's own system
    // prompt can't declare a tool it was never given.
    const provider = scriptedProvider([{ content: '<tool name="finish">\n{"summary": "done"}\n</tool>' }]);
    await runSubAgent({ id: 'c1', name: 'delegate_task', args: { task: 'x' } }, baseCtx({ provider }));
    const sentPrompt = (provider.requests[0] as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(sentPrompt).not.toContain('delegate_task');
  });

  it("intersects the requested persona with the parent's — never more permissive than the parent", async () => {
    const provider = scriptedProvider([{ content: '<tool name="finish">\n{"summary": "investigated"}\n</tool>' }]);
    const call: ToolCall = { id: 'c1', name: 'delegate_task', args: { task: 'investigate', persona: 'agent' } };
    // Parent is Architect (read-only) — a sub-agent asking for the unrestricted "agent" persona must still be read-only.
    const result = await runSubAgent(call, baseCtx({ provider, persona: getPersona('architect') }));
    expect(result.isError).toBeFalsy();
    const messages = (provider.requests[0] as { messages: Array<{ content: string }> }).messages;
    const systemPrompt = messages[0]!.content;
    const taskMessage = messages[1]!.content;
    expect(taskMessage).toContain('Architect persona');
    expect(systemPrompt).not.toContain('### write_file'); // write tools never reached the sub-agent's own tool list
  });

  it('tells the sub-agent to stay within the task\'s scope — a live incident had one edit an unrelated file once it ran out of real work', async () => {
    const provider = scriptedProvider([{ content: '<tool name="finish">\n{"summary": "done"}\n</tool>' }]);
    const call: ToolCall = { id: 'c1', name: 'delegate_task', args: { task: 'check lib/target.js for bugs' } };
    await runSubAgent(call, baseCtx({ provider }));
    const taskMessage = (provider.requests[0] as { messages: Array<{ content: string }> }).messages[1]!.content;
    expect(taskMessage).toContain('Stay strictly within its scope');
    expect(taskMessage).toContain('check lib/target.js for bugs');
  });

  it('a write-restricted persona blocks filesystem-mutating run_command the same way the parent would', async () => {
    const runTool: ToolDefinition = { name: 'run_command', description: '', parameters: { type: 'object', properties: {} }, permission: 'execute' };
    const provider = scriptedProvider([
      { content: '<tool name="run_command">\n{"command": "rm -rf build"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "blocked"}\n</tool>' },
    ]);
    const call: ToolCall = { id: 'c1', name: 'delegate_task', args: { task: 'clean up', persona: 'debug' } };
    const result = await runSubAgent(call, baseCtx({ provider, tools: [runTool], persona: getPersona('debug') }));
    expect(result.isError).toBeFalsy();
    // The blocked-tool-result text is fed back to the sub-agent as a tool message,
    // not surfaced in runSubAgent's own returned content (which only logs the
    // call description, same as the extension's own toolLog) — verify it reached
    // the model, which is what actually stopped it from retrying the command.
    const secondTurn = (provider.requests[1] as { messages: Array<{ content: string }> }).messages;
    expect(secondTurn.some((m) => m.content.includes('Debug persona does not allow'))).toBe(true);
  });

  it('reports isError for an unresolvable ("no model") profile switch request', async () => {
    const provider = scriptedProvider([{ content: 'unused' }]);
    const noModelProfile: ProviderProfileConfig = { name: 'blank', preset: 'custom', baseUrl: 'http://x', model: '' };
    const call: ToolCall = { id: 'c1', name: 'delegate_task', args: { task: 'x', profile: 'blank' } };
    const result = await runSubAgent(
      call,
      baseCtx({
        provider,
        resolveProfile: async (name) => (name === 'blank' ? { provider, profile: noModelProfile } : undefined),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no model configured');
  });

  it('an unknown profile name falls back to the parent\'s own profile rather than failing', async () => {
    const provider = scriptedProvider([{ content: '<tool name="finish">\n{"summary": "done on the fallback profile"}\n</tool>' }]);
    const call: ToolCall = { id: 'c1', name: 'delegate_task', args: { task: 'x', profile: 'does-not-exist' } };
    const result = await runSubAgent(call, baseCtx({ provider, resolveProfile: async () => undefined }));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('done on the fallback profile');
  });

  it('surfaces sub-agent tool calls via the onSubToolCall/onSubToolResult events, for live indented rendering', async () => {
    const provider = scriptedProvider([
      { content: '<tool name="write_file">\n{"path": "a.txt", "content": "x"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "done"}\n</tool>' },
    ]);
    const calls: string[] = [];
    const results: string[] = [];
    const call: ToolCall = { id: 'c1', name: 'delegate_task', args: { task: 'write a.txt' } };
    await runSubAgent(
      call,
      baseCtx({
        provider,
        events: {
          onSubToolCall: (c) => calls.push(c.name),
          onSubToolResult: (r) => results.push(r.name),
        },
      }),
    );
    expect(calls).toEqual(['write_file']);
    expect(results).toEqual(['write_file']);
  });

  it("an ask_user call from the sub-agent is answered automatically — sub-agents can't prompt the user", async () => {
    const askTool: ToolDefinition = { name: 'ask_user', description: '', parameters: { type: 'object', properties: {} }, permission: 'read' };
    const provider = scriptedProvider([
      { content: '<tool name="ask_user">\n{"question": "which approach?"}\n</tool>' },
      { content: '<tool name="finish">\n{"summary": "proceeded without asking"}\n</tool>' },
    ]);
    const call: ToolCall = { id: 'c1', name: 'delegate_task', args: { task: 'x' } };
    const result = await runSubAgent(call, baseCtx({ provider, tools: [askTool] }));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('proceeded without asking');
  });
});
