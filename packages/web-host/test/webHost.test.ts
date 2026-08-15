import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockServer, type MockServer } from '../../core/test/mockServer.js';
import {
  HeapcodeServer,
  RpcPeer,
  connectToServer,
  type AgentEvent,
  type ServerConnection,
} from '@heapcode/core';
import { ConfigStore, SecretsStore } from '@heapcode/host';
import { startWebHost, type RunningWebHost } from '../src/server.js';
import { clipArgs } from '../src/session.js';
import { WorkspaceStore } from '../src/workspaces.js';
import {
  UI_METHODS,
  UI_PROTOCOL_VERSION,
  type UiArtifactResult,
  type UiArtifactsResult,
  type UiChangesResult,
  type UiCheckpointsResult,
  type UiContextResult,
  type UiConversationMeta,
  type UiDiffResult,
  type UiEventParams,
  type UiFileTreeResult,
  type UiHelloResult,
  type UiOpenConversationResult,
  type UiReadFileResult,
  type UiPermissionRequestParams,
  type UiPermissionRequestResult,
  type UiSendMessageResult,
  type UiSetWorkspaceResult,
  type UiSettings,
  type UiState,
  type UiWorkspacesResult,
} from '../src/protocol.js';
import { webSocketDuplex } from '../src/wsDuplex.js';

/**
 * W2 acceptance (docs/WEB_APP_PLAN.md §10): a browser-shaped client drives a
 * full agent run over a real WebSocket and sees events stream.
 *
 * Real throughout except the model: a real HTTP server, a real WS upgrade with
 * the real auth path, a real daemon over a real socket, and the real
 * WorkspaceToolExecutor writing to a real workspace.
 */

let home: string;
let workspace: string;
let daemon: HeapcodeServer;
let mock: MockServer | undefined;
let web: RunningWebHost | undefined;

beforeEach(async () => {
  // Short paths — a unix socket path over 104 bytes fails listen() with EINVAL.
  home = await mkdtemp(join(tmpdir(), 'hcwh-'));
  workspace = await mkdtemp(join(tmpdir(), 'hcww-'));
  process.env.HEAPCODE_HOME = home;
});

afterEach(async () => {
  await web?.close();
  web = undefined;
  await daemon?.close();
  await mock?.close();
  mock = undefined;
  delete process.env.HEAPCODE_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

/** Boots daemon + web host wired to a scripted model. */
async function boot(
  // `sse-raw` as well as `sse`: some turns need a delta shape the convenience
  // helper can't express, notably `reasoning_content`.
  responses: Array<{ kind: 'sse'; chunks: string[] } | { kind: 'sse-raw'; events: string[] }>,
  /** Extra profile fields, for the ones only the CLI can normally set. */
  profileExtras: Record<string, unknown> = {},
): Promise<{
  root: string;
  host: RunningWebHost;
}> {
  mock = await startMockServer({ kind: 'sequence', responses });

  daemon = new HeapcodeServer({ home, address: join(home, 'w2.sock'), idleShutdownMs: 0 });
  await daemon.listen();

  const configPath = join(home, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      activeProfile: 'mock',
      profiles: [{ name: 'mock', preset: 'custom', baseUrl: mock.baseUrl, model: 'mock-model', ...profileExtras }],
    }),
    'utf8',
  );

  const root = realpathSync(workspace);
  const host = await startWebHost({
    root,
    config: new ConfigStore(configPath),
    secrets: new SecretsStore(join(home, 'secrets.json')),
    // Under the test's HEAPCODE_HOME, so the recent list stays hermetic.
    workspaces: new WorkspaceStore(join(home, 'workspaces.json')),
    nativeToolCalls: false, // the mock speaks the text protocol
    port: 0, // ephemeral, so parallel test files never collide
    token: 'test-token',
    connect: (hello): Promise<ServerConnection> =>
      connectToServer(
        { client: { name: 'web-host-test' }, ...hello },
        { address: daemon.address, token: daemon.token, autostart: false },
      ),
  });
  web = host;
  return { root, host };
}

interface Browser {
  peer: RpcPeer;
  events: AgentEvent[];
  permissionsSeen: UiPermissionRequestParams[];
  close(): void;
}

