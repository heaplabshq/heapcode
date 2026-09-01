import { describe, expect, it } from 'vitest';
import { runAgent, type AgentOptions } from '../src/agent/loop.js';
import { MAX_TODOS, parseTodos, renderTodos, type TodoItem } from '../src/agent/todo.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../src/agent/tools.js';
import type { ChatRequest, ChatResponse, Provider } from '../src/providers/types.js';

/**
 * The agent's own task list: what survives a malformed call, what the loop
 * does with a well-formed one, and what "finish" owes the list.
 */
describe('parseTodos', () => {
  it('takes a well-formed list', () => {
    const parsed = parseTodos({
      todos: [
        { content: 'fix parser', status: 'in_progress' },
        { content: 'add test', status: 'pending' },
      ],
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.todos).toEqual([
      { content: 'fix parser', status: 'in_progress' },
      { content: 'add test', status: 'pending' },
    ]);
  });

  it('repairs the shapes local models actually emit', () => {
    // A bare array, string entries, "done" for completed — all seen live from
    // text-protocol models on other tools; rejecting over them costs a turn.
    const parsed = parseTodos({ todos: ['plain step', { content: 'typed step', status: 'done' }] });
    expect(parsed.todos).toEqual([
      { content: 'plain step', status: 'pending' },
      { content: 'typed step', status: 'completed' },
    ]);
  });

  it('rejects a missing or empty list rather than inventing one', () => {
    expect(parseTodos({}).error).toBeTruthy();
    expect(parseTodos({ todos: [] }).error).toBeTruthy();
    expect(parseTodos({ todos: [{ content: '', status: 'pending' }] }).error).toBeTruthy();
  });

  it('caps the list at a length nobody can be following anyway', () => {
    const many = Array.from({ length: MAX_TODOS + 5 }, (_, i) => ({ content: `s${i}`, status: 'pending' }));
    expect(parseTodos({ todos: many }).error).toMatch(/longer than/);
  });
});

describe('renderTodos', () => {
  it('shows the list and the count that remains', () => {
    const todos: TodoItem[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ];
    const out = renderTodos(todos);
    expect(out).toContain('1 of 2 done');
    expect(out).toContain('1. [x] a');
    expect(out).toContain('b (in progress)');
  });
});

/** Same scripted-provider pattern as agent.test.ts. */
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
    embeddings() {
      throw new Error('not used');
    },
    listModels: () => Promise.resolve([]),
  };
}

function harness(overrides: Partial<AgentOptions> = {}) {
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  const todoUpdates: TodoItem[][] = [];
  const options = {
    model: 'test',
    task: 'do the thing',
    workspaceName: 'demo',
    tools: [
      { name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, permission: 'read' },
    ] as ToolDefinition[],
    execute: (call: ToolCall) => Promise.resolve({ id: call.id, name: call.name, content: `ok:${call.name}` }),
    requestPermission: () => Promise.resolve(true),
    events: {
      onText: (t: string) => texts.push(t),
      onToolCall: (c: ToolCall) => calls.push(c),
      onToolResult: (r: ToolResult) => results.push(r),
      onTodoUpdate: (todos: TodoItem[]) => todoUpdates.push(structuredClone(todos)),
    },
    ...overrides,
  };
  return { texts, calls, results, todoUpdates, options };
}

describe('todo_write in the loop', () => {
  it('is loop-owned: updates state, fires onTodoUpdate, never reaches the host executor', async () => {
    const provider = scriptedProvider([
      {
        content: 'Planning.',
        toolCalls: [{ id: 'c1', name: 'todo_write', args: { todos: [{ content: 'step', status: 'pending' }] } }],
      },
      { content: '', toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'Did step.' } }] },
    ]);
    let hostSawTodo = false;
    const h = harness({
      execute: (call) => {
        if (call.name === 'todo_write') hostSawTodo = true;
        return Promise.resolve({ id: call.id, name: call.name, content: 'ok' });
      },
    });
    await runAgent({ ...h.options, provider, nativeToolCalls: true });

    expect(hostSawTodo).toBe(false);
    expect(h.todoUpdates).toEqual([[{ content: 'step', status: 'pending' }]]);
    expect(h.results[0]!.content).toContain('0 of 1 done');
  });

  it('defers a finish that leaves its own list pending, exactly twice', async () => {
    const provider = scriptedProvider([
      {
        content: 'Planning.',
        toolCalls: [{ id: 'c1', name: 'todo_write', args: { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] } }],
      },
      { content: 'Halfway done.', toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'Done a.' } }] },
      { content: 'Still done.', toolCalls: [{ id: 'c3', name: 'finish', args: { summary: 'Really done.' } }] },
      { content: 'Fine.', toolCalls: [{ id: 'c4', name: 'finish', args: { summary: 'Fine, done.' } }] },
    ]);
    const h = harness();
    const outcome = await runAgent({ ...h.options, provider, nativeToolCalls: true });

    // Two deferrals, then the third finish is honored — the model has said
    // done over its own list three times, and holding the door forever is
    // its own failure mode.
    expect(outcome).toBe('done');
    const nudges = provider.requests.filter((r) =>
      r.messages.some((m) => typeof m.content === 'string' && m.content.includes('still has 1 unfinished')),
    );
    expect(nudges.length).toBe(2);
    expect(nudges[0]!.messages.some((m) => typeof m.content === 'string' && /^- a$/m.test(m.content))).toBe(true);
  });

  it('lets a finish through when the list is complete or there is none', async () => {
    const provider = scriptedProvider([
      {
        content: 'Planning.',
        toolCalls: [
          { id: 'c1', name: 'todo_write', args: { todos: [{ content: 'a', status: 'completed' }] } },
        ],
      },
      { content: 'All done.', toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'Done.' } }] },
    ]);
    const h = harness();
    const outcome = await runAgent({ ...h.options, provider, nativeToolCalls: true });
    expect(outcome).toBe('done');
    // Two model calls only — no deferral nudge was injected.
    expect(provider.requests.length).toBe(2);
  });

  it('answers a malformed call with an error, not a dead turn', async () => {
    const provider = scriptedProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'todo_write', args: { todos: [] } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'Done.' } }] },
    ]);
    const h = harness();
    await runAgent({ ...h.options, provider, nativeToolCalls: true });
    expect(h.results[0]!.isError).toBe(true);
    expect(h.todoUpdates).toEqual([]);
  });
});