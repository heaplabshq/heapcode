import { createRequire } from 'node:module';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunkFile,
  configureAstChunker,
  enableAstChunking,
  HeapcodeServer,
  METHODS,
  PROTOCOL_VERSION,
  projectStateDir,
  RAG_INDEX_FILE,
  RpcPeer,
  type HelloParams,
  type ProviderProfileConfig,
  type RagEventParams,
  type RagIndexParams,
  type RagIndexResult,
  type RagQueryParams,
  type RagQueryResult,
  type RagStatusResult,
  type ToolDefinition,
} from '../src/index.js';

/**
 * The RAG migration end-to-end: docs/phase3-rag-design.md's recommendation,
 * over a real unix socket with a real HTTP model endpoint.
 *
 * The claims worth holding onto, and the ones these tests are built around:
 *
 * - No vector ever crosses the wire. Not "unused by the caller" — literally
 *   absent from the NDJSON bytes, which is what made the serialization
 *   question dissolve (§2.3) rather than need base64 or a sideband.
 * - The daemon's AST chunker actually landed (prerequisite 1). A server that
 *   fell back to line-window chunking would re-embed every workspace silently,
 *   so a server-built index and a host-built one must agree on boundaries.
 * - The four toggles stay host policy, passed per request (decision 6).
 */

const require = createRequire(import.meta.url);
const WASM_DIR = join(tmpdir(), 'heapcode-serverrag-wasm');

interface Endpoint {
  baseUrl: string;
  close(): Promise<void>;
  embeddingBatches: string[][];
  /** Non-streaming chat bodies — contextual retrieval and rerank both land here. */
  chatCalls: Array<{ role: string; content: string }[]>;
  /** Scripted streamed replies for agent turns; the last one repeats. */
  script: string[];
  /** Per-embeddings-request delay, so a build can be caught mid-flight. */
  delayMs: number;
}