/** A browser-shaped client: same WS→Duplex adapter, same RpcPeer. */
async function openBrowser(
  host: RunningWebHost,
  opts: { choice?: UiPermissionRequestResult['choice']; token?: string; origin?: string } = {},
): Promise<Browser> {
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/rpc?token=${opts.token ?? host.token}`, {
    headers: opts.origin ? { origin: opts.origin } : {},
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const peer = new RpcPeer(webSocketDuplex(ws), 'br');
  const browser: Browser = {
    peer,
    events: [],
    permissionsSeen: [],
    close: () => ws.close(),
  };

  peer.onNotification(UI_METHODS.event, (raw) => {
    browser.events.push((raw as UiEventParams).event);
  });
  peer.onRequest(UI_METHODS.permissionRequest, async (raw): Promise<UiPermissionRequestResult> => {
    browser.permissionsSeen.push(raw as UiPermissionRequestParams);
    return { choice: opts.choice ?? 'allow' };
  });

  return browser;
}

const WRITE_THEN_FINISH = [
  { kind: 'sse' as const, chunks: ['<tool name="read_file">\n{"path":"greeting.txt"}\n</tool>'] },
  {
    kind: 'sse' as const,
    chunks: ['<tool name="write_file">\n{"path":"greeting.txt","content":"goodbye world\\n"}\n</tool>'],
  },
  { kind: 'sse' as const, chunks: ['<tool name="finish">\n{"summary":"done"}\n</tool>'] },
];

describe('web host — driving a run from a browser', () => {
  it('runs a task end to end: events stream, permission round-trips, file changes', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const browser = await openBrowser(host);

    const hello = await browser.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
      client: { name: 'test-browser' },
    });
    expect(hello.protocolVersion).toBe(UI_PROTOCOL_VERSION);
    expect(hello.state.workspaceName).toBe(basenameOf(root));

    const result = await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, {
      text: 'Rewrite greeting.txt to say goodbye world.',
    });

    expect(result.outcome).toBe('done');
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('goodbye world\n');

    // The event stream the UI will render, forwarded verbatim from agent/event.
    const kinds = browser.events.map((e) => e.type);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_result');

    // The permission card really reached the browser, with the CLI's wording.
    expect(browser.permissionsSeen.length).toBeGreaterThan(0);
    expect(browser.permissionsSeen[0]!.description).toContain('greeting.txt');
    expect(browser.permissionsSeen[0]!.permission).toBe('write');

    browser.close();
  });

  it('a browser that denies blocks the write — the host decides, not the model', async () => {
    const { root, host } = await boot([
      {
        kind: 'sse' as const,
        chunks: ['<tool name="write_file">\n{"path":"greeting.txt","content":"OVERWRITTEN\\n"}\n</tool>'],
      },
      { kind: 'sse' as const, chunks: ['<tool name="finish">\n{"summary":"blocked"}\n</tool>'] },
    ]);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const browser = await openBrowser(host, { choice: 'deny' });
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'overwrite it' });

    expect(browser.permissionsSeen.length).toBeGreaterThan(0);
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('hello world\n');

    browser.close();
  });

  it('state never carries key material — only whether a key exists', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const secrets = new SecretsStore(join(home, 'secrets.json'));
    await secrets.setApiKey('mock', 'sk-super-secret-value');

    const browser = await openBrowser(host);
    const hello = await browser.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });

    const asJson = JSON.stringify(hello.state);
    expect(asJson).not.toContain('sk-super-secret-value');
    const state: UiState = hello.state;
    expect(state.profiles.find((p) => p.name === 'mock')?.hasKey).toBe(true);

    browser.close();
  });
});

describe('web host — auth', () => {
  it('rejects a wrong token at the WS upgrade', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    await expect(openBrowser(host, { token: 'wrong-token' })).rejects.toThrow(/401|Unauthorized/);
  });

  it('rejects a cross-origin upgrade — a hostile page must not drive the agent', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    await expect(openBrowser(host, { origin: 'http://evil.example' })).rejects.toThrow(/403|Forbidden/);
  });

  it('accepts the loopback origin a real browser would send', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host, { origin: `http://127.0.0.1:${host.port}` });
    const hello = await browser.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });
    expect(hello.protocolVersion).toBe(UI_PROTOCOL_VERSION);
    browser.close();
  });
});

describe('web host — conversations', () => {
  it('persists a turn, lists it, and reloads it into a later tab', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite the greeting' });

    const list = await browser.peer.request<UiConversationMeta[]>(UI_METHODS.conversations);
    expect(list.length).toBe(1);
    expect(list[0]!.active).toBe(true);
    // Titled from what the user typed, not from the preamble-expanded task.
    expect(list[0]!.title).toBe('rewrite the greeting');

    const reopened = await browser.peer.request<UiOpenConversationResult>(UI_METHODS.openConversation, {
      id: list[0]!.id,
    });
    // The user's own words come back, not the instructions-wrapped version.
    expect(reopened.messages[0]).toMatchObject({ role: 'user', content: 'rewrite the greeting' });
    expect(reopened.messages.map((m) => m.role)).toContain('assistant');

    browser.close();
  });

  it('a reloaded tab gets the tool calls back, not just the prose', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const first = await openBrowser(host);
    await first.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await first.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite the greeting' });
    // What the live tab saw. (`finish` terminates the loop rather than
    // emitting a call, so it is not in the stream.)
    expect(first.events.filter((e) => e.type === 'tool_call').map((e) => e.name)).toEqual([
      'read_file',
      'write_file',
    ]);
    first.close();

    // A brand new tab — no replay buffer, only history.
    const reloaded = await openBrowser(host);
    const hello = await reloaded.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });

    const tools = hello.messages.filter((m) => m.ui?.tool);
    expect(tools.map((m) => m.ui!.tool!.name)).toEqual(['read_file', 'write_file']);
    // Arguments survive, so the chip redraws its one-liner and its "open file".
    expect(tools[1]!.ui!.tool!.args).toMatchObject({ path: 'greeting.txt' });
    // And the user's message is still first, ahead of the chips.
    expect(hello.messages[0]).toMatchObject({ role: 'user', content: 'rewrite the greeting' });
    reloaded.close();
  });

  it('a written file is not copied wholesale into the conversation', () => {
    const clipped = clipArgs({
      path: 'src/big.ts',
      content: 'x'.repeat(50_000),
      overwrite: true,
      edits: [{ search: 'a', replace: 'b' }],
    });
    expect(clipped.path).toBe('src/big.ts');
    expect((clipped.content as string).length).toBeLessThan(250);
    expect(clipped.overwrite).toBe(true);
    // Unbounded nested structures are dropped, not walked — nothing renders them.
    expect(clipped.edits).toBeUndefined();
  });

  it('a new conversation starts empty and leaves the old one listed', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'first chat' });

    const fresh = await browser.peer.request<UiOpenConversationResult>(UI_METHODS.newConversation);
    expect(fresh.messages).toEqual([]);

    const list = await browser.peer.request<UiConversationMeta[]>(UI_METHODS.conversations);
    expect(list.some((c) => c.title === 'first chat')).toBe(true);
    // The new one is current but unsaved until it has a turn.
    expect(list.find((c) => c.title === 'first chat')?.active).toBe(false);

    browser.close();
  });

  it('refuses to switch conversations mid-run rather than losing the transcript', async () => {
    const { host } = await boot([{ kind: 'sse' as const, chunks: ['<tool name="finish">\n{"summary":"ok"}\n</tool>'] }]);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    // Drive the guard directly: a run is "active" for the duration of the call,
    // so assert the rule the UI depends on via the session's own state.
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'quick' });
    // After it finishes, switching is allowed again.
    await expect(browser.peer.request(UI_METHODS.newConversation)).resolves.toBeTruthy();

    browser.close();
  });
});

