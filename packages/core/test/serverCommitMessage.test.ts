import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HeapcodeServer,
  METHODS,
  PROTOCOL_VERSION,
  RpcPeer,
  type CommitMessageParams,
  type CommitMessageResult,
  type HelloParams,
  type KeyRequestParams,
  type KeyRequestResult,
  type ProviderProfileConfig,
} from '../src/index.js';

/**
 * `git/commitMessage` over a real socket.
 *
 * The one feature on the not-yet-migrated list that was as simple as it
 * looked: a single model call, no tools, no loop, no retry. What is worth
 * pinning is therefore not the loop (there isn't one) but the two things that
 * moved with it — the edit role's assignment, and the fence/quote stripping
 * the extension used to do inline after the call.
 */

interface Endpoint {
  baseUrl: string;
  close(): Promise<void>;
  /** Bodies of each chat request, so the model and prompt can be asserted. */
  requests: Array<{ model?: string; messages?: Array<{ role: string; content: string }> }>;
  /** Reply content the endpoint hands back; set per test. */
  reply: string;
}

async function startEndpoint(): Promise<Endpoint> {
  const state = { reply: '' };
  const requests: Endpoint['requests'] = [];
  const server: HttpServer = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      requests.push(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: state.reply } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    get reply() {
      return state.reply;
    },
    set reply(text: string) {
      state.reply = text;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let home: string;
let server: HeapcodeServer;
let endpoint: Endpoint;
let sockets: Socket[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heapcode-commit-'));
  endpoint = await startEndpoint();
  sockets = [];
  server = new HeapcodeServer({ home, address: join(home, 't.sock'), idleShutdownMs: 0 });
  await server.listen();
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  await server?.close();
  await endpoint?.close();
  await rm(home, { recursive: true, force: true });
});

function profile(extra: Partial<ProviderProfileConfig> = {}): ProviderProfileConfig {
  return { name: 'test', preset: 'custom', baseUrl: endpoint.baseUrl, model: 'chat', ...extra };
}

async function client(
  hello: Partial<HelloParams> = {},
  known: Record<string, KeyRequestResult> = {},
): Promise<{ peer: RpcPeer; askedFor: string[] }> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect(server.address);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  sockets.push(socket);
  const peer = new RpcPeer(socket, 'c');
  const askedFor: string[] = [];
  peer.onRequest(METHODS.keyRequest, async (raw) => {
    const { profileName } = raw as KeyRequestParams;
    askedFor.push(profileName);
    return known[profileName] ?? {};
  });
  await peer.request(METHODS.hello, {
    token: server.token,
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    root: home,
    profiles: [profile()],
    activeProfile: 'test',
    ...hello,
  } satisfies HelloParams);
  return { peer, askedFor };
}

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
].join('\n');

const commitMessage = (peer: RpcPeer, params: CommitMessageParams): Promise<CommitMessageResult> =>
  peer.request<CommitMessageResult>(METHODS.commitMessage, params);

describe('git/commitMessage', () => {
  it('returns a message for a diff, in one model call', async () => {
    endpoint.reply = 'feat: add b';
    const { peer } = await client();

    const result = await commitMessage(peer, { diff: DIFF });

    expect(result.message).toBe('feat: add b');
    expect(endpoint.requests).toHaveLength(1);
  });

  it('sends the diff to the model rather than anything host-shaped', async () => {
    endpoint.reply = 'feat: add b';
    const { peer } = await client();

    await commitMessage(peer, { diff: DIFF });

    const body = endpoint.requests[0]!;
    expect(body.messages!.at(-1)!.content).toContain('+const b = 2;');
    expect(body.messages![0]!.role).toBe('system');
  });

  it('strips a code fence the model wrapped the message in', async () => {
    // Models do this despite the prompt saying not to; the extension used to
    // undo it inline at the call site.
    endpoint.reply = '```\nfix: handle empty input\n```';
    const { peer } = await client();

    expect((await commitMessage(peer, { diff: DIFF })).message).toBe('fix: handle empty input');
  });

  it('strips wrapping quotes', async () => {
    endpoint.reply = '"chore: bump deps"';
    const { peer } = await client();

    expect((await commitMessage(peer, { diff: DIFF })).message).toBe('chore: bump deps');
  });

  it('keeps a subject and body intact', async () => {
    endpoint.reply = 'fix: guard the empty case\n\nA nil diff used to throw before reaching the model.';
    const { peer } = await client();

    const { message } = await commitMessage(peer, { diff: DIFF });

    expect(message).toContain('fix: guard the empty case');
    expect(message).toContain('A nil diff used to throw');
  });

  it('returns an empty message rather than calling the model on an empty diff', async () => {
    const { peer } = await client();

    expect((await commitMessage(peer, { diff: '   \n' })).message).toBe('');
    expect(endpoint.requests).toEqual([]);
  });

  it('uses the model assigned to the edit role', async () => {
    endpoint.reply = 'feat: x';
    const { peer } = await client({
      roles: { chat: { connection: 'test', model: 'chat' }, edit: { connection: 'test', model: 'fast-edit' } },
    });

    await commitMessage(peer, { diff: DIFF });

    expect(endpoint.requests[0]!.model).toBe('fast-edit');
  });

  it('inherits chat when the edit role is unassigned', async () => {
    endpoint.reply = 'feat: x';
    const { peer } = await client();

    await commitMessage(peer, { diff: DIFF });

    expect(endpoint.requests[0]!.model).toBe('chat');
  });

  it('fetches the assignment\'s connection through key/request, like every other role', async () => {
    // The connection an assignment names is never pushed at hello — the hosts
    // send only what chat needs — so this is the ordinary path, not a fallback.
    endpoint.reply = 'feat: x';
    const other = profile({ name: 'writer' });
    const { peer, askedFor } = await client(
      { roles: { chat: { connection: 'test', model: 'chat' }, edit: { connection: 'writer', model: 'writer-model' } } },
      { writer: { profile: other, apiKey: 'k' } },
    );

    await commitMessage(peer, { diff: DIFF });

    expect(askedFor).toEqual(['writer']);
    expect(endpoint.requests[0]!.model).toBe('writer-model');
  });

  it('falls back to the active connection when the host does not know the one named', async () => {
    endpoint.reply = 'feat: x';
    const { peer, askedFor } = await client({
      roles: { chat: { connection: 'test', model: 'chat' }, edit: { connection: 'typo', model: 'ghost' } },
    });

    await commitMessage(peer, { diff: DIFF });

    expect(askedFor).toEqual(['typo']);
    expect(endpoint.requests[0]!.model).toBe('chat');
  });

  it('is cancellable — aborting the request stops waiting on the model', async () => {
    const { peer } = await client();
    const controller = new AbortController();

    const pending = peer.request<CommitMessageResult>(
      METHODS.commitMessage,
      { diff: DIFF } satisfies CommitMessageParams,
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