/** Path-aware OpenAI-compatible fake: embeddings as JSON, chat as an empty reply. */
async function startEndpoint(): Promise<Endpoint> {
  const state = { delayMs: 0 };
  const embeddingBatches: string[][] = [];
  const chatCalls: Array<{ role: string; content: string }[]> = [];
  const script: string[] = [''];
  let turn = 0;
  const server: HttpServer = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw
        ? (JSON.parse(raw) as { input?: string[]; stream?: boolean; messages?: Array<{ role: string; content: string }> })
        : {};
      const respond = (): void => {
        if (req.url?.includes('/embeddings')) {
          const input = body.input ?? [];
          embeddingBatches.push(input);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: input.map((_, i) => ({ embedding: [1, 0, 0], index: i })) }));
          return;
        }
        if (body.stream === true) {
          // An agent turn. Streamed, so it is told apart from the
          // non-streaming chat that contextual retrieval and rerank use.
          const text = script[Math.min(turn++, script.length - 1)] ?? '';
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        chatCalls.push(body.messages ?? []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
      };
      if (req.url?.includes('/embeddings') && state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    embeddingBatches,
    chatCalls,
    script,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(ms: number) {
      state.delayMs = ms;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let root: string;
let home: string;
let server: HeapcodeServer;
let endpoint: Endpoint;
let sockets: Socket[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-srag-ws-'));
  home = await mkdtemp(join(tmpdir(), 'heapcode-srag-home-'));
  vi.stubEnv('HEAPCODE_HOME', home);
  endpoint = await startEndpoint();
  sockets = [];
  server = new HeapcodeServer({ home, address: join(home, 't.sock'), idleShutdownMs: 0 });
  await server.listen();
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  await server?.close();
  await endpoint?.close();
  configureAstChunker(undefined);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function profile(extra: Partial<ProviderProfileConfig> = {}): ProviderProfileConfig {
  return { name: 'test', preset: 'custom', baseUrl: endpoint.baseUrl, model: 'chat', ...extra };
}

async function rawSocket(): Promise<Socket> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect(server.address);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  sockets.push(socket);
  return socket;
}

async function client(hello: Partial<HelloParams> = {}): Promise<RpcPeer> {
  const peer = new RpcPeer(await rawSocket(), 'c');
  await peer.request(METHODS.hello, {
    token: server.token,
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    root,
    profiles: [profile()],
    activeProfile: 'test',
    roles: { chat: { connection: 'test', model: 'chat' }, embeddings: { connection: 'test', model: 'embed' } },
    ...hello,
  } satisfies HelloParams);
  return peer;
}

const CORPUS: Array<[string, string]> = [
  ['auth.ts', 'export function authenticateUser(token: string) {\n  return verifySession(token);\n}\n'],
  ['billing.ts', 'export function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}\n'],
  ['cache.ts', 'export function memoize(fn: () => number) {\n  return fn;\n}\n'],
];

async function writeCorpus(): Promise<void> {
  for (const [name, body] of CORPUS) await writeFile(join(root, name), body);
}

const index = (peer: RpcPeer, params: RagIndexParams): Promise<RagIndexResult> =>
  peer.request<RagIndexResult>(METHODS.ragIndex, params);
const query = (peer: RpcPeer, params: RagQueryParams): Promise<RagQueryResult> =>
  peer.request<RagQueryResult>(METHODS.ragQuery, params);
const status = (peer: RpcPeer): Promise<RagStatusResult> => peer.request<RagStatusResult>(METHODS.ragStatus);

describe('rag/index — full build', () => {
  it('indexes the workspace and reports files, chunks and what re-embedded', async () => {
    await writeCorpus();
    const peer = await client();

    const result = await index(peer, { full: true });

    expect(result.files).toBe(3);
    expect(result.chunks).toBeGreaterThanOrEqual(3);
    expect(result.embedded).toBe(3);
    expect(endpoint.embeddingBatches.length).toBeGreaterThan(0);
  });

  it('writes the index under the shared project state dir, not anywhere host-specific', async () => {
    // Decision 5: one location keyed by workspace root, the CLI's convention.
    await writeCorpus();
    const peer = await client();

    await index(peer, { full: true });

    const raw = await readFile(join(projectStateDir(root), RAG_INDEX_FILE), 'utf8');
    expect(JSON.parse(raw).records.length).toBeGreaterThan(0);
  });

  it('flags the first build as fresh, and the next one as not', async () => {
    // This is what the extension turns into its one-time "every file was
    // embedded" log line: its index used to live in VS Code workspace storage
    // and is deliberately not migrated (decision 5).
    await writeCorpus();
    const peer = await client();

    expect((await index(peer, { full: true })).fresh).toBe(true);
    expect((await index(peer, { full: true })).fresh).toBe(false);
  });

  it('re-embeds nothing on a second build — the embedding cache survives the process boundary', async () => {
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });
    const before = endpoint.embeddingBatches.length;

    const second = await index(peer, { full: true });

    expect(second.embedded).toBe(0);
    expect(endpoint.embeddingBatches.length).toBe(before);
  });

  it('reports no-embedder rather than indexing when nothing is assigned to the embeddings role', async () => {
    await writeCorpus();
    // A role table that exists but leaves embeddings unassigned is a
    // deliberate "off" — it must not fall back to the chat model, which
    // cannot embed.
    const peer = await client({ roles: { chat: { connection: 'test', model: 'chat' } } });

    const result = await index(peer, { full: true });

    expect(result).toMatchObject({ files: 0, chunks: 0, embedded: 0 });
    expect((await status(peer)).state).toBe('no-embedder');
    expect(endpoint.embeddingBatches).toEqual([]);
  });

  it('emits progress and a final state as rag/event notifications', async () => {
    await writeCorpus();
    const peer = await client();
    const events: RagEventParams[] = [];
    peer.onNotification(METHODS.ragEvent, (raw) => events.push(raw as RagEventParams));

    await index(peer, { full: true, runId: 'r1' });

    expect(events.some((e) => e.event.kind === 'progress')).toBe(true);
    const last = events.at(-1)!;
    expect(last.runId).toBe('r1');
    expect(last.event).toMatchObject({ kind: 'state', state: 'idle', files: 3 });
  });
});

describe('rag/index — incremental', () => {
  it('indexes only the paths it is given', async () => {
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });
    const before = endpoint.embeddingBatches.length;

    await writeFile(join(root, 'billing.ts'), 'export function refundPayment(id: string) {\n  return gateway.refund(id);\n}\n');
    const result = await index(peer, { paths: ['billing.ts'] });

    expect(result.embedded).toBe(1);
    expect(endpoint.embeddingBatches.length).toBe(before + 1);
    expect(endpoint.embeddingBatches.at(-1)!.join('\n')).toContain('refundPayment');
    expect((await query(peer, { text: 'refundPayment', rerank: false })).hits[0]!.path).toBe('billing.ts');
  });

  it('drops a deleted file with no separate remove method — indexing a path it cannot read is enough', async () => {
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });

    await rm(join(root, 'billing.ts'));
    const result = await index(peer, { paths: ['billing.ts'] });

    expect(result.files).toBe(2);
    expect((await query(peer, { text: 'chargeCard gateway', rerank: false })).hits.map((h) => h.path)).not.toContain(
      'billing.ts',
    );
  });

  it('handles a rename as the two paths together', async () => {
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });

    await rm(join(root, 'billing.ts'));
    await writeFile(join(root, 'payments.ts'), 'export function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}\n');
    await index(peer, { paths: ['billing.ts', 'payments.ts'] });

    const paths = (await query(peer, { text: 'chargeCard gateway', rerank: false })).hits.map((h) => h.path);
    expect(paths).toContain('payments.ts');
    expect(paths).not.toContain('billing.ts');
  });

  it('clears the index on request', async () => {
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });

    const cleared = await index(peer, { clear: true });

    expect(cleared).toMatchObject({ files: 0, chunks: 0 });
    expect((await query(peer, { text: 'chargeCard' })).hits).toEqual([]);
  });
});