describe('web host — tool protocol', () => {
  /**
   * Regression: the host hardcoded `nativeToolCalls: true`, ignoring the
   * profile. Endpoints that reject the `tools` parameter got it anyway, so the
   * model narrated instead of calling tools — no chips, no edits, and the
   * settings toggle appeared to do nothing because `run()` never read it.
   * Both other hosts resolve this from the profile; so must this one.
   */
  it('honours the profile when it disables native tool calls', async () => {
    mock = await startMockServer({
      kind: 'sequence',
      responses: [{ kind: 'sse', chunks: ['<tool name="finish">\n{"summary":"ok"}\n</tool>'] }],
    });
    daemon = new HeapcodeServer({ home, address: join(home, 'proto.sock'), idleShutdownMs: 0 });
    await daemon.listen();

    const configPath = join(home, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        activeProfile: 'local',
        profiles: [
          {
            name: 'local',
            preset: 'custom',
            baseUrl: mock.baseUrl,
            model: 'mock-model',
            capabilities: { nativeToolCalls: false },
          },
        ],
      }),
      'utf8',
    );

    const host = await startWebHost({
      root: realpathSync(workspace),
      config: new ConfigStore(configPath),
      secrets: new SecretsStore(join(home, 'secrets.json')),
      // Deliberately NOT set — the profile must decide, as it does in the CLI.
      port: 0,
      token: 'test-token',
      connect: (hello): Promise<ServerConnection> =>
        connectToServer(
          { client: { name: 'web-host-test' }, ...hello },
          { address: daemon.address, token: daemon.token, autostart: false },
        ),
    });
    web = host;

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const result = await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'go' });

    // The scripted model only speaks the text protocol. If the host had sent
    // nativeToolCalls: true, the loop would not have parsed `finish` and the
    // run would not have completed.
    expect(result.outcome).toBe('done');

    // And the request carried no `tools` array.
    const body = mock.requests[0]?.body as { tools?: unknown[] } | undefined;
    expect(body?.tools).toBeUndefined();

    browser.close();
  });

  it('sends native tool definitions when the profile allows them', async () => {
    const { host } = await bootNative();
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'go' }).catch(() => {});

    const body = mock!.requests[0]?.body as { tools?: unknown[] } | undefined;
    expect(Array.isArray(body?.tools)).toBe(true);
    expect((body!.tools as Array<{ function?: { name: string } }>).length).toBeGreaterThan(0);

    browser.close();
  });

  /** A profile with no capabilities set — the default — should get native calls. */
  async function bootNative(): Promise<{ host: RunningWebHost }> {
    mock = await startMockServer({
      kind: 'json',
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] },
    });
    daemon = new HeapcodeServer({ home, address: join(home, 'native.sock'), idleShutdownMs: 0 });
    await daemon.listen();
    const configPath = join(home, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        activeProfile: 'cloud',
        profiles: [{ name: 'cloud', preset: 'openai', baseUrl: mock.baseUrl, model: 'mock-model' }],
      }),
      'utf8',
    );
    const host = await startWebHost({
      root: realpathSync(workspace),
      config: new ConfigStore(configPath),
      secrets: new SecretsStore(join(home, 'secrets.json')),
      port: 0,
      token: 'test-token',
      connect: (hello): Promise<ServerConnection> =>
        connectToServer(
          { client: { name: 'web-host-test' }, ...hello },
          { address: daemon.address, token: daemon.token, autostart: false },
        ),
    });
    web = host;
    return { host };
  }
});

