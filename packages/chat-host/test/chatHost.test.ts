import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  HeapcodeServer,
  RpcPeer,
  connectToServer,
  type ServerConnection,
} from '@heapcode/core';
import { ConfigStore, SecretsStore } from '@heapcode/host';
import { WorkspaceStore, webSocketDuplex, type RunningWebHost } from '@heapcode/web-host';
import { startMockServer, type MockServer } from '../../core/test/mockServer.js';
import { startChatHost } from '../src/server.js';
import { CHAT_METHODS, CHAT_PROTOCOL_VERSION, type ChatHelloResult, type ChatState } from '../src/protocol.js';

/**
 * End-to-end over the real wire — mock model, real daemon, real host — because
 * the property being checked is about what crosses between processes, and a
 * unit test of the roster array cannot see that.
 */

let mock: MockServer | undefined;
let daemon: HeapcodeServer | undefined;
let host: RunningWebHost | undefined;
let socket: WebSocket | undefined;

afterEach(async () => {
  socket?.close();
  await host?.close();
  await daemon?.close();
  await mock?.close();
  socket = host = daemon = mock = undefined;
});

/** One scripted turn: the model answers in the text protocol and finishes. */
function sse(text: string): { kind: 'sse'; chunks: string[] } {
  return {
    kind: 'sse',
    chunks: [JSON.stringify({ choices: [{ delta: { content: text } }] })],
  };
}

async function boot(responses: Array<{ kind: 'sse'; chunks: string[] }>): Promise<{
  peer: RpcPeer;
  folder: string;
}> {
  mock = await startMockServer({ kind: 'sequence', responses });
  const home = await mkdtemp(join(tmpdir(), 'chat-host-test-'));
  daemon = new HeapcodeServer({ home, address: join(home, 'chat.sock'), idleShutdownMs: 0 });
  await daemon.listen();

  const folder = realpathSync(await mkdtemp(join(tmpdir(), 'chat-folder-')));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'notes.md'), '# Notes\n\nThe deposit is 1,450.\n', 'utf8');

  const configPath = join(home, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      activeProfile: 'mock',
      profiles: [
        { name: 'mock', preset: 'custom', baseUrl: mock.baseUrl, model: 'mock-model', capabilities: { nativeToolCalls: false } },
      ],
    }),
    'utf8',
  );

  host = await startChatHost({
    root: folder,
    config: new ConfigStore(configPath),
    secrets: new SecretsStore(join(home, 'secrets.json')),
    workspaces: new WorkspaceStore(join(home, 'workspaces.json')),
    memoryFile: join(home, 'chat-memory.json'),
    port: 0,
    token: 'test-token',
    connect: (hello): Promise<ServerConnection> =>
      connectToServer(
        { client: { name: 'chat-host-test' }, ...hello },
        { address: daemon!.address, token: daemon!.token, autostart: false },
      ),
  });

  socket = new WebSocket(`ws://127.0.0.1:${host.port}/rpc?token=${host.token}`);
  await new Promise<void>((resolve, reject) => {
    socket!.once('open', resolve);
    socket!.once('error', reject);
  });
  return { peer: new RpcPeer(webSocketDuplex(socket as never), 'test'), folder };
}

describe('the chat host', () => {
  it('opens on a folder and reports it as a folder, not a workspace', async () => {
    const { peer, folder } = await boot([sse('<tool name="finish">{"summary":"hello"}</tool>')]);
    const hello = await peer.request<ChatHelloResult>(CHAT_METHODS.hello, {
      protocolVersion: CHAT_PROTOCOL_VERSION,
    });
    expect(hello.protocolVersion).toBe(CHAT_PROTOCOL_VERSION);
    expect(hello.state.folder).toBe(folder);
    expect(hello.state.daemon).toBe('up');
    // ChatState has no persona and no permissionMode: one identity, and a
    // roster with nothing to gate.
    expect('persona' in hello.state).toBe(false);
    expect('permissionMode' in (hello.state as ChatState & Record<string, unknown>)).toBe(false);
  });

  it('offers the chat roster to the model, and none of the coding tools', async () => {
    const { peer } = await boot([sse('<tool name="finish">{"summary":"done"}</tool>')]);
    await peer.request(CHAT_METHODS.hello, { protocolVersion: CHAT_PROTOCOL_VERSION });
    await peer.request(CHAT_METHODS.sendMessage, { text: 'what is the deposit?' });

    // The text protocol renders the roster into the system prompt, so what the
    // model was actually offered is visible in the request that went out.
    const body = mock!.requests.at(-1)?.body as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
    for (const forbidden of ['write_file', 'edit_file', 'delete_file', 'run_command', 'repo_map']) {
      expect(system, `${forbidden} must not be offered`).not.toContain(forbidden);
    }
    for (const offered of ['read_file', 'semantic_search', 'remember']) {
      expect(system, `${offered} must be offered`).toContain(offered);
    }
  });

  it('replaces the coding identity rather than adding to it', async () => {
    const { peer } = await boot([sse('<tool name="finish">{"summary":"done"}</tool>')]);
    await peer.request(CHAT_METHODS.hello, { protocolVersion: CHAT_PROTOCOL_VERSION });
    await peer.request(CHAT_METHODS.sendMessage, { text: 'hello' });

    const body = mock!.requests.at(-1)?.body as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('Heap Chat');
    expect(system).toContain('You are not a coding agent');
  });

  it('keeps its conversations in its own store, away from Heap Code’s', async () => {
    const { peer } = await boot([sse('<tool name="finish">{"summary":"noted"}</tool>')]);
    await peer.request(CHAT_METHODS.hello, { protocolVersion: CHAT_PROTOCOL_VERSION });
    await peer.request(CHAT_METHODS.sendMessage, { text: 'first question' });

    const conversations = await peer.request<Array<{ title: string; active: boolean }>>(
      CHAT_METHODS.conversations,
    );
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe('first question');
    expect(conversations[0]?.active).toBe(true);
  });

  it('refuses to switch folder mid-run rather than moving the ground under the agent', async () => {
    const { peer, folder } = await boot([sse('<tool name="finish">{"summary":"ok"}</tool>')]);
    await peer.request(CHAT_METHODS.hello, { protocolVersion: CHAT_PROTOCOL_VERSION });
    // Not awaited: the switch has to race the run.
    const run = peer.request(CHAT_METHODS.sendMessage, { text: 'go' });
    await expect(peer.request(CHAT_METHODS.setFolder, { path: tmpdir() })).rejects.toThrow(/in progress/i);
    await run;
    // And still works once the run is over.
    const state = (await peer.request<{ state: ChatState }>(CHAT_METHODS.setFolder, { path: folder })).state;
    expect(state.folder).toBe(folder);
  });

  it('rejects a browser presenting the wrong token', async () => {
    await boot([sse('<tool name="finish">{"summary":"x"}</tool>')]);
    const bad = new WebSocket(`ws://127.0.0.1:${host!.port}/rpc?token=nope`);
    await expect(
      new Promise((resolve, reject) => {
        bad.once('open', resolve);
        bad.once('error', reject);
      }),
    ).rejects.toThrow();
    bad.close();
  });
});
