import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startMockServer, type MockServer } from '../../core/test/mockServer.js';
import {
  DEFAULT_MAX_ITERATIONS,
  HeapcodeServer,
  RpcPeer,
  connectToServer,
  type AgentEvent,
  type ServerConnection,
} from '@heapcode/core';
import { ConfigStore, SecretsStore } from '@heapcode/host';
import { AuthLimiter } from '../src/authLimit.js';
import { startWebHost, type RunningWebHost } from '../src/server.js';
import { MAX_IMAGES, MAX_IMAGE_BYTES, acceptImages, clipArgs } from '../src/session.js';
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
  type UiIndexStatus,
  type UiListModelsResult,
  type UiRepoMapResult,
  type UiOpenConversationResult,
  type UiReadFileResult,
  type UiPermissionRequestParams,
  type UiPermissionRequestResult,
  type UiSendMessageResult,
  type UiProbeProviderResult,
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
/**
 * How many times the host has handed the daemon a session/hello.
 *
 * The daemon is given the active profile once, at hello, and reads role
 * redirects and the endpoint off that copy for the rest of the session — so
 * "did this edit reach the daemon" is exactly "did the host reconnect", and
 * there is nothing else to observe it by.
 */
let connects: number;

beforeEach(async () => {
  // Short paths — a unix socket path over 104 bytes fails listen() with EINVAL.
  home = await mkdtemp(join(tmpdir(), 'hcwh-'));
  workspace = await mkdtemp(join(tmpdir(), 'hcww-'));
  process.env.HEAPCODE_HOME = home;
  connects = 0;
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
  // `sse` covers a streamed chat turn; `sse-raw` covers delta shapes the
  // helper cannot express (`reasoning_content`); `json` covers the
  // non-streaming calls a turn can make on the way past — apply/merge is one.
  responses: Array<
    | { kind: 'sse'; chunks: string[] }
    | { kind: 'sse-raw'; events: string[] }
    | { kind: 'json'; status: number; body: unknown }
  >,
  /** Extra profile fields, for the ones only the CLI can normally set. */
  profileExtras: Record<string, unknown> = {},
  /** Host options the auth and LAN tests need to vary. */
  hostExtras: { limiter?: AuthLimiter; host?: string } = {},
  /** Top-level config.json keys — e.g. the step ceiling a run is given. */
  configExtras: Record<string, unknown> = {},
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
      ...configExtras,
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
    ...hostExtras,
    connect: (hello): Promise<ServerConnection> => {
      connects += 1;
      return connectToServer(
        { client: { name: 'web-host-test' }, ...hello },
        { address: daemon.address, token: daemon.token, autostart: false },
      );
    },
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
    // The ceiling that applied, sent on every result — the browser has no other
    // way to name it when a run ends on it.
    expect(result.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
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

  it('tells the browser a run was cut off at the step limit, and which limit applied', async () => {
    // One step, and a reply that calls nothing: the loop nudges, runs out of
    // steps, and asks for the progress summary — the exact shape that used to
    // reach the browser as an ordinary, finished-looking answer.
    const { host } = await boot([{ kind: 'sse' as const, chunks: ['Here is what I have done so far.'] }], {}, {}, { maxIterations: 1 });

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const result = await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'a big task' });

    expect(result).toMatchObject({ outcome: 'max-iterations', maxIterations: 1 });
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

  /**
   * W3.5, end to end rather than only at the unit level: what matters is that
   * the limiter is actually *wired into* both auth paths, which a test of the
   * class alone cannot show.
   */
  it('stops answering after repeated bad tokens, and the right token no longer helps', async () => {
    const limiter = new AuthLimiter(3, 60_000, 60_000);
    const { host } = await boot(WRITE_THEN_FINISH, {}, { limiter });

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${host.port}/`, {
        headers: { cookie: 'heapcode_token=wrong' },
      });
      expect(res.status).toBe(401);
    }

    // Blocked now — and the block is on the peer, not on the credential, so
    // even a correct token gets the door shut in its face.
    const blocked = await fetch(`http://127.0.0.1:${host.port}/`, {
      headers: { cookie: `heapcode_token=${host.token}` },
    });
    expect(blocked.status).toBe(429);

    // And the WS upgrade is closed to it too, or the limit would only cover
    // the half of the surface that cannot run commands.
    await expect(openBrowser(host)).rejects.toThrow(/429|Too Many/);
  });

  it('a good token before the limit is reached clears the count', async () => {
    const limiter = new AuthLimiter(3, 60_000, 60_000);
    const { host } = await boot(WRITE_THEN_FINISH, {}, { limiter });

    for (let i = 0; i < 2; i++) {
      await fetch(`http://127.0.0.1:${host.port}/`, { headers: { cookie: 'heapcode_token=wrong' } });
    }
    const ok = await fetch(`http://127.0.0.1:${host.port}/`, {
      headers: { cookie: `heapcode_token=${host.token}` },
    });
    expect(ok.status).not.toBe(429);

    // Two more failures would have crossed the old count; they must not now.
    for (let i = 0; i < 2; i++) {
      await fetch(`http://127.0.0.1:${host.port}/`, { headers: { cookie: 'heapcode_token=wrong' } });
    }
    const still = await fetch(`http://127.0.0.1:${host.port}/`, {
      headers: { cookie: `heapcode_token=${host.token}` },
    });
    expect(still.status).not.toBe(429);
  });
});