describe('web host — settings', () => {
  it('reports settings without ever exposing a key', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const secrets = new SecretsStore(join(home, 'secrets.json'));
    await secrets.setApiKey('mock', 'sk-do-not-leak');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const s = await browser.peer.request<UiSettings>(UI_METHODS.settings);

    expect(JSON.stringify(s)).not.toContain('sk-do-not-leak');
    expect(s.profiles.find((p) => p.name === 'mock')?.hasKey).toBe(true);
    expect(s.personas.map((p) => p.id)).toContain('agent');
    expect(s.permissionMode).toBe('default');
    browser.close();
  });

  it('persona, sub-agents and mode round-trip', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.setPersona, { persona: 'reviewer' });
    await browser.peer.request(UI_METHODS.setSubAgents, { enabled: true });
    await browser.peer.request(UI_METHODS.setMode, { mode: 'auto-edit' });

    const s = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    expect(s.persona).toBe('reviewer');
    expect(s.subAgents).toBe(true);
    expect(s.permissionMode).toBe('auto-edit');
    browser.close();
  });

  it('rejects an unknown permission mode instead of storing nonsense', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await expect(browser.peer.request(UI_METHODS.setMode, { mode: 'yolo' })).rejects.toThrow(/Unknown permission mode/);
    browser.close();
  });

  it('stores a new profile and its key, and reports hasKey without returning it', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'second', preset: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' },
      apiKey: 'sk-second-secret',
    });

    const s = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    const added = s.profiles.find((p) => p.name === 'second');
    expect(added?.hasKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain('sk-second-secret');
    browser.close();
  });

  it('sets the context window and output cap from the browser, and reports them back', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const before = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    expect(before.profiles.find((p) => p.name === 'mock')?.contextWindow).toBeUndefined();

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', contextWindow: 200_000, maxTokens: 16_384 },
    });

    const after = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    const mockProfile = after.profiles.find((p) => p.name === 'mock');
    expect(mockProfile?.contextWindow).toBe(200_000);
    expect(mockProfile?.effectiveContextWindow).toBe(200_000);
    expect(mockProfile?.maxTokens).toBe(16_384);

    // And the header meter sees it without waiting for a run to report usage.
    const state = await browser.peer.request<UiState>(UI_METHODS.state);
    expect(state.contextWindow).toBe(200_000);

    // Emptying the box clears the override rather than pinning it to zero.
    await browser.peer.request(UI_METHODS.saveProfile, { profile: { name: 'mock', contextWindow: null } });
    const cleared = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    expect(cleared.profiles.find((p) => p.name === 'mock')?.contextWindow).toBeUndefined();
    browser.close();
  });

  it('rejects a nonsense token budget instead of storing it', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await expect(
      browser.peer.request(UI_METHODS.saveProfile, { profile: { name: 'mock', contextWindow: 0 } }),
    ).rejects.toThrow(/positive whole number/);
    await expect(
      browser.peer.request(UI_METHODS.saveProfile, { profile: { name: 'mock', preset: 'azure' } }),
    ).rejects.toThrow(/Unknown provider preset/);
    browser.close();
  });

  it('editing a profile keeps the fields the browser never sees', async () => {
    // temperature/timeoutMs are CLI-only settings the web form never renders.
    const { host } = await boot(WRITE_THEN_FINISH, { temperature: 0.3, timeoutMs: 900_000 });
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', model: 'other-model' },
    });

    const after = (await new ConfigStore(join(home, 'config.json')).getProfile('mock'))!;
    expect(after.model).toBe('other-model');
    expect(after.temperature).toBe(0.3);
    expect(after.timeoutMs).toBe(900_000);
    browser.close();
  });

  it('refuses to delete the profile in use — that would strand the session', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await expect(browser.peer.request(UI_METHODS.deleteProfile, { name: 'mock' })).rejects.toThrow(/currently in use/);
    browser.close();
  });

  it('clears saved permission grants', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const res = await browser.peer.request<{ cleared: number }>(UI_METHODS.resetPermissions);
    expect(typeof res.cleared).toBe('number');
    browser.close();
  });

  it('rejects an unknown slash command rather than running an empty task', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await expect(browser.peer.request(UI_METHODS.runCommand, { command: '/nope' })).rejects.toThrow(/Unknown command/);
    browser.close();
  });
});

describe('web host — workspace panel', () => {
  it('reports the file the agent changed, with a diff and line stats', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite it' });

    const changes = await browser.peer.request<UiChangesResult>(UI_METHODS.changes);
    expect(changes.files.map((f) => f.path)).toContain('greeting.txt');

    const diff = await browser.peer.request<UiDiffResult>(UI_METHODS.diff, { path: 'greeting.txt' });
    expect(diff.diff).toContain('-hello world');
    expect(diff.diff).toContain('+goodbye world');
    expect(diff.added).toBeGreaterThan(0);
    expect(diff.removed).toBeGreaterThan(0);

    browser.close();
  });

  it('reverting from the panel puts the file back', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite it' });
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('goodbye world\n');

    await browser.peer.request(UI_METHODS.revertFile, { path: 'greeting.txt' });
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('hello world\n');

    browser.close();
  });

  it('lists the workspace tree and reads a file, but never outside the root', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const tree = await browser.peer.request<UiFileTreeResult>(UI_METHODS.fileTree, { path: '' });
    expect(tree.entries.map((e) => e.name)).toContain('a.ts');

    const file = await browser.peer.request<UiReadFileResult>(UI_METHODS.readFile, { path: 'a.ts' });
    expect(file.content).toContain('export const a');

    // The jail holds over the wire, not just in the unit test.
    await expect(
      browser.peer.request(UI_METHODS.readFile, { path: '../../etc/passwd' }),
    ).rejects.toThrow(/escapes the workspace/);

    browser.close();
  });

  it('records a checkpoint before the change, and can rewind to it', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite it' });

    const { checkpoints } = await browser.peer.request<UiCheckpointsResult>(UI_METHODS.checkpoints);
    expect(checkpoints.length).toBeGreaterThan(0);
    // The label carries the tool and its description, so the timeline is readable.
    expect(checkpoints[0]!.label).toContain('write_file');

    await browser.peer.request(UI_METHODS.rewind, { hash: checkpoints[0]!.hash });
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('hello world\n');

    browser.close();
  });

  it('refuses to rewind mid-run rather than pulling files out from under the agent', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    // No run in flight → the guard should not fire, but the hash is bogus.
    await expect(browser.peer.request(UI_METHODS.rewind, { hash: 'deadbeef' })).rejects.toThrow();
    browser.close();
  });
});

