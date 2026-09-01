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
  type ApplyMergeResult,
  type HelloParams,
  type ProviderProfileConfig,
} from '../src/index.js';

/**
 * `apply/merge` — edit_file's fallback when search/replace does not match.
 *
 * The contract that matters most is what happens when it *cannot* help. This
 * only ever runs after an edit has already failed, so every unhappy path must
 * come back as "no merge" rather than an error: a rescue attempt has to stay
 * quieter than the failure it was rescuing.
 */

let home: string;
let server: HeapcodeServer;
let mock: MockServer | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heapcode-apply-'));
});

afterEach(async () => {
  await server?.close();
  await mock?.close();
  mock = undefined;
  await rm(home, { recursive: true, force: true });
});

async function boot(reply: string, applyModel?: string): Promise<RpcPeer> {
  // A JSON completion, not SSE: this path uses provider.chat(), which does not
  // stream.
  mock = await startMockServer({
    kind: 'json',
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: reply } }] },
  });
  server = new HeapcodeServer({ home, address: join(home, 'a.sock'), idleShutdownMs: 0 });
  await server.listen();

  const socket = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const s = connect(server.address);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(socket, 'c');
  const profiles: ProviderProfileConfig[] = [
    { name: 'p', preset: 'custom', baseUrl: mock.baseUrl, model: 'chat-model' },
  ];
  await peer.request(METHODS.hello, {
    token: server.token,
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    root: home,
    profiles,
    activeProfile: 'p',
    roles: {
      chat: { connection: 'p', model: 'chat-model' },
      // Apply inherits nothing: unassigned means there is no merge model, not
      // "use the chat model", which would send a general model a format it
      // does not produce.
      ...(applyModel ? { apply: { connection: 'p', model: applyModel } } : {}),
    },
    keys: { p: 'sk-test' },
  } satisfies HelloParams);
  return peer;
}

const FILE = 'function greet() {\n  return "hi";\n}\n';

describe('apply/merge', () => {
  it('returns the merged file the apply model produced', async () => {
    const merged = 'function greet() {\n  return "hello";\n}';
    // The newline hugging each tag is the tag's, not the file's, so
    // extractUpdatedCode strips one from each end.
    const peer = await boot(`<updated-code>\n${merged}\n</updated-code>`, 'fast-apply');
    const res = await peer.request<ApplyMergeResult>(METHODS.applyMerge, {
      original: FILE,
      snippet: 'return "hello";',
    });
    expect(res.merged).toBe(merged);
  });

  it('calls the apply model, not the chat model', async () => {
    const peer = await boot('<updated-code>x</updated-code>', 'fast-apply');
    await peer.request(METHODS.applyMerge, { original: FILE, snippet: 'x' });
    expect(mock!.requests.at(-1)?.body).toMatchObject({ model: 'fast-apply' });
  });

  it('says nothing, and spends no model call, when no apply model is set', async () => {
    // Most setups have none. The caller then reports the edit that did not
    // apply, exactly as it did before this method existed.
    const peer = await boot('<updated-code>x</updated-code>');
    const res = await peer.request<ApplyMergeResult>(METHODS.applyMerge, { original: FILE, snippet: 'x' });
    expect(res.merged).toBeUndefined();
    expect(mock!.requests).toHaveLength(0);
  });

  it('says nothing when the model answers with prose instead of code', async () => {
    const peer = await boot('I would put it after the return statement.', 'fast-apply');
    const res = await peer.request<ApplyMergeResult>(METHODS.applyMerge, { original: FILE, snippet: 'x' });
    expect(res.merged).toBeUndefined();
  });

  it('accepts a bare code fence when the tags are missing', async () => {
    // Small models drop the <updated-code> wrapper often enough to be worth
    // catching, and a fenced block is unambiguous enough to trust.
    const peer = await boot('```\nmerged body\n```', 'fast-apply');
    const res = await peer.request<ApplyMergeResult>(METHODS.applyMerge, { original: FILE, snippet: 'x' });
    expect(res.merged).toContain('merged body');
  });

  it('says nothing for an empty request rather than calling the model', async () => {
    const peer = await boot('<updated-code>x</updated-code>', 'fast-apply');
    expect((await peer.request<ApplyMergeResult>(METHODS.applyMerge, { original: '', snippet: 'x' })).merged)
      .toBeUndefined();
    expect((await peer.request<ApplyMergeResult>(METHODS.applyMerge, { original: FILE, snippet: ' ' })).merged)
      .toBeUndefined();
    expect(mock!.requests).toHaveLength(0);
  });
});