describe('rag/query — nothing binary crosses the wire', () => {
  it('sends no vector field at all in the NDJSON response', async () => {
    // Not "the caller ignores it" — absent from the bytes. This is the whole
    // reason base64 and a binary sideband were both unnecessary (§2.3), and it
    // is only true because the store lives server-side.
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });

    // A raw socket, so the assertion is on the actual framing rather than on a
    // decoded object that could have dropped the field on the way in.
    const socket = await rawSocket();
    const lines: string[] = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => lines.push(chunk));
    const send = (id: number, method: string, params: unknown): void =>
      void socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    send(1, METHODS.hello, {
      token: server.token,
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'raw' },
      root,
      profiles: [profile()],
      activeProfile: 'test',
    });
    await vi.waitFor(() => expect(lines.join('')).toContain('sessionId'));
    lines.length = 0;
    send(2, METHODS.ragQuery, { text: 'chargeCard gateway', rerank: false } satisfies RagQueryParams);
    await vi.waitFor(() => expect(lines.join('')).toContain('"formatted"'));

    const wire = lines.join('');
    expect(wire).not.toContain('vector');
    expect(wire).toContain('billing.ts');
    const parsed = JSON.parse(wire.trim().split('\n').at(-1)!) as { result: RagQueryResult };
    for (const hit of parsed.result.hits) {
      expect(Object.keys(hit).sort()).toEqual(['endLine', 'path', 'score', 'startLine', 'text']);
    }
  });

  it('returns the formatted block every consumer of RAG actually renders', async () => {
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });

    const { formatted } = await query(peer, { text: 'chargeCard gateway', rerank: false });

    expect(formatted).toMatch(/--- billing\.ts:\d+-\d+ \(score [\d.]+\) ---/);
  });

  it('is empty rather than an error when nothing is indexed', async () => {
    const peer = await client();

    expect(await query(peer, { text: 'anything' })).toEqual({ formatted: '', hits: [] });
  });
});