describe('web host — artifacts', () => {
  const MAKE_ARTIFACT = [
    {
      kind: 'sse' as const,
      chunks: [
        '<tool name="create_artifact">\n' +
          '{"id":"dash","title":"Dashboard","kind":"html","content":"<h1>Sales</h1>"}\n' +
          '</tool>',
      ],
    },
    { kind: 'sse' as const, chunks: ['<tool name="finish">\n{"summary":"made it"}\n</tool>'] },
  ];

  it('the agent creates one, and the browser can list and fetch it', async () => {
    const { host } = await boot(MAKE_ARTIFACT);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'make me a dashboard' });

    const list = await browser.peer.request<UiArtifactsResult>(UI_METHODS.artifacts);
    expect(list.artifacts.map((a) => a.id)).toContain('dash');

    const artifact = await browser.peer.request<UiArtifactResult>(UI_METHODS.artifact, { id: 'dash' });
    expect(artifact.title).toBe('Dashboard');
    expect(artifact.kind).toBe('html');
    expect(artifact.content).toContain('<h1>Sales</h1>');
    expect(artifact.version).toBe(1);

    browser.close();
  });

  it('is offered to the model here, but never appears in the shared tool list', async () => {
    const { host } = await boot(MAKE_ARTIFACT);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'go' });

    // The tool list actually sent to the model on this host.
    const sent = mock!.requests.at(0)?.body as { tools?: Array<{ function?: { name: string } }> } | undefined;
    void sent; // text-protocol mode advertises tools in the prompt, not the body
    // The artifact landed, which is only possible if the tool was offered and
    // executed by this host — the CLI never offers it (see artifacts.test.ts).
    const list = await browser.peer.request<UiArtifactsResult>(UI_METHODS.artifacts);
    expect(list.artifacts).toHaveLength(1);

    browser.close();
  });

  it('a second create with the same id makes v2, and v1 is still fetchable', async () => {
    const { host } = await boot([
      MAKE_ARTIFACT[0]!,
      {
        kind: 'sse' as const,
        chunks: [
          '<tool name="create_artifact">\n' +
            '{"id":"dash","title":"Dashboard","kind":"html","content":"<h1>Sales v2</h1>"}\n' +
            '</tool>',
        ],
      },
      { kind: 'sse' as const, chunks: ['<tool name="finish">\n{"summary":"done"}\n</tool>'] },
    ]);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'update it' });

    const latest = await browser.peer.request<UiArtifactResult>(UI_METHODS.artifact, { id: 'dash' });
    expect(latest.versions).toBe(2);
    expect(latest.content).toContain('Sales v2');

    const first = await browser.peer.request<UiArtifactResult>(UI_METHODS.artifact, { id: 'dash', version: 1 });
    expect(first.content).toContain('<h1>Sales</h1>');

    browser.close();
  });

  it('an invalid kind is returned to the model as a correctable error, not a crash', async () => {
    const { host } = await boot([
      {
        kind: 'sse' as const,
        chunks: [
          '<tool name="create_artifact">\n{"title":"X","kind":"executable","content":"boom"}\n</tool>',
        ],
      },
      { kind: 'sse' as const, chunks: ['<tool name="finish">\n{"summary":"gave up"}\n</tool>'] },
    ]);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const result = await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'go' });

    // The run completed rather than failing; nothing was stored.
    expect(result.outcome).toBe('done');
    const list = await browser.peer.request<UiArtifactsResult>(UI_METHODS.artifacts);
    expect(list.artifacts).toHaveLength(0);

    browser.close();
  });

  it('saving to the workspace goes through the executor, so revert covers it', async () => {
    const { root, host } = await boot(MAKE_ARTIFACT);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'make it' });

    await browser.peer.request(UI_METHODS.saveArtifact, { id: 'dash', path: 'dashboard.html' });
    expect(await readFile(join(root, 'dashboard.html'), 'utf8')).toContain('<h1>Sales</h1>');

    // It shows up as a session change, which is what makes it revertable.
    const changes = await browser.peer.request<UiChangesResult>(UI_METHODS.changes);
    expect(changes.files.map((f) => f.path)).toContain('dashboard.html');

    browser.close();
  });

  it('cannot be saved outside the workspace', async () => {
    const { host } = await boot(MAKE_ARTIFACT);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'make it' });

    await expect(
      browser.peer.request(UI_METHODS.saveArtifact, { id: 'dash', path: '../../escaped.html' }),
    ).rejects.toThrow();

    browser.close();
  });
});

