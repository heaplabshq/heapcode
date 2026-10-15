import { describe, expect, it } from 'vitest';
import { runAgent, type AgentOptions } from '../src/agent/loop.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../src/agent/tools.js';
import type { ChatRequest, ChatResponse, Provider } from '../src/providers/types.js';

/**
 * A model stuck on an edit: the same failing call, again and again. Reported
 * from a real run — thirty `edit_file src/data/mock-data.ts` in a row,
 * seven minutes in, going nowhere.
 */
const TOOLS: ToolDefinition[] = [
  { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } }, permission: 'read' },
  { name: 'edit_file', description: 'Edit', parameters: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' } } }, permission: 'write' },
  { name: 'run_command', description: 'Run', parameters: { type: 'object', properties: { command: { type: 'string' } } }, permission: 'execute' },
];

function scripted(calls: Array<{ name: string; args: Record<string, unknown> }>): Provider {
  let i = 0;
  return {
    chat(_req: ChatRequest): Promise<ChatResponse> {
      const next = calls[i++];
      if (!next) return Promise.resolve({ content: 'Task is complete: done.' });
      return Promise.resolve({ content: '', toolCalls: [{ id: `c${i}`, name: next.name, args: next.args }] });
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
  } as Provider;
}

function harness(provider: Provider, execute: (call: ToolCall) => ToolResult, permission: AgentOptions['requestPermission'] = () => Promise.resolve(true)) {
  const ran: ToolCall[] = [];
  const results: ToolResult[] = [];
  const texts: string[] = [];
  const options: AgentOptions = {
    provider,
    model: 'test',
    task: 'fix the mock data',
    workspaceName: 'demo',
    tools: TOOLS,
    nativeToolCalls: true,
    maxIterations: 60,
    execute: (call) => {
      ran.push(call);
      return Promise.resolve(execute(call));
    },
    requestPermission: permission,
    events: { onText: (t) => texts.push(t), onToolCall: () => {}, onToolResult: (r) => results.push(r) },
  };
  return { ran, results, texts, options };
}

const edit = (search: string) => ({ name: 'edit_file', args: { path: 'src/data/mock-data.ts', search } });
const notFound = (call: ToolCall): ToolResult => ({ id: call.id, name: call.name, content: 'The "search" text was not found in src/data/mock-data.ts.', isError: true });

describe('the agent loop, when tool calls get nowhere', () => {
  it('does not send an edit again that already failed, while nothing has changed', async () => {
    const h = harness(scripted([edit('A'), edit('A'), edit('A')]), notFound);
    await runAgent(h.options);
    expect(h.ran.filter((c) => c.name === 'edit_file')).toHaveLength(1);
    expect(h.results[1]!.content).toMatch(/already made this exact call and it failed/);
    expect(h.results[1]!.content).toContain('was not found');
  });

  it('does send it again once something has changed', async () => {
    let tries = 0;
    const h = harness(scripted([edit('A'), edit('B'), edit('A')]), (call) =>
      call.args.search === 'A' && tries++ === 0 ? notFound(call) : { id: call.id, name: call.name, content: 'Edited.' },
    );
    await runAgent(h.options);
    expect(h.ran.filter((c) => c.args.search === 'A')).toHaveLength(2);
  });

  it('tells the model at five failures in a row and ends the run at ten', async () => {
    const h = harness(scripted(Array.from({ length: 20 }, (_, i) => edit(`attempt ${i}`))), notFound);
    const outcome = await runAgent(h.options);
    expect(outcome).toBe('error');
    expect(h.ran).toHaveLength(10);
    expect(h.results[4]!.content).toMatch(/5 calls in a row that failed or changed nothing/);
    expect(h.texts.at(-1)).toMatch(/10 tool calls in a row failed or changed nothing/);
  });

  it('counts reading between failed edits as no progress — that is the circle', async () => {
    const calls = Array.from({ length: 12 }, (_, i) => [{ name: 'read_file', args: { path: `f${i}` } }, edit(`try ${i}`)]).flat();
    const h = harness(scripted(calls), (call) => (call.name === 'read_file' ? { id: call.id, name: call.name, content: 'text' } : notFound(call)));
    expect(await runAgent(h.options)).toBe('error');
  });

  it('never stops a run that keeps making real changes, however many', async () => {
    const h = harness(scripted(Array.from({ length: 30 }, (_, i) => edit(`entry ${i}`))), (call) => ({ id: call.id, name: call.name, content: 'Edited.' }));
    expect(await runAgent(h.options)).toBe('done');
    expect(h.ran).toHaveLength(30);
  });

  it('lets a failed command be tried again — it may depend on the world, not the files', async () => {
    const run = { name: 'run_command', args: { command: 'curl localhost:3000' } };
    let n = 0;
    const h = harness(scripted([run, run, run]), (call) => (n++ < 2 ? { id: call.id, name: call.name, content: 'refused', isError: true } : { id: call.id, name: call.name, content: 'ok' }));
    await runAgent(h.options);
    expect(h.ran).toHaveLength(3);
  });

  it('does not count what the person refused', async () => {
    const h = harness(scripted(Array.from({ length: 12 }, (_, i) => edit(`x ${i}`))), notFound, () => Promise.resolve(false));
    expect(await runAgent(h.options)).not.toBe('error');
  });
});
