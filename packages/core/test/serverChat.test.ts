import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from './mockServer.js';
import {
  HeapcodeServer,
  METHODS,
  PROTOCOL_VERSION,
  RpcPeer,
  type AgentEvent,
  type AgentEventParams,
  type ChatSendParams,
  type ChatSendResult,
  type HelloParams,
  type ListModelsResult,
  type ProviderProfileConfig,
  type ToolDefinition,
  type ToolExecuteParams,
  type ToolResult,
} from '../src/index.js';

/**
 * chat/send and provider/listModels over a real unix socket — no mocked
 * transport. The provider endpoint is a local HTTP fake, so the only thing
 * these don't exercise is a real model.
 */

let home: string;
let server: HeapcodeServer;
let mock: MockServer | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heapcode-chat-'));
});

afterEach(async () => {
  await server?.close();
  await mock?.close();
  mock = undefined;
  await rm(home, { recursive: true, force: true });
});

function profile(baseUrl: string): ProviderProfileConfig {
  return { name: 'p', preset: 'custom', baseUrl, model: 'm' };
}

async function startServer(): Promise<void> {
  server = new HeapcodeServer({ home, address: join(home, 'test.sock'), idleShutdownMs: 0 });
  await server.listen();
}

async function connectClient(profiles: ProviderProfileConfig[]): Promise<RpcPeer> {
  const socket = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const s = connect(server.address);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(socket, 'c');
  await peer.request(METHODS.hello, {
    token: server.token,
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    root: home,
    profiles,
    activeProfile: 'p',
    keys: { p: 'sk-test' },
  } satisfies HelloParams);
  return peer;
}

/** Collects the agent/event stream and any server→host requests. */
function record(peer: RpcPeer): {
  events: AgentEvent[];
  toolCalls: ToolExecuteParams[];
  sawPermissionRequest: boolean;
} {
  const events: AgentEvent[] = [];
  const toolCalls: ToolExecuteParams[] = [];
  const state = { events, toolCalls, sawPermissionRequest: false };

  peer.onNotification(METHODS.agentEvent, (raw) => {
    events.push((raw as AgentEventParams).event);
  });
  peer.onRequest(METHODS.toolExecute, async (raw) => {
    const params = raw as ToolExecuteParams;
    toolCalls.push(params);
    return {
      id: params.call.id,
      name: params.call.name,
      content: `ran ${params.call.name}`,
    } satisfies ToolResult;
  });
  // Registered so a stray prompt would be observable rather than a silent
  // methodNotFound — the point is proving it never fires.
  peer.onRequest(METHODS.permissionRequest, async () => {
    state.sawPermissionRequest = true;
    return { granted: true };
  });
  return state;
}

const READ_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  permission: 'read',
};

function toolCallResponse(): { kind: 'json'; status: number; body: unknown } {
  return {
    kind: 'json',
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  };
}

