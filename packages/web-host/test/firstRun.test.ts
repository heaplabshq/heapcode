import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockServer, type MockServer } from '../../core/test/mockServer.js';
import { HeapcodeServer, RpcPeer, connectToServer, type ServerConnection } from '@heapcode/core';
import { ConfigStore, SecretsStore } from '@heapcode/host';
import { startWebHost, type RunningWebHost } from '../src/server.js';
import { WorkspaceStore } from '../src/workspaces.js';
import {
  UI_METHODS,
  UI_PROTOCOL_VERSION,
  type UiConversationMeta,
  type UiHelloResult,
  type UiSettings,
  type UiState,
} from '../src/protocol.js';
import { webSocketDuplex } from '../src/wsDuplex.js';

/**
 * Opening the app before it has been configured.
 *
 * `heapcode web` used to refuse to start without a provider profile and tell
 * you to go and run the CLI — while the screen that adds a provider is a page
 * inside the app it was refusing to serve. Someone who installed this to use
 * it in a browser had no way forward that did not go through a terminal.
 *
 * So the host opens anyway. What it does *not* do is pretend: `state.setup`
 * says what is missing, and the first thing that genuinely needs a model —
 * sending a message — fails with that same sentence rather than hanging or
 * producing an empty answer.
 */

let home: string;
let workspace: string;
let daemon: HeapcodeServer;
let mock: MockServer | undefined;
let web: RunningWebHost | undefined;
let sockets: WebSocket[] = [];

beforeEach(async () => {
  // Short paths — a unix socket path over 104 bytes fails listen() with EINVAL.
  home = await mkdtemp(join(tmpdir(), 'hcfr-'));
  workspace = await mkdtemp(join(tmpdir(), 'hcfw-'));
  process.env.HEAPCODE_HOME = home;
  sockets = [];
});