describe('rag/index — cancellation', () => {
  it('stops an in-flight build through agent/cancel', async () => {
    // A full build is minutes of network calls in a real workspace, so Stop has
    // to reach it. It registers as a run when given a runId, which is what lets
    // the existing agent/cancel notification abort it.
    for (let i = 0; i < 12; i++) {
      await writeFile(join(root, `f${i}.ts`), `export function fn${i}() {\n  return ${i};\n}\n`);
    }
    endpoint.delayMs = 120;
    const peer = await client();

    const pending = index(peer, { full: true, runId: 'slow' });
    await vi.waitFor(() => expect(endpoint.embeddingBatches.length).toBeGreaterThan(0));
    peer.notify(METHODS.agentCancel, { runId: 'slow' });
    const result = await pending;

    // Stopped part-way rather than running to completion.
    expect(result.embedded).toBeLessThan(12);
    expect(endpoint.embeddingBatches.length).toBeLessThan(12);
    // Cancellation is not failure: the status bar must not read "index error"
    // for a build the user stopped, and whatever was embedded is kept.
    const after = await status(peer);
    expect(after.state).toBe('idle');
    expect(after.files).toBe(result.files);

    // The partial walk must not have pruned the files it never reached — a
    // second, uncancelled build finds them and finishes the job.
    endpoint.delayMs = 0;
    const finished = await index(peer, { full: true });
    expect(finished.files).toBe(12);
  });
});

describe('rag/index — a rebuild requested while one is already running', () => {
  /**
   * The `/index` bug. A second full build used to return the instant it was
   * asked for, without building and without waiting, and `runIndex` then
   * answered with the *running* build's state (server/rag.ts:135-137). The
   * CLI pushes its status line exactly once (cli/src/ink/App.tsx:1152-1163),
   * so what the user saw was "Semantic search: indexing — 0 files, 0 chunks."
   * standing forever, milliseconds before the index actually went idle.
   *
   * The assertions are ordered to catch precisely that: status is read as
   * soon as the second request resolves, without waiting on the first.
   */
  it('answers for a finished index rather than the one still running', async () => {
    for (let i = 0; i < 8; i++) {
      await writeFile(join(root, `f${i}.ts`), `export function fn${i}() {\n  return ${i};\n}\n`);
    }
    endpoint.delayMs = 60;
    const peer = await client();

    const first = index(peer, { full: true });
    // Only send the second once the first is demonstrably mid-flight.
    await vi.waitFor(() => expect(endpoint.embeddingBatches.length).toBeGreaterThan(0));
    const second = await index(peer, { full: true });

    // Resolved because a build finished, not because one was already running.
    expect(second.files).toBe(8);
    expect((await status(peer)).state).toBe('idle');
    await first;
  });

  it('picks up a file that appeared after the running build had listed the workspace', async () => {
    // Enough files that the build is still walking when the second request
    // lands — with one file the window closes before anything can arrive.
    for (let i = 0; i < 8; i++) {
      await writeFile(join(root, `f${i}.ts`), `export function fn${i}() {\n  return ${i};\n}\n`);
    }
    endpoint.delayMs = 60;
    const peer = await client();

    const first = index(peer, { full: true });
    await vi.waitFor(() => expect(endpoint.embeddingBatches.length).toBeGreaterThan(0));
    // The running build listed the workspace before this existed, so merely
    // waiting for it would report a rebuild that never saw the file. Hence the
    // follow-up pass rather than just joining (rag/indexer.ts:223-235).
    await writeFile(join(root, 'late.ts'), 'export function late() {\n  return 9;\n}\n');
    const second = await index(peer, { full: true });

    expect((await first).files).toBe(8);
    expect(second.files).toBe(9);
  });
});