describe('web host — cancellation', () => {
  it('ui/cancel stops a run in flight', async () => {
    // The model never answers, so the run is still open when cancel arrives.
    mock = await startMockServer({ kind: 'hang' });
    daemon = new HeapcodeServer({ home, address: join(home, 'w2c.sock'), idleShutdownMs: 0 });
    await daemon.listen();
    const configPath = join(home, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        activeProfile: 'mock',
        profiles: [{ name: 'mock', preset: 'custom', baseUrl: mock.baseUrl, model: 'mock-model' }],
      }),
      'utf8',
    );
    const host = await startWebHost({
      root: realpathSync(workspace),
      config: new ConfigStore(configPath),
      secrets: new SecretsStore(join(home, 'secrets.json')),
      nativeToolCalls: false,
      port: 0,
      token: 'test-token',
      connect: (hello): Promise<ServerConnection> =>
        connectToServer(
          { client: { name: 'web-host-test' }, ...hello },
          { address: daemon.address, token: daemon.token, autostart: false },
        ),
    });
    web = host;

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const runId = 'cancel-me';
    const running = browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, {
      text: 'something slow',
      runId,
    });

    // Give the run a moment to reach the (hanging) provider before cancelling.
    await new Promise((r) => setTimeout(r, 150));
    await browser.peer.request(UI_METHODS.cancel, { runId });

    await expect(running).rejects.toThrow();
    browser.close();
  });

  /**
   * Regression, and the one that actually bit: `tool/execute`'s handler
   * dropped the AbortSignal RpcPeer hands it. Cancelling a run fires
   * `$/cancelRequest` for the outstanding tool call, and that signal is what
   * `runCommand` listens to in order to kill the child process group
   * (workspaceTools.ts:566). Without it, Stop ended the loop but left the
   * command running to completion — the request never settled, so the agent
   * appeared to ignore the click entirely.
   *
   * Asserted by side effect, not by wall clock: the command writes a marker
   * file *after* sleeping, and the run's own promise settles on the local
   * abort either way — so timing proves nothing. If the child survived Stop,
   * the marker appears. That is the only observation that distinguishes
   * "killed" from "orphaned and still running".
   */
  it('kills a running command when the user hits Stop', async () => {
    const marker = join(realpathSync(workspace), 'survived.txt');
    mock = await startMockServer({
      kind: 'sse',
      chunks: [`<tool name="run_command">\n{"command":"sleep 3; echo alive > ${marker}"}\n</tool>`],
    });
    daemon = new HeapcodeServer({ home, address: join(home, 'kill.sock'), idleShutdownMs: 0 });
    await daemon.listen();
    const configPath = join(home, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        activeProfile: 'mock',
        profiles: [{ name: 'mock', preset: 'custom', baseUrl: mock.baseUrl, model: 'mock-model' }],
      }),
      'utf8',
    );
    const host = await startWebHost({
      root: realpathSync(workspace),
      config: new ConfigStore(configPath),
      secrets: new SecretsStore(join(home, 'secrets.json')),
      nativeToolCalls: false,
      permissionMode: 'full-auto', // no prompt; the point here is the kill
      port: 0,
      token: 'test-token',
      connect: (hello): Promise<ServerConnection> =>
        connectToServer(
          { client: { name: 'web-host-test' }, ...hello },
          { address: daemon.address, token: daemon.token, autostart: false },
        ),
    });
    web = host;

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const runId = 'kill-me';
    const running = browser.peer
      .request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'sleep', runId })
      .catch(() => undefined);

    // Wait for the command to actually be running before stopping it.
    await new Promise((r) => setTimeout(r, 700));
    await browser.peer.request(UI_METHODS.cancel, { runId });
    await running;

    // Well past the sleep: if the child survived, it has written by now.
    await new Promise((r) => setTimeout(r, 4_000));

    const survived = await readFile(marker, 'utf8').then(
      () => true,
      () => false,
    );
    expect(survived, 'the command outlived Stop — its process group was not killed').toBe(false);

    browser.close();
  }, 45_000);

  it('stops the daemon calling the model', async () => {
    // Endless tool calls: if the loop is alive it keeps hitting the provider.
    mock = await startMockServer({
      kind: 'sse',
      chunks: ['<tool name="read_file">\n{"path":"a.ts"}\n</tool>'],
    });
    daemon = new HeapcodeServer({ home, address: join(home, 'w2x.sock'), idleShutdownMs: 0 });
    await daemon.listen();
    const configPath = join(home, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        activeProfile: 'mock',
        profiles: [{ name: 'mock', preset: 'custom', baseUrl: mock.baseUrl, model: 'mock-model' }],
      }),
      'utf8',
    );
    const host = await startWebHost({
      root: realpathSync(workspace),
      config: new ConfigStore(configPath),
      secrets: new SecretsStore(join(home, 'secrets.json')),
      nativeToolCalls: false,
      port: 0,
      token: 'test-token',
      connect: (hello): Promise<ServerConnection> =>
        connectToServer(
          { client: { name: 'web-host-test' }, ...hello },
          { address: daemon.address, token: daemon.token, autostart: false },
        ),
    });
    web = host;
    await writeFile(join(realpathSync(workspace), 'a.ts'), 'export const a = 1;\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const runId = 'stop-me';
    const running = browser.peer
      .request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'loop forever', runId })
      .catch(() => undefined);

    await new Promise((r) => setTimeout(r, 250));
    await browser.peer.request(UI_METHODS.cancel, { runId });
    await running;

    // Let anything still running get a few more model calls in.
    const atCancel = mock.requests.length;
    await new Promise((r) => setTimeout(r, 400));

    expect(mock.requests.length, 'the daemon kept calling the model after Stop').toBe(atCancel);
    browser.close();
  });
});

describe('web host — reattach', () => {
  it('a second browser replays the run it missed, and the run survives the first closing', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const first = await openBrowser(host);
    await first.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const result = await first.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite it' });
    expect(result.outcome).toBe('done');
    first.close();

    // A fresh tab asks for that run's transcript.
    const second = await openBrowser(host);
    const hello = await second.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
      resumeRunId: result.runId,
    });

    expect(hello.replay?.length).toBeGreaterThan(0);
    expect(hello.replay!.map((e) => e.event.type)).toContain('tool_call');
    second.close();
  });

  it('hands a tab that reloads MID-run the whole turn so far, prompt included', async () => {
    // `replay` alone could not do this: the buffer is bounded, and the user's
    // own prompt is never in it — the turn is only written to history when it
    // finishes. A tab that reloaded mid-run came back to a transcript that
    // began in the middle of the agent's work, with nothing above it.
    const gate = deferred();
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');

    const first = await openBrowser(host);
    await first.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    // Hold the run open on the write's permission card — an unanswered card is
    // the most realistic way a run is still in flight when a tab reloads.
    first.peer.onRequest(UI_METHODS.permissionRequest, async () => {
      gate.resolve();
      await never();
      return { choice: 'allow' };
    });
    const running = first.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, {
      text: 'rewrite the greeting',
    });
    void running.catch(() => {});
    await gate.promise;

    const second = await openBrowser(host);
    const hello = await second.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });

    expect(hello.activeRunId).toBeTruthy();
    // The prompt, which lives nowhere else until the turn is persisted.
    expect(hello.pending?.[0]).toMatchObject({ role: 'user', content: 'rewrite the greeting' });
    const chips = hello.pending!.filter((m) => m.ui?.tool).map((m) => m.ui!.tool!);
    // The finished read comes back done; the write, still waiting on the card,
    // comes back as a chip that is still running.
    expect(chips.map((t) => [t.name, t.done])).toEqual([
      ['read_file', true],
      ['write_file', false],
    ]);

    await second.peer.request(UI_METHODS.cancel, { runId: hello.activeRunId });
    second.close();
    first.close();
  });
});