afterEach(async () => {
  for (const s of sockets) s.close();
  await web?.close();
  web = undefined;
  await daemon?.close();
  await mock?.close();
  mock = undefined;
  delete process.env.HEAPCODE_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

/**
 * A host booted on a config that cannot run anything yet.
 *
 * `config` is written verbatim, because the two states being tested are
 * *shapes* of config: no connection at all, and a connection whose chat role
 * names no model — which is what an interrupted edit of the role table leaves
 * behind, and is exactly what this was reported from.
 */
async function bootUnconfigured(config: (baseUrl: string) => unknown): Promise<RpcPeer> {
  mock = await startMockServer({
    kind: 'sequence',
    responses: [{ kind: 'sse', chunks: ['<tool name="finish">\n{"summary":"done"}\n</tool>'] }],
  });
  daemon = new HeapcodeServer({ home, address: join(home, 'fr.sock'), idleShutdownMs: 0 });
  await daemon.listen();

  const configPath = join(home, 'config.json');
  await writeFile(configPath, JSON.stringify(config(mock.baseUrl)), 'utf8');

  web = await startWebHost({
    root: realpathSync(workspace),
    config: new ConfigStore(configPath),
    secrets: new SecretsStore(join(home, 'secrets.json')),
    workspaces: new WorkspaceStore(join(home, 'workspaces.json')),
    nativeToolCalls: false, // the mock speaks the text protocol
    port: 0,
    token: 'test-token',
    connect: (hello): Promise<ServerConnection> =>
      connectToServer(
        { client: { name: 'first-run-test' }, ...hello },
        { address: daemon.address, token: daemon.token, autostart: false },
      ),
  });

  const ws = new WebSocket(`ws://127.0.0.1:${web.port}/rpc?token=${web.token}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new RpcPeer(webSocketDuplex(ws), 'br');
}

/** Nothing at all — a machine where `heapcode` has never been run. */
const NO_CONNECTION = (): unknown => ({});

/** An endpoint, but the chat role names no model. The reported state. */
const NO_MODEL = (baseUrl: string): unknown => ({
  connections: [{ name: 'mock', preset: 'custom', baseUrl, capabilities: { nativeToolCalls: false } }],
  roles: { chat: { connection: 'mock', model: '' } },
});

describe('opening the app before it is configured', () => {
  it('completes the handshake instead of refusing, and says what is missing', async () => {
    const peer = await bootUnconfigured(NO_CONNECTION);
    const hello = await peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
      client: { name: 'test' },
    });

    expect(hello.protocolVersion).toBe(UI_PROTOCOL_VERSION);
    expect(hello.state.setup).toMatch(/no connection yet/i);
    expect(hello.state.setup).toMatch(/settings/i);
    // Honest about the half that is not up, rather than claiming a daemon.
    expect(hello.state.daemon).toBe('down');
    expect(hello.state.profile).toBe('');
  });

  it('distinguishes "no endpoint" from "endpoint, no model"', async () => {
    const peer = await bootUnconfigured(NO_MODEL);
    const hello = await peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
      client: { name: 'test' },
    });
    // Naming the connection matters: the fix is a model for *that* one, and
    // "add a connection" sends someone to add a second copy of the one they
    // already have.
    expect(hello.state.setup).toMatch(/no model set for chat/i);
    expect(hello.state.setup).toContain('mock');
  });

  it('serves the settings screen, which is the only way out of this state', async () => {
    const peer = await bootUnconfigured(NO_MODEL);
    await peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION, client: { name: 'test' } });

    const settings = await peer.request<UiSettings>(UI_METHODS.settings);
    expect(settings.presets.length).toBeGreaterThan(0);
    expect(settings.profiles.map((p) => p.name)).toContain('mock');
    // Built by `open()`, which stopped short of starting MCP — an empty list,
    // not a crash on a session that was never built.
    expect(settings.mcpServers).toEqual([]);
  });

  it('still lists conversations, so the shell around the banner works', async () => {
    const peer = await bootUnconfigured(NO_CONNECTION);
    await peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION, client: { name: 'test' } });
    await expect(peer.request<UiConversationMeta[]>(UI_METHODS.conversations)).resolves.toEqual([]);
  });

  it('refuses to run, with the same sentence the banner shows', async () => {
    const peer = await bootUnconfigured(NO_MODEL);
    const hello = await peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
      client: { name: 'test' },
    });
    await expect(peer.request(UI_METHODS.sendMessage, { text: 'hello?' })).rejects.toThrow(
      hello.state.setup!,
    );
  });

  /**
   * The dropdowns, on a host with no model.
   *
   * These used to go through the daemon, which is only up once a model has
   * been chosen — so every model list was empty in exactly the state where
   * you are trying to choose one. The list appeared once, from the connection
   * test, and was gone again after a reload.
   */
  it('lists an endpoint\u2019s models with no daemon, which is how a model gets chosen', async () => {
    const peer = await bootUnconfigured(NO_MODEL);
    await peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION, client: { name: 'test' } });

    // No profileName: the composer's picker asks this way, and the answer has
    // to be the connection being configured rather than nothing.
    const composer = await peer.request<UiListModelsResult>(UI_METHODS.listModels);
    expect(composer.models.map((m) => m.id)).toContain('mock-model');

    // By name: the Model field of the connection being edited in Settings.
    const named = await peer.request<UiListModelsResult>(UI_METHODS.listModels, { profileName: 'mock' });
    expect(named.models.map((m) => m.id)).toContain('mock-model');

    // And the role rows, which ask per connection.
    const role = await peer.request<{ models: string[] }>(UI_METHODS.listConnectionModels, {
      connection: 'mock',
    });
    expect(role.models).toContain('other-model');
  });

  it('tests a connection that does not exist yet, with no daemon to route through', async () => {
    const peer = await bootUnconfigured(NO_CONNECTION);
    await peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION, client: { name: 'test' } });
    const probe = await peer.request<UiProbeProviderResult>(UI_METHODS.probeProvider, {
      preset: 'custom',
      baseUrl: mock!.baseUrl,
    });
    expect(probe.ok).toBe(true);
    expect(probe.models).toContain('mock-model');
  });

  /**
   * Picking from the composer, on a host with no model.
   *
   * `setModel` is a session override everywhere else. With nothing
   * configured there is nothing to override, and a picker that accepts a
   * model and then refuses to run is worse than one that refuses the pick —
   * so here the pick is the configuration.
   */
  it('treats a pick from the composer as the configuration when there is none', async () => {
    const peer = await bootUnconfigured(NO_MODEL);
    await peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION, client: { name: 'test' } });

    await peer.request(UI_METHODS.setModel, { model: 'mock-model' });

    const state = await peer.request<UiState>(UI_METHODS.state);
    expect(state.setup).toBeUndefined();
    expect(state.model).toBe('mock-model');
    expect(state.daemon).toBe('up');
    await expect(peer.request(UI_METHODS.sendMessage, { text: 'hello?' })).resolves.toBeTruthy();
  });

  it('comes alive when a model is chosen, without a reload', async () => {
    const peer = await bootUnconfigured(NO_MODEL);
    await peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION, client: { name: 'test' } });

    // Exactly what the Settings dialog sends when you fill in the model field
    // of the connection you already have.
    await peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', preset: 'custom', baseUrl: mock!.baseUrl, model: 'mock-model' },
    });

    const state = await peer.request<UiState>(UI_METHODS.state);
    expect(state.setup).toBeUndefined();
    expect(state.daemon).toBe('up');
    expect(state.model).toBe('mock-model');

    // And the thing that was refused a moment ago now runs.
    await expect(peer.request(UI_METHODS.sendMessage, { text: 'hello?' })).resolves.toBeTruthy();
  });
});