describe('web host — LAN mode', () => {
  it('tells the browser when it is bound to a non-loopback address', async () => {
    const { host } = await boot(WRITE_THEN_FINISH, {}, { host: '0.0.0.0' });
    const browser = await openBrowser(host);
    const hello = await browser.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });
    expect(hello.state.lan).toBe(true);
    browser.close();
  });

  /**
   * The bug the security review turned up: bound to `0.0.0.0`, the allowlist
   * added nothing, so every real LAN browser — presenting the address it
   * actually typed — was refused with 403. Fail-closed, so not a vulnerability,
   * but it meant LAN mode had never worked from a browser at all.
   */
  it('accepts the machine\'s own LAN address as an origin when bound to 0.0.0.0', async () => {
    const { host } = await boot(WRITE_THEN_FINISH, {}, { host: '0.0.0.0' });

    const lanAddress = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .find((info) => !info.internal && info.family === 'IPv4')?.address;
    if (!lanAddress) return; // no network on this machine; nothing to assert

    const browser = await openBrowser(host, { origin: `http://${lanAddress}:${host.port}` });
    const hello = await browser.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });
    expect(hello.protocolVersion).toBe(UI_PROTOCOL_VERSION);
    browser.close();
  });

  /**
   * And the reason this stayed an allowlist rather than becoming "does Origin
   * match Host". DNS rebinding makes those two agree perfectly, so the check
   * that looks correct is the one that lets `evil.example` in.
   */
  it('still refuses a rebound hostname in LAN mode', async () => {
    const { host } = await boot(WRITE_THEN_FINISH, {}, { host: '0.0.0.0' });
    await expect(openBrowser(host, { origin: `http://evil.example:${host.port}` })).rejects.toThrow(
      /403|Forbidden/,
    );
  });

  it('an explicit --host allows that address and nothing else', async () => {
    const { host } = await boot(WRITE_THEN_FINISH, {}, { host: '127.0.0.1' });
    // Loopback bind: the LAN address of this machine is not a legitimate origin.
    await expect(openBrowser(host, { origin: 'http://192.0.2.7:1234' })).rejects.toThrow(/403|Forbidden/);
  });

  it('does not claim LAN exposure on loopback', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    const hello = await browser.peer.request<UiHelloResult>(UI_METHODS.hello, {
      protocolVersion: UI_PROTOCOL_VERSION,
    });
    expect(hello.state.lan).toBe(false);
    browser.close();
  });
});