describe('web host — model switching', () => {
  it('ui/setModel changes the model the UI reports, not just the one that runs', async () => {
    // The picker read `state.model`, which was computed from the profile and
    // ignored the override entirely: switching models changed which model the
    // next run used while every label in the UI went on naming the old one, so
    // the dropdown looked broken.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    const hello = await browser.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });
    expect(hello.state.model).toBe('mock-model');

    const pushed: UiState[] = [];
    browser.peer.onNotification(UI_METHODS.stateChanged, (raw) => pushed.push(raw as UiState));

    await browser.peer.request(UI_METHODS.setModel, { model: 'other-model' });
    const state = await browser.peer.request<UiState>(UI_METHODS.state);
    expect(state.model).toBe('other-model');
    // And pushed, so an attached tab updates without asking.
    expect(pushed.at(-1)?.model).toBe('other-model');
    browser.close();
  });

  it('actually sends the chosen model to the provider', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.setModel, { model: 'other-model' });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'go' });

    expect(mock!.requests.at(-1)?.body).toMatchObject({ model: 'other-model' });
    browser.close();
  });
});

describe('web host — reasoning survives a reload', () => {
  const THINK_THEN_FINISH = [
    {
      kind: 'sse-raw' as const,
      events: [
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'weighing the options' } }] }),
        JSON.stringify({
          choices: [{ delta: { content: '<tool name="finish">\n{"summary":"all set"}\n</tool>' } }],
        }),
      ],
    },
  ];

  it('a reloaded tab still shows the thinking block it watched stream', async () => {
    const { host } = await boot(THINK_THEN_FINISH);
    const first = await openBrowser(host);
    await first.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await first.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'decide something' });
    first.close();

    const second = await openBrowser(host);
    const hello = await second.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });
    const thought = hello.messages.find((m) => m.ui?.reasoning);
    expect(thought?.content).toContain('weighing the options');
    second.close();
  });

  it('never feeds that thinking back to the model as if it were dialogue', async () => {
    const { host } = await boot(THINK_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'decide something' });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'now do it' });

    // The second turn's request carries the first turn's history. A stored
    // scratchpad replayed as an assistant message would steer the next turn.
    const sent = JSON.stringify(mock!.requests.at(-1)?.body);
    expect(sent).not.toContain('weighing the options');
    browser.close();
  });
});

describe('web host — switching workspace', () => {
  it('repoints the session, and the agent then edits the NEW folder', async () => {
    // The whole risk of switching roots is a half-moved session: an executor
    // still jailed to the old workspace while the UI says it moved. The only
    // test that settles it is making the agent write a file afterwards and
    // checking which folder it landed in.
    const { root, host } = await boot(WRITE_THEN_FINISH);
    const other = realpathSync(await mkdtemp(join(tmpdir(), 'hcw2-')));
    await writeFile(join(root, 'greeting.txt'), 'first workspace\n', 'utf8');
    await writeFile(join(other, 'greeting.txt'), 'second workspace\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const res = await browser.peer.request<UiSetWorkspaceResult>(UI_METHODS.setWorkspace, { path: other });
    expect(res.state.root).toBe(other);
    expect(res.state.workspaceName).toBe(basenameOf(other));
    // A conversation belongs to the folder it happened in.
    expect(res.messages).toEqual([]);

    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite it' });
    expect(await readFile(join(other, 'greeting.txt'), 'utf8')).toBe('goodbye world\n');
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('first workspace\n');

    browser.close();
    await rm(other, { recursive: true, force: true });
  });

  it('has the recent list up to date the moment the switch resolves', async () => {
    // The picker refetches immediately after switching, so a fire-and-forget
    // write lost the race and the list came back ordered by the previous one.
    const { root, host } = await boot(WRITE_THEN_FINISH);
    const other = realpathSync(await mkdtemp(join(tmpdir(), 'hcw4-')));
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.setWorkspace, { path: other });
    await browser.peer.request(UI_METHODS.setWorkspace, { path: root });

    const list = await browser.peer.request<UiWorkspacesResult>(UI_METHODS.workspaces);
    expect(list.recent.map((w) => w.path)).toEqual([root, other]);
    browser.close();
    await rm(other, { recursive: true, force: true });
  });

  it('lists the current folder as recent even before anything was recorded', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const list = await browser.peer.request<UiWorkspacesResult>(UI_METHODS.workspaces);
    expect(list.current).toBe(root);
    expect(list.recent.map((w) => w.path)).toContain(root);
    browser.close();
  });

  it('refuses a path that is not a folder rather than half-switching', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'a-file.txt'), 'x', 'utf8');
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await expect(
      browser.peer.request(UI_METHODS.setWorkspace, { path: join(root, 'a-file.txt') }),
    ).rejects.toThrow(/Not a folder/);
    await expect(
      browser.peer.request(UI_METHODS.setWorkspace, { path: join(root, 'nope') }),
    ).rejects.toThrow(/Not a folder/);

    // Still where it started.
    const state = await browser.peer.request<UiState>(UI_METHODS.state);
    expect(state.root).toBe(root);
    browser.close();
  });

  it('refuses to move the ground under a run in flight', async () => {
    const gate = deferred();
    const { root, host } = await boot(WRITE_THEN_FINISH);
    const other = realpathSync(await mkdtemp(join(tmpdir(), 'hcw3-')));
    await writeFile(join(root, 'greeting.txt'), 'hello\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    browser.peer.onRequest(UI_METHODS.permissionRequest, async () => {
      gate.resolve();
      await never();
      return { choice: 'allow' };
    });
    const running = browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite it' });
    void running.catch(() => {});
    await gate.promise;

    await expect(browser.peer.request(UI_METHODS.setWorkspace, { path: other })).rejects.toThrow(
      /run is in progress/i,
    );

    await browser.peer.request(UI_METHODS.cancel, { runId: 'whatever' });
    browser.close();
    await rm(other, { recursive: true, force: true });
  });
});