describe('the server can only index a workspace it can read', () => {
  it('reports unavailable for a root the host says is not local', async () => {
    // Decision 3: a VS Code virtual or remote-scheme workspace, where only the
    // host can resolve paths. Better than indexing whatever fsPath produced.
    await writeCorpus();
    const peer = await client({ localRoot: false });

    const s = await status(peer);

    expect(s.available).toBe(false);
    expect(await index(peer, { full: true })).toMatchObject({ files: 0, chunks: 0 });
    expect(endpoint.embeddingBatches).toEqual([]);
  });

  it('reports unavailable for a root that does not exist', async () => {
    const peer = await client({ root: join(root, 'nope') });

    expect((await status(peer)).available).toBe(false);
  });
});

describe('the daemon chunks the way the hosts do', () => {
  it('produces the same chunk boundaries as chunkFile once the daemon wires its wasm', async () => {
    // Prerequisite 1's real payoff. The embedding cache key is
    // fnv1a(path:text) (chunker.ts:60), so if the daemon fell back to the
    // line-window chunker, every hash from an existing index would miss and
    // the whole workspace would re-embed with no error anywhere. The only way
    // to see that is to compare boundaries.
    const { copyFile, mkdir } = await import('node:fs/promises');
    await mkdir(WASM_DIR, { recursive: true });
    for (const [name, from] of [
      ['tree-sitter.wasm', require.resolve('web-tree-sitter/tree-sitter.wasm')],
      ['tree-sitter-typescript.wasm', require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm')],
      ['tree-sitter-tsx.wasm', require.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm')],
      ['tree-sitter-javascript.wasm', require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm')],
      ['tree-sitter-python.wasm', require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')],
    ] as const) {
      await copyFile(from, join(WASM_DIR, name));
    }
    // Exactly what runDaemon does at startup, with the host-supplied wasmDir.
    const logged: string[] = [];
    await enableAstChunking(WASM_DIR, async (line) => void logged.push(line));
    expect(logged).toEqual([]);

    // Long enough that the two chunkers disagree: AST boundaries are
    // contiguous, line-window ones overlap by 10.
    const body = Array.from(
      { length: 20 },
      (_, i) => `export function fn${i}(input: number): number {\n  const scaled = input * ${i + 1};\n  return scaled + ${i};\n}\n`,
    ).join('\n');
    await writeFile(join(root, 'wide.ts'), body);

    const peer = await client();
    await index(peer, { full: true });
    const hits = (await query(peer, { text: 'scaled input', k: 50, rerank: false })).hits.filter(
      (h) => h.path === 'wide.ts',
    );
    const expected = await chunkFile('wide.ts', body);

    expect(hits.length).toBe(expected.length);
    expect(hits.map((h) => `${h.startLine}-${h.endLine}`).sort()).toEqual(
      expected.map((c) => `${c.startLine}-${c.endLine}`).sort(),
    );
    // And they really are the AST chunker's, not the fallback's: contiguous.
    const sorted = [...hits].sort((a, b) => a.startLine - b.startLine);
    expect(sorted.every((h, i) => i === 0 || h.startLine === sorted[i - 1]!.endLine + 1)).toBe(true);
  });
});

describe('host policy stays host policy', () => {
  it('runs contextual retrieval only when the request asks for it', async () => {
    // Decision 6: the extension ships it off, the CLI runs it always, and both
    // keep their current default by passing it per request rather than the
    // server reading either host's config.
    await writeCorpus();
    const peer = await client({ roles: { chat: { connection: 'test', model: 'chat' }, embeddings: { connection: 'test', model: 'embed' }, context: { connection: 'test', model: 'ctx' } } });

    await index(peer, { full: true, contextualRetrieval: false });
    expect(endpoint.chatCalls).toEqual([]);

    await index(peer, { clear: true });
    await index(peer, { full: true, contextualRetrieval: true });
    expect(endpoint.chatCalls.length).toBeGreaterThan(0);
    // The blurb request carries the file and its snippets, which is what
    // distinguishes it from a rerank call.
    expect(endpoint.chatCalls.some((m) => m.at(-1)!.content.includes('Snippets:'))).toBe(true);
  });

  it('defaults contextual retrieval off when the request says nothing', async () => {
    await writeCorpus();
    const peer = await client({ roles: { chat: { connection: 'test', model: 'chat' }, embeddings: { connection: 'test', model: 'embed' }, context: { connection: 'test', model: 'ctx' } } });

    await index(peer, { full: true });

    expect(endpoint.chatCalls).toEqual([]);
  });

  it('reranks only when the request asks for it', async () => {
    // Six chunks so the candidate set is bigger than k and rerank has work.
    for (let i = 0; i < 8; i++) {
      await writeFile(join(root, `m${i}.ts`), `export function fn${i}() {\n  return ${i};\n}\n`);
    }
    const peer = await client({ roles: { chat: { connection: 'test', model: 'chat' }, embeddings: { connection: 'test', model: 'embed' }, rerank: { connection: 'test', model: 'rr' } } });
    await index(peer, { full: true });

    await query(peer, { text: 'fn3', k: 2, rerank: false });
    expect(endpoint.chatCalls).toEqual([]);

    await query(peer, { text: 'fn3', k: 2, rerank: true });
    expect(endpoint.chatCalls.length).toBe(1);
  });

  it('fuses BM25 when hybrid search is on, which is the only thing that can rank identical vectors', async () => {
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });

    const hybrid = await query(peer, { text: 'chargeCard gateway', k: 1, hybridSearch: true, rerank: false });

    expect(hybrid.hits[0]!.path).toBe('billing.ts');
  });
});

describe('semantic_search is dispatched server-side', () => {
  const SEARCH_TOOL: ToolDefinition = {
    name: 'semantic_search',
    description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    permission: 'read',
  };
  const FINISH_TOOL: ToolDefinition = {
    name: 'finish',
    description: 'finish',
    parameters: { type: 'object', properties: { summary: { type: 'string' } } },
    permission: 'read',
  };

  async function runTurn(peer: RpcPeer, executed: string[]): Promise<string[]> {
    const results: string[] = [];
    peer.onRequest(METHODS.toolExecute, async (raw) => {
      const { call } = raw as { call: { id: string; name: string } };
      executed.push(call.name);
      return { id: call.id, name: call.name, content: 'host fallback' };
    });
    peer.onRequest(METHODS.permissionRequest, async () => ({ granted: true }));
    peer.onRequest(METHODS.snapshotBefore, async () => null);
    peer.onNotification(METHODS.agentEvent, (raw) => {
      const { event } = raw as { event: { type: string; content?: string; name?: string } };
      if (event.type === 'tool_result' && event.name === 'semantic_search') results.push(event.content ?? '');
    });
    endpoint.script.length = 0;
    endpoint.script.push(
      '<tool name="semantic_search">\n{"query": "chargeCard gateway"}\n</tool>',
      '<tool name="finish">\n{"summary": "found it"}\n</tool>',
    );
    await peer.request(METHODS.agentRun, {
      model: 'chat',
      task: 'find the billing code',
      workspaceName: 'ws',
      tools: [SEARCH_TOOL, FINISH_TOOL],
      nativeToolCalls: false,
      runId: 'agent-1',
    });
    return results;
  }

  it('answers from the index without asking the host to run the tool', async () => {
    // §5.2: routing this back over tool/execute so the host could call
    // rag/query would be a needless out-and-back.
    await writeCorpus();
    const peer = await client();
    await index(peer, { full: true });
    const executed: string[] = [];

    const results = await runTurn(peer, executed);

    expect(results[0]).toContain('billing.ts');
    expect(executed).not.toContain('semantic_search');
  });

  it('hands the call back to the host when the index has nothing, so its text-search fallback still runs', async () => {
    // The host's executor degrades to a word-based regex search, which needs
    // the filesystem and so stays host-side. Falling through is deliberate.
    const peer = await client({ profiles: [profile()] }); // no embeddings model
    const executed: string[] = [];

    const results = await runTurn(peer, executed);

    expect(executed).toContain('semantic_search');
    expect(results[0]).toBe('host fallback');
  });
});