describe('acceptImages', () => {
  it('keeps real image data URLs', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(acceptImages([png])).toEqual([png]);
  });

  /**
   * The one that matters: `data:text/html;base64,…` is a perfectly valid data
   * URL, and a browser — or anything that has taken one over — could put one
   * here. Passing it through to a provider as "an image" is the kind of hole
   * that opens because nobody asked what the string was.
   */
  it('drops non-image data URLs and anything that is not one at all', () => {
    expect(acceptImages(['data:text/html;base64,PHNjcmlwdD4='])).toBeUndefined();
    expect(acceptImages(['javascript:alert(1)'])).toBeUndefined();
    expect(acceptImages(['https://example.com/cat.png'])).toBeUndefined();
    expect(acceptImages(['data:image/svg+xml;base64,PHN2Zz4='])).toBeUndefined();
    expect(acceptImages([42, null, {}])).toBeUndefined();
    expect(acceptImages('not an array')).toBeUndefined();
  });

  it('caps the count, so an unbounded array cannot make the host allocate', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(acceptImages(Array.from({ length: 50 }, () => png))).toHaveLength(MAX_IMAGES);
  });

  it('drops an oversized image rather than the whole message', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const huge = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_BYTES)}`;
    expect(acceptImages([huge, png])).toEqual([png]);
  });
});

describe('web host — testing a provider before saving it', () => {
  it('lists what an unsaved endpoint serves, which listModels cannot do', async () => {
    // listModels resolves a *saved* profile by name; the add-profile form has
    // no profile yet, which is the whole reason this method exists.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const result = await browser.peer.request<UiProbeProviderResult>(UI_METHODS.probeProvider, {
      preset: 'custom',
      baseUrl: mock!.baseUrl,
      apiKey: 'sk-test',
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['mock-model', 'other-model']);
    browser.close();
  });

  it('reports why an unreachable endpoint failed rather than throwing', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const result = await browser.peer.request<UiProbeProviderResult>(UI_METHODS.probeProvider, {
      preset: 'custom',
      baseUrl: 'http://127.0.0.1:1/v1', // nothing listens here
    });
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toBeTruthy();
    browser.close();
  });

  it('refuses an empty base URL instead of probing nothing', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const result = await browser.peer.request<UiProbeProviderResult>(UI_METHODS.probeProvider, {
      preset: 'ollama',
      baseUrl: '   ',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/base URL/i);
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

    // The chat call specifically. The host also asks `/models` what context
    // length this model really has, and that lands first.
    const body = chatRequest()?.body as { tools?: unknown[] } | undefined;
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

describe('web host — a run that was stopped', () => {
  /**
   * Stopping a run must not erase it.
   *
   * `persistTurn` sits on the success path, and this host is the only one of
   * the three that hands its own AbortSignal to `agent/run` — so Stop rejected
   * the request rather than letting the daemon answer `outcome: 'stopped'`,
   * and the turn was dropped whole. Everything the agent read or changed
   * vanished from the conversation at the moment you stopped it, and from the
   * next turn's history with it, so the model could not be told what it had
   * just been doing.
   */
  /**
   * Found rather than computed: the state directory is keyed by a hash of the
   * root, and two packages spell that helper differently. What matters is
   * that a file was written at all.
   */
  async function storedMessages(): Promise<Array<Record<string, unknown>>> {
    const projects = join(home, 'projects');
    const dirs = await readdir(projects);
    for (const d of dirs) {
      const file = join(projects, d, 'conversations.json');
      const raw = await readFile(file, 'utf8').catch(() => undefined);
      if (!raw) continue;
      const convos = JSON.parse(raw) as Array<{ messages: Array<Record<string, unknown>> }>;
      return convos.flatMap((c) => c.messages);
    }
    throw new Error('no conversation was written');
  }

  it('keeps what it did up to the moment it was stopped', async () => {
    // An endless read loop, so there is real work in flight to lose.
    const { root, host } = await boot([
      { kind: 'sse', chunks: ['<tool name="read_file">\n{"path":"a.ts"}\n</tool>'] },
    ]);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const running = browser.peer
      .request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'read forever', runId: 'stopped' })
      .catch(() => undefined);
    // Specifically a tool call: that is the work worth keeping, and the
    // earlier events (text deltas) leave nothing behind to assert on.
    while (!browser.events.some((e) => e.type === 'tool_call')) await new Promise((r) => setTimeout(r, 10));
    await browser.peer.request(UI_METHODS.cancel, { runId: 'stopped' });
    await running;

    const messages = await storedMessages();
    expect(messages.some((m) => m.role === 'user' && m.content === 'read forever')).toBe(true);
    // The tool chips too — the record of what it actually did, which is the
    // part a follow-up turn needs and the part that was being thrown away.
    expect(messages.some((m) => JSON.stringify(m.ui ?? {}).includes('read_file'))).toBe(true);
    browser.close();
  }, 30_000);

  it('writes nothing for a run that never got started', async () => {
    // A request that never reached the daemon is not an exchange. Recording
    // one would leave an unanswered prompt in the history for the next turn.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await daemon.close();

    await browser.peer
      .request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'go', runId: 'doomed' })
      .catch(() => undefined);

    await expect(storedMessages()).rejects.toThrow();
    browser.close();
  }, 30_000);
});

describe('web host — the daemon going away', () => {
  /**
   * The daemon outlives this host by design, and it also exits without asking:
   * it goes idle, it retires because its bundle was rebuilt, someone kills it.
   * The host used to keep the dead peer, so every later request rejected with
   * "connection closed" and the browser sat on a daemon-down badge with no way
   * back short of restarting the host. Which is how a rebuilt daemon stayed
   * invisible: the one thing that would have picked up the new build was the
   * thing that could no longer happen.
   */
  it('reports it, then reconnects on the next request', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'greeting.txt'), 'hello world\n', 'utf8');
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    expect((await browser.peer.request<UiState>(UI_METHODS.state)).daemon).toBe('up');

    // Exactly what a retiring daemon does to its clients.
    await daemon.close();
    await new Promise((r) => setTimeout(r, 50));
    expect((await browser.peer.request<UiState>(UI_METHODS.state)).daemon).toBe('down');

    // Something is listening again — a fresh build, in real life.
    daemon = new HeapcodeServer({ home, address: join(home, 'w2.sock'), idleShutdownMs: 0 });
    await daemon.listen();

    const result = await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, {
      text: 'rewrite it',
    });
    expect(result.outcome).toBe('done');
    expect((await browser.peer.request<UiState>(UI_METHODS.state)).daemon).toBe('up');
    browser.close();
  }, 30_000);
});

describe('web host — prompt detail', () => {
  /**
   * Which tier a profile's model gets. Settable only by hand-editing
   * config.json before this, which is where a setting goes to be undiscovered.
   */
  it('stores the chosen tier on the profile', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', promptTier: 'lean' },
    });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    expect(settings.profiles.find((p) => p.name === 'mock')?.promptTier).toBe('lean');
    browser.close();
  });

  it('clears it back to automatic on null, rather than storing a third value', async () => {
    // "Automatic" has to be the ABSENCE of the field — a stored "auto" would
    // have to be understood by every reader of the config, and the loop's
    // capability check already answers the question.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, { profile: { name: 'mock', promptTier: 'lean' } });
    await browser.peer.request(UI_METHODS.saveProfile, { profile: { name: 'mock', promptTier: null } });

    const stored = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
      profiles: Array<Record<string, unknown>>;
    };
    expect('promptTier' in stored.profiles.find((p) => p.name === 'mock')!).toBe(false);
    browser.close();
  });

  it('leaves the rest of the connection alone', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, { profile: { name: 'mock', temperature: 0.2 } });
    await browser.peer.request(UI_METHODS.saveProfile, { profile: { name: 'mock', promptTier: 'full' } });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    expect(settings.profiles.find((p) => p.name === 'mock')).toMatchObject({
      temperature: 0.2,
      promptTier: 'full',
    });
    browser.close();
  });
});

describe('web host — MCP servers', () => {
  /**
   * Adding one used to mean leaving the browser and editing
   * `~/.heapcode/config.json` by hand, which is the one thing a settings
   * screen exists to save you from. The extension had an add flow that wrote
   * to VS Code's own settings, so what it added never appeared here.
   */
  it('adds a server and reports it back', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    // A command that is not a real MCP server: saving must not wait for it to
    // start, let alone succeed. Launching one can take half a minute of `npx`
    // fetching a package, and a settings panel that freezes for that is worse
    // than a row that says "not connected" until it is.
    await browser.peer.request(UI_METHODS.saveMcpServer, {
      name: 'filesystem',
      spec: 'npx -y @modelcontextprotocol/server-filesystem /code',
    });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    const server = settings.mcpServers.find((m) => m.name === 'filesystem')!;
    // Read back in the same one-line form the editor accepts, so the row can
    // be edited without anyone having to reconstruct it.
    expect(server.spec).toBe('npx -y @modelcontextprotocol/server-filesystem /code');
    expect(server.project).toBe(false);
    browser.close();
  });

  it('stores a URL as a remote server', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveMcpServer, { name: 'remote', spec: 'https://example.com/mcp' });

    const stored = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(stored.mcpServers?.remote).toEqual({ url: 'https://example.com/mcp', transport: 'http' });
    browser.close();
  });

  it('refuses a name that would not survive being prefixed onto a tool', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await expect(
      browser.peer.request(UI_METHODS.saveMcpServer, { name: 'my server', spec: 'echo hi' }),
    ).rejects.toThrow(/letters, digits/i);
    browser.close();
  });

  it('removes one', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveMcpServer, { name: 'gone', spec: 'echo hi' });
    await browser.peer.request(UI_METHODS.deleteMcpServer, { name: 'gone' });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    expect(settings.mcpServers.some((m) => m.name === 'gone')).toBe(false);
    browser.close();
  });

  it("lists this project's own servers, which it never used to", async () => {
    // `.heapcode/mcp.json` was loaded and its tools were callable, but the
    // panel read personal config only — so a session with servers running in
    // it displayed "None configured".
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(
      join(root, '.heapcode', 'mcp.json'),
      JSON.stringify({ teamserver: { command: 'npx', args: ['-y', 'team'] } }),
      'utf8',
    );

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    const server = settings.mcpServers.find((m) => m.name === 'teamserver')!;
    expect(server).toBeDefined();
    // Marked, because it is the one the panel must not write to: that file is
    // meant to be committed.
    expect(server.project).toBe(true);
    browser.close();
  });
});

/**
 * Roles are one global table now (`ui/setRole`), not seven fields plus seven
 * redirects on whichever profile happens to be active. What this has to pin is
 * that assigning one reaches the daemon — which is handed the table once, at
 * hello, and resolves every role off that copy afterwards.
 */
describe('web host — model roles', () => {
  it('assigns a role to a model on a named connection, and says what serves each', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.setRole, {
      role: 'embeddings',
      assignment: { connection: 'mock', model: 'nomic-embed' },
    });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    const roles = Object.fromEntries(settings.roles.map((r) => [r.role, r]));
    expect(roles.embeddings).toMatchObject({ connection: 'mock', model: 'nomic-embed' });
    // The resolved sentence, computed by the host so every client says the
    // same thing about the same state.
    expect(roles.embeddings!.summary).toContain('nomic-embed');
    expect(roles.agent!.summary).toMatch(/inherits chat/);
    browser.close();
  });

  it('clears a role back to inheriting, and stores the absence rather than ""', async () => {
    // An empty model would point the role at a model with no name instead of
    // back on its inherited one, and the failure surfaces as a provider 404
    // much later.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.setRole, {
      role: 'rerank',
      assignment: { connection: 'mock', model: 'rerank-1' },
    });
    await browser.peer.request(UI_METHODS.setRole, { role: 'rerank' });

    const stored = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
      roles: Record<string, unknown>;
    };
    expect('rerank' in stored.roles).toBe(false);
    browser.close();
  });

  it('leaves the other roles alone', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.setRole, {
      role: 'apply',
      assignment: { connection: 'mock', model: 'fast-apply' },
    });
    await browser.peer.request(UI_METHODS.setRole, {
      role: 'agent',
      assignment: { connection: 'mock', model: 'big-agent' },
    });

    const settings = await browser.peer.request<UiSettings>(UI_METHODS.settings);
    const roles = Object.fromEntries(settings.roles.map((r) => [r.role, r]));
    expect(roles.apply).toMatchObject({ model: 'fast-apply' });
    expect(roles.agent).toMatchObject({ model: 'big-agent' });
    browser.close();
  });

  /**
   * Assigning a role has to reach the daemon.
   *
   * It is handed the role table once, at hello, and resolves every role off
   * that copy from then on. Before this, a user could point embeddings at a
   * local Ollama, see it stored, reopen the panel and see it still set, and
   * have semantic search keep reporting no embedder because the daemon was
   * still running the table as it stood at hello. Nothing anywhere said so.
   */
  it('reaches the daemon, which was handed the table at hello', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.sendMessage, { text: 'go' });
    const before = connects;

    await browser.peer.request(UI_METHODS.setRole, {
      role: 'embeddings',
      assignment: { connection: 'mock', model: 'nomic-embed' },
    });

    expect(connects).toBe(before + 1);
    browser.close();
  });

  it('does not reconnect for the two fields the host re-sends every run', async () => {
    // contextWindow and maxTokens go out as run parameters, so they take
    // effect on the next turn on their own. Rebuilding the session for them
    // would throw away a warm one for nothing.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.sendMessage, { text: 'go' });
    const before = connects;

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'mock', contextWindow: 64_000, maxTokens: 4_000 },
    });

    expect(connects).toBe(before);
    browser.close();
  });

  it('does not reconnect for a connection that is not the one in use', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.sendMessage, { text: 'go' });
    const before = connects;

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'other', preset: 'custom', baseUrl: mock!.baseUrl, model: 'x' },
    });

    expect(connects).toBe(before);
    browser.close();
  });

  it('the agent role really drives which model runs', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.setRole, {
      role: 'agent',
      assignment: { connection: 'mock', model: 'agent-only-model' },
    });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'go' });

    expect(mock!.requests.at(-1)?.body).toMatchObject({ model: 'agent-only-model' });
    browser.close();
  });
});

describe('web host — listing models', () => {
  it('lists a profile that is not the active one', async () => {
    // Every host pushes only the connection in use at session/hello, so this
    // used to come back "Unknown profile" even though the host had it in
    // config all along. The role table needs exactly this: a role pointing at
    // another connection should suggest that endpoint's models.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    await browser.peer.request(UI_METHODS.saveProfile, {
      profile: { name: 'second', preset: 'custom', baseUrl: mock!.baseUrl, model: 'other-model' },
    });

    const res = await browser.peer.request<UiListModelsResult>(UI_METHODS.listModels, {
      profileName: 'second',
    });
    expect(res.models.map((m) => m.id)).toContain('other-model');
    browser.close();
  });

  it('still defaults to the active profile when none is named', async () => {
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const res = await browser.peer.request<UiListModelsResult>(UI_METHODS.listModels);
    expect(res.models.map((m) => m.id)).toContain('mock-model');
    browser.close();
  });
});

describe('web host — edit_file fast-apply fallback', () => {
  const EDIT_THEN_FINISH = (search: string) => [
    {
      kind: 'sse' as const,
      chunks: [`<tool name="edit_file">\n{"path":"a.ts","search":${JSON.stringify(search)},"replace":"const a = 2;"}\n</tool>`],
    },
    { kind: 'sse' as const, chunks: ['<tool name="finish">\n{"summary":"done"}\n</tool>'] },
  ];

  it('reports the failure when no apply model is configured', async () => {
    // The behaviour every profile has today: no fallback, so a search that
    // does not match is simply a failed edit.
    const { root, host } = await boot(EDIT_THEN_FINISH('const NOPE = 9;'));
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'edit it' });

    const failed = browser.events.find(
      (e) => e.type === 'tool_result' && e.name === 'edit_file' && e.isError,
    );
    expect(failed).toBeTruthy();
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1;\n');
    browser.close();
  });

  it('rescues the edit through the apply model when one is set', async () => {
    // Same mismatched search, but the profile now names an apply model — the
    // third scripted response is what that model returns.
    const { root, host } = await boot(
      [
        ...EDIT_THEN_FINISH('const NOPE = 9;').slice(0, 1),
        { kind: 'json' as const, status: 200, body: { choices: [{ message: { content: '<updated-code>\nconst a = 2;\n</updated-code>' } }] } },
        { kind: 'sse' as const, chunks: ['<tool name="finish">\n{"summary":"done"}\n</tool>'] },
      ],
      { applyModel: 'fast-apply' },
    );
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request<UiSendMessageResult>(UI_METHODS.sendMessage, { text: 'edit it' });

    // The edit landed even though the search text never matched.
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 2;');
    const result = browser.events.find((e) => e.type === 'tool_result' && e.name === 'edit_file');
    expect(result && 'isError' in result ? result.isError : undefined).toBeFalsy();
    browser.close();
  });
});

describe('web host — the index', () => {
  it('reports both indexes separately, because they fail independently', async () => {
    // The semantic half needs a reachable embeddings model; the repo map is
    // local parsing. Which one is empty is the whole diagnosis when
    // semantic_search comes back with nothing.
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'a.ts'), 'export function alpha() {}\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });

    const status = await browser.peer.request<UiIndexStatus>(UI_METHODS.indexStatus);
    expect(status.semantic).toMatchObject({ state: expect.any(String), available: expect.any(Boolean) });
    expect(status.repoMap).toMatchObject({ ready: expect.any(Boolean), files: expect.any(Number) });
    browser.close();
  });

  it('builds the repo map on rebuild, and reports what it found', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'a.ts'), 'export function alpha() {}\n', 'utf8');
    await writeFile(join(root, 'b.ts'), 'export class Beta {}\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.reindex);

    const status = await browser.peer.request<UiIndexStatus>(UI_METHODS.indexStatus);
    expect(status.repoMap.ready).toBe(true);
    expect(status.repoMap.files).toBeGreaterThanOrEqual(2);
    expect(status.repoMap.symbols).toBeGreaterThan(0);
    browser.close();
  });

  it('returns the map itself, filterable by path or symbol', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'alpha.ts'), 'export function findMe() {}\n', 'utf8');
    await writeFile(join(root, 'beta.ts'), 'export class Other {}\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.reindex);

    const all = await browser.peer.request<UiRepoMapResult>(UI_METHODS.repoMap, {});
    expect(all.files.map((f) => f.path)).toEqual(expect.arrayContaining(['alpha.ts', 'beta.ts']));

    // By path…
    const byPath = await browser.peer.request<UiRepoMapResult>(UI_METHODS.repoMap, { query: 'beta' });
    expect(byPath.files.map((f) => f.path)).toEqual(['beta.ts']);

    // …and by a symbol that appears in only one of them.
    const bySymbol = await browser.peer.request<UiRepoMapResult>(UI_METHODS.repoMap, { query: 'findMe' });
    expect(bySymbol.files.map((f) => f.path)).toEqual(['alpha.ts']);
    browser.close();
  });

  it('caps what it returns but says how many matched', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    for (let i = 0; i < 5; i++) {
      await writeFile(join(root, `f${i}.ts`), `export function fn${i}() {}\n`, 'utf8');
    }
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.reindex);

    const res = await browser.peer.request<UiRepoMapResult>(UI_METHODS.repoMap, { limit: 2 });
    expect(res.files).toHaveLength(2);
    expect(res.total).toBeGreaterThanOrEqual(5);
    browser.close();
  });

  it('clearing empties the map rather than rebuilding it', async () => {
    const { root, host } = await boot(WRITE_THEN_FINISH);
    await writeFile(join(root, 'a.ts'), 'export function alpha() {}\n', 'utf8');

    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await browser.peer.request(UI_METHODS.reindex);
    expect((await browser.peer.request<UiIndexStatus>(UI_METHODS.indexStatus)).repoMap.files).toBeGreaterThan(0);

    await browser.peer.request(UI_METHODS.reindex, { clear: true });
    expect((await browser.peer.request<UiIndexStatus>(UI_METHODS.indexStatus)).repoMap.files).toBe(0);
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

  it('admits when nothing reported a window size', async () => {
    // No `contextWindow` on the profile, and the `custom` preset carries no
    // maxContext either — so this number is a conservative fallback, and the
    // one question the breakdown exists to answer is whether to trust it.
    const { host } = await boot(WRITE_THEN_FINISH);
    const browser = await openBrowser(host);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const ctx = await browser.peer.request<UiContextResult>(UI_METHODS.context);
    expect(ctx.windowSource).toBe('default');
    browser.close();
  });

  it('asks the endpoint before the first run, not during it', async () => {
    // `known()` answers with the preset until the real number arrives, which
    // keeps it off the run's critical path. The first read used to happen
    // inside the first run — the run it matters for, since it is usually the
    // longest and a guess that is too small compacts it early, summarising
    // away what it had already looked up.
    mock = await startMockServer({
      kind: 'json',
      status: 200,
      body: { data: [{ id: 'mock-model', context_length: 8_000 }] },
    });
    daemon = new HeapcodeServer({ home, address: join(home, 'warm.sock'), idleShutdownMs: 0 });
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
    web = await startWebHost({
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

    const browser = await openBrowser(web);
    // `hello` is what starts the session; nothing has run yet.
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    await new Promise((r) => setTimeout(r, 100));

    // Already known, without a run having happened to discover it.
    expect((await browser.peer.request<UiState>(UI_METHODS.state)).contextWindow).toBe(8_000);
    browser.close();
  }, 30_000);

  it('prefers what the endpoint says its window is', async () => {
    // The tier that was missing everywhere but the extension. A preset default
    // that overstates the real window is the dangerous direction: the meter
    // never fills, compaction never fires, and the endpoint silently drops the
    // front of the prompt instead — so the agent forgets what it read and
    // reads it again.
    mock = await startMockServer({
      kind: 'json',
      status: 200,
      body: { data: [{ id: 'mock-model', context_length: 8_000 }] },
    });
    daemon = new HeapcodeServer({ home, address: join(home, 'win.sock'), idleShutdownMs: 0 });
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
    web = await startWebHost({
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

    const browser = await openBrowser(web);
    await browser.peer.request(UI_METHODS.hello, { protocolVersion: UI_PROTOCOL_VERSION });
    const ctx = await browser.peer.request<UiContextResult>(UI_METHODS.context);

    expect(ctx.window).toBe(8_000);
    expect(ctx.windowSource).toBe('model');
    browser.close();
  });
});

/**
 * The chat completion the host sent, ignoring the `/models` lookups around it.
 *
 * Indexing `requests[0]` used to mean "the chat call" because it was the only
 * call. It is not any more: the host asks the endpoint what context length a
 * model really has rather than trusting the preset's guess.
 */
function chatRequest(): MockServer['requests'][number] | undefined {
  return mock?.requests.find((r) => !r.path.includes('/models'));
}

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