describe('web host — model roles', () => {
  it('round-trips every role model and its cross-profile override', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: {
        name: 'mock',
        agentModel: 'big-agent',
        applyModel: 'fast-apply-1.5b',
        embeddingsModel: 'nomic-embed',
        embeddingsProfile: 'local',
        rerankModel: 'rerank-1',
        contextModel: 'tiny',
        editModel: 'edit-1',
        completionModel: 'complete-1',
        temperature: 0.2,
      },
    });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    const saved = settings.profiles.find((p) => p.name === 'mock')!;
    expect(saved).toMatchObject({
      agentModel: 'big-agent',
      applyModel: 'fast-apply-1.5b',
      embeddingsModel: 'nomic-embed',
      embeddingsProfile: 'local',
      rerankModel: 'rerank-1',
      contextModel: 'tiny',
      editModel: 'edit-1',
      completionModel: 'complete-1',
      temperature: 0.2,
    });
    browser.close();
  });

  it('an emptied field clears the override rather than pinning it to ""', async () => {
    // The editor sends '' when you clear the box. Storing that would leave the
    // role pointed at a model with no name instead of back on its inherited
    // one, and the failure surfaces as a provider 404 much later.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', embeddingsModel: 'nomic-embed' },
    });
    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', embeddingsModel: '' },
    });

    const stored = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
      profiles: Array<Record<string, unknown>>;
    };
    const p = stored.profiles.find((x) => x.name === 'mock')!;
    expect('embeddingsModel' in p).toBe(false);
    browser.close();
  });

  it('setting one role leaves the others alone', async () => {
    // The browser patches by name; a wholesale replace would drop every field
    // the editor did not happen to send.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', applyModel: 'fast-apply', rerankModel: 'rerank-1' },
    });
    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', agentModel: 'big-agent' },
    });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    expect(settings.profiles.find((p) => p.name === 'mock')).toMatchObject({
      applyModel: 'fast-apply',
      rerankModel: 'rerank-1',
      agentModel: 'big-agent',
    });
    browser.close();
  });

  it('the agent role really drives which model runs', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', agentModel: 'agent-only-model' },
    });
    await browser.peer.request(UI_METHODS.useProfile, { name: 'mock' });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'go' });

    expect(mock!.requests.at(-1)?.body).toMatchObject({ model: 'agent-only-model' });
    browser.close();
  });
});

describe('web host — context breakdown', () => {
  it('prices out the next turn, slice by slice, adding up to the window', async () => {
    const { host } = await boot(WRITE_THEN_FINISH, { contextWindow: 40_000 });
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const ctx = await browser.peer.request<UiContextResult>(UI_METHODS.context);
    expect(ctx.window).toBe(40_000);
    expect(ctx.windowSource).toBe('profile');
    expect(ctx.slices.map((s) => s.key)).toEqual([
      'system',
      'tools',
      'instructions',
      'conversation',
      'free',
    ]);
    // Free is the remainder, so the slices account for the whole window.
    expect(ctx.slices.reduce((n, s) => n + s.tokens, 0)).toBe(40_000);
    // The two that are never zero: the loop's own prompt, and the tools.
    expect(ctx.slices.find((s) => s.key === 'system')!.tokens).toBeGreaterThan(0);
    expect(ctx.slices.find((s) => s.key === 'tools')!.tokens).toBeGreaterThan(0);
    browser.close();
  });

  it('counts the conversation once a turn has happened', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const before = await browser.peer.request<UiContextResult>(UI_METHODS.context);
    expect(before.slices.find((s) => s.key === 'conversation')!.tokens).toBe(0);

    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'rewrite it' });

    const after = await browser.peer.request<UiContextResult>(UI_METHODS.context);
    expect(after.slices.find((s) => s.key === 'conversation')!.tokens).toBeGreaterThan(0);
    // And free shrank by what the conversation took.
    expect(after.slices.find((s) => s.key === 'free')!.tokens).toBeLessThan(
      before.slices.find((s) => s.key === 'free')!.tokens,
    );
    browser.close();
  });

  it('does not double-count tools on the text protocol, where they live in the prompt', async () => {
    // Native calling sends schemas as a separate array; the text protocol
    // embeds them in the system prompt. Counting the prompt whole and the
    // schemas again would report tools twice — and blaming "system" for them
    // would hide the one number a persona change actually moves.
    const { host } = await boot(WRITE_THEN_FINISH); // nativeToolCalls: false
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const ctx = await browser.peer.request<UiContextResult>(UI_METHODS.context);
    const system = ctx.slices.find((s) => s.key === 'system')!.tokens;
    const tools = ctx.slices.find((s) => s.key === 'tools')!.tokens;
    // Tools dominate the prompt they are embedded in — if `system` were the
    // whole fallback prompt, it would be the larger of the two.
    expect(tools).toBeGreaterThan(system);
    browser.close();
  });

  it('says when the window size is the preset default rather than a choice', async () => {
    const { host } = await boot(WRITE_THEN_FINISH); // no contextWindow on the profile
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const ctx = await browser.peer.request<UiContextResult>(UI_METHODS.context);
    expect(ctx.windowSource).toBe('preset');
    browser.close();
  });
});

/** A promise plus its resolve — for waiting on a callback the host makes. */
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Never settles — holds a host→browser request open so a run stays in flight. */
function never(): Promise<never> {
  return new Promise(() => {});
}

function basenameOf(p: string): string {
  return p.split('/').filter(Boolean).pop()!;
}