describe('chat/send over the socket', () => {
  it('streams a plain reply back as agent/event deltas and returns its finishReason', async () => {
    mock = await startMockServer({ kind: 'sse', chunks: ['Hello', ' there'] });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);
    const seen = record(peer);

    const result = await peer.request<ChatSendResult>(METHODS.chatSend, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      runId: 'r1',
    } satisfies ChatSendParams);

    const text = seen.events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello there');
    expect(result.finishReason).toBeUndefined();
    // No tools offered → the loop never opened a tool channel.
    expect(seen.toolCalls).toHaveLength(0);
    peer.close();
  });

  it('runs the ask loop: tool calls go back over tool/execute, and the final pass answers in prose', async () => {
    mock = await startMockServer({
      kind: 'sequence',
      responses: [
        toolCallResponse(),
        { kind: 'sse', chunks: ['Based on a.ts, ', 'yes.'] },
      ],
    });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);
    const seen = record(peer);

    const result = await peer.request<ChatSendResult>(METHODS.chatSend, {
      model: 'm',
      messages: [{ role: 'user', content: 'what does a.ts do?' }],
      maxTokens: 100,
      tools: [READ_TOOL],
      // Iteration 0 offers tools; iteration 1 is the forced tools-off pass.
      maxToolIterations: 2,
      runId: 'r1',
    } satisfies ChatSendParams);

    expect(seen.toolCalls).toHaveLength(1);
    expect(seen.toolCalls[0]!.call).toMatchObject({ name: 'read_file', args: { path: 'a.ts' } });

    expect(seen.events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(seen.events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
    const text = seen.events
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Based on a.ts, yes.');
    expect(result.finishReason).toBeUndefined();
    peer.close();
  });

  it('never asks the host for permission — an all-read toolset cannot reach the prompt', async () => {
    mock = await startMockServer({
      kind: 'sequence',
      responses: [toolCallResponse(), { kind: 'sse', chunks: ['done'] }],
    });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);
    const seen = record(peer);

    await peer.request<ChatSendResult>(METHODS.chatSend, {
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      maxTokens: 100,
      tools: [READ_TOOL],
      maxToolIterations: 2,
      runId: 'r1',
    } satisfies ChatSendParams);

    expect(seen.toolCalls).toHaveLength(1); // the tool did run
    expect(seen.sawPermissionRequest).toBe(false); // but nothing prompted
    peer.close();
  });

  it('withdraws tools on the final pass and says so, so the turn ends in prose', async () => {
    mock = await startMockServer({
      kind: 'sequence',
      responses: [toolCallResponse(), { kind: 'sse', chunks: ['answer'] }],
    });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);
    record(peer);

    await peer.request<ChatSendResult>(METHODS.chatSend, {
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      maxTokens: 100,
      tools: [READ_TOOL],
      maxToolIterations: 2,
      runId: 'r1',
    } satisfies ChatSendParams);

    const first = mock.requests[0]!.body as { tools?: unknown[] };
    const last = mock.requests.at(-1)!.body as { tools?: unknown[]; messages: Array<{ content: string }> };
    expect(first.tools).toHaveLength(1);
    expect(last.tools).toBeUndefined();
    expect(last.messages.at(-1)!.content).toContain('Tool access has ended');
  });

  it('surfaces a length finishReason so the host can warn about a truncated reply', async () => {
    mock = await startMockServer({
      kind: 'sse-raw',
      events: [JSON.stringify({ choices: [{ delta: { content: 'cut' }, finish_reason: 'length' }] })],
    });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);
    record(peer);

    const result = await peer.request<ChatSendResult>(METHODS.chatSend, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
      runId: 'r1',
    } satisfies ChatSendParams);

    expect(result.finishReason).toBe('length');
    peer.close();
  });

  it('agent/cancel stops an in-flight chat turn', async () => {
    mock = await startMockServer({ kind: 'hang-after-first-chunk', firstChunk: 'start' });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);
    const seen = record(peer);

    const pending = peer.request<ChatSendResult>(METHODS.chatSend, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      runId: 'r1',
    } satisfies ChatSendParams);

    // Wait for the stream to actually be flowing before cancelling.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (seen.events.some((e) => e.type === 'text_delta')) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
    peer.notify(METHODS.agentCancel, { runId: 'r1' });

    await expect(pending).rejects.toThrow();
    peer.close();
  });

  it('rejects a chat turn naming a profile this session does not hold', async () => {
    mock = await startMockServer({ kind: 'sse', chunks: ['x'] });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);
    record(peer);

    await expect(
      peer.request<ChatSendResult>(METHODS.chatSend, {
        profileName: 'someone-elses',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        runId: 'r1',
      } satisfies ChatSendParams),
    ).rejects.toThrow(/Unknown profile/);
    peer.close();
  });
});

describe('provider/listModels over the socket', () => {
  it('returns the endpoint’s models and the context length it reports', async () => {
    mock = await startMockServer({
      kind: 'json',
      status: 200,
      body: { data: [{ id: 'big', context_length: 128_000 }, { id: 'small' }] },
    });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);

    const result = await peer.request<ListModelsResult>(METHODS.listModels, {});
    expect(result.models).toEqual([{ id: 'big', contextLength: 128_000 }, { id: 'small' }]);
    // The context-window probe is this same call — the host picks its model out.
    expect(result.models.find((m) => m.id === 'big')?.contextLength).toBe(128_000);
    peer.close();
  });

  it('uses the requesting session’s key, and rejects a profile it does not hold', async () => {
    mock = await startMockServer({ kind: 'json', status: 200, body: { data: [{ id: 'm' }] } });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);

    await peer.request<ListModelsResult>(METHODS.listModels, {});
    expect(mock.requests[0]!.headers.authorization).toBe('Bearer sk-test');

    await expect(peer.request(METHODS.listModels, { profileName: 'nope' })).rejects.toThrow(
      /Unknown profile/,
    );
    peer.close();
  });

  it('surfaces an endpoint failure rather than pretending the list is empty', async () => {
    mock = await startMockServer({ kind: 'json', status: 500, body: { error: 'boom' } });
    await startServer();
    const peer = await connectClient([profile(mock.baseUrl)]);

    await expect(peer.request(METHODS.listModels, {})).rejects.toThrow();
    peer.close();
  });
});
