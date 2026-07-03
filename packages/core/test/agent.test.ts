import { describe, expect, it } from 'vitest';
import { runAgent, type AgentOptions } from '../src/agent/loop.js';
import { parseToolBlocks } from '../src/agent/textProtocol.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../src/agent/tools.js';
import type { ChatRequest, ChatResponse, Provider } from '../src/providers/types.js';

const TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    permission: 'read',
  },
  {
    name: 'write_file',
    description: 'Write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    permission: 'write',
  },
];

/**
 * Provider fake returning scripted responses; records a deep snapshot of each
 * request (the loop mutates its messages array in place — a real provider
 * serializes at send time, so tests must too).
 */
function scriptedProvider(responses: ChatResponse[]): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(req: ChatRequest) {
      requests.push(structuredClone(req));
      const i = Math.min(requests.length - 1, responses.length - 1);
      return Promise.resolve(responses[i]!);
    },
    streamChat() {
      throw new Error('not used');
    },
    completion() {
      throw new Error('not used');
    },
    listModels: () => Promise.resolve([]),
  };
}

function harness(overrides: Partial<AgentOptions> = {}) {
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  const options = {
    model: 'test',
    task: 'do the thing',
    workspaceName: 'demo',
    tools: TOOLS,
    execute: (call: ToolCall) =>
      Promise.resolve({ id: call.id, name: call.name, content: `ok:${call.name}` }),
    requestPermission: () => Promise.resolve(true),
    events: {
      onText: (t: string) => texts.push(t),
      onToolCall: (c: ToolCall) => calls.push(c),
      onToolResult: (r: ToolResult) => results.push(r),
    },
    ...overrides,
  };
  return { texts, calls, results, options };
}

describe('runAgent — native tool calls', () => {
  it('executes tool calls, feeds results back, finishes on a plain reply', async () => {
    const provider = scriptedProvider([
      {
        content: 'Reading the file.',
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
      },
      { content: 'All done: added the endpoint.' },
    ]);
    const h = harness();
    const outcome = await runAgent({ ...h.options, provider, nativeToolCalls: true });

    expect(outcome).toBe('done');
    expect(h.calls.map((c) => c.name)).toEqual(['read_file']);
    expect(h.texts).toEqual(['Reading the file.', 'All done: added the endpoint.']);
    // Second request must contain the tool result message.
    const second = provider.requests[1]!;
    expect(second.messages.some((m) => m.role === 'tool' && m.content === 'ok:read_file')).toBe(true);
    expect(second.tools?.length).toBe(2);
  });

  it('reports permission denial to the model instead of failing', async () => {
    const provider = scriptedProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a', content: 'b' } }] },
      { content: 'Understood, finishing without writing.' },
    ]);
    const h = harness({ requestPermission: () => Promise.resolve(false) });
    const outcome = await runAgent({ ...h.options, provider, nativeToolCalls: true });

    expect(outcome).toBe('done');
    expect(h.results[0]!.isError).toBe(true);
    const toolMsg = provider.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg!.content).toContain('denied');
  });

  it('asks the model to fix invalid JSON arguments', async () => {
    const provider = scriptedProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', args: {}, argsParseError: 'bad json' }],
      },
      { content: 'done' },
    ]);
    const h = harness();
    await runAgent({ ...h.options, provider, nativeToolCalls: true });
    const toolMsg = provider.requests[1]!.messages.find((m) => m.role === 'tool');
    expect(toolMsg!.content).toContain('Invalid JSON');
  });

  it('stops at maxIterations', async () => {
    const provider = scriptedProvider([
      { content: '', toolCalls: [{ id: 'c', name: 'read_file', args: {} }] },
    ]);
    const h = harness();
    const outcome = await runAgent({
      ...h.options,
      provider,
      nativeToolCalls: true,
      maxIterations: 3,
    });
    expect(outcome).toBe('max-iterations');
    expect(h.calls.length).toBe(3);
  });
});

describe('runAgent — structured-text fallback', () => {
  it('parses a tool block, executes, and finishes on a block-free reply', async () => {
    const provider = scriptedProvider([
      { content: 'Let me read it.\n<tool name="read_file">\n{"path": "a.ts"}\n</tool>' },
      { content: 'Finished the task.' },
    ]);
    const h = harness();
    const outcome = await runAgent({ ...h.options, provider, nativeToolCalls: false });

    expect(outcome).toBe('done');
    expect(h.calls.map((c) => c.name)).toEqual(['read_file']);
    expect(h.texts).toEqual(['Let me read it.', 'Finished the task.']);
    const second = provider.requests[1]!;
    const resultMsg = second.messages[second.messages.length - 1]!;
    expect(resultMsg.role).toBe('user');
    expect(resultMsg.content).toContain('<tool_result name="read_file">');
    expect(resultMsg.content).toContain('ok:read_file');
    // Fallback mode must not advertise native tools.
    expect(second.tools).toBeUndefined();
  });

  it('re-prompts to repair malformed JSON, then succeeds', async () => {
    const provider = scriptedProvider([
      { content: '<tool name="read_file">\n{"path": broken}\n</tool>' },
      { content: '<tool name="read_file">\n{"path": "a.ts"}\n</tool>' },
      { content: 'done' },
    ]);
    const h = harness();
    const outcome = await runAgent({ ...h.options, provider, nativeToolCalls: false });

    expect(outcome).toBe('done');
    expect(h.calls.length).toBe(1);
    const repairMsg = provider.requests[1]!.messages[provider.requests[1]!.messages.length - 1]!;
    expect(repairMsg.content).toContain('invalid');
  });
});

describe('parseToolBlocks', () => {
  it('extracts name, args, and narration', () => {
    const out = parseToolBlocks('thinking…\n<tool name="search">\n{"pattern": "foo"}\n</tool>');
    expect(out.calls).toEqual([{ name: 'search', args: { pattern: 'foo' } }]);
    expect(out.narration).toBe('thinking…');
  });

  it('tolerates fenced JSON inside the block', () => {
    const out = parseToolBlocks('<tool name="x">\n```json\n{"a": 1}\n```\n</tool>');
    expect(out.calls[0]!.args).toEqual({ a: 1 });
  });

  it('flags tool intent when a block is mangled beyond parsing', () => {
    const out = parseToolBlocks('<tool name="x"\n{"a": 1}');
    expect(out.calls.length).toBe(0);
    expect(out.hasToolIntent).toBe(true);
  });

  it('reports JSON errors per call', () => {
    const out = parseToolBlocks('<tool name="x">\nnot json\n</tool>');
    expect(out.calls[0]!.parseError).toBeDefined();
  });
});
