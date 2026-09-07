import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeFileSource, nodeTextStore } from '@heapcode/repomap/node';
import {
  createProvider,
  RagIndexer,
  RAG_INDEX_FILE,
  type ModelRole,
  type ProviderProfileConfig,
  type RagRoleResolver,
} from '../src/index.js';

/**
 * The semantic index moved here from both hosts (docs/phase3-rag-design.md
 * §5.3, prerequisite 4). packages/cli/test/ragIndexer.test.ts still covers the
 * CLI's adapter with its original assertions; this suite covers what only the
 * extracted index can be asked — the per-request toggles that decision 6 keeps
 * as host policy, and the role seam that lets embeddings and rerank land on
 * different profiles.
 */

interface Endpoint {
  baseUrl: string;
  close(): Promise<void>;
  paths: string[];
  /** Replies the chat endpoint hands out, in order; the last one repeats. */
  chatReplies: string[];
  /** Per-embeddings-request delay, so a build can be caught mid-flight. */
  delayMs: number;
}

/**
 * A path-aware OpenAI-compatible fake — the shared mockServer answers every
 * path with one body, and these tests need embeddings and chat to differ.
 *
 * Every embedding is the same vector on purpose: pure vector search then
 * cannot discriminate at all, so any ranking that *does* discriminate proves
 * BM25 fusion ran. That is what makes the hybridSearch toggle observable.
 */
async function startEndpoint(): Promise<Endpoint> {
  const paths: string[] = [];
  const chatReplies: string[] = [];
  const state = { delayMs: 0 };
  let chatCount = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = req.url ?? '';
      paths.push(path);
      const body = raw ? (JSON.parse(raw) as { input?: string[] }) : {};
      const respond = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (path.includes('/embeddings')) {
          const input = body.input ?? [];
          res.end(JSON.stringify({ data: input.map((_, i) => ({ embedding: [1, 0, 0], index: i })) }));
          return;
        }
        const reply = chatReplies[Math.min(chatCount++, chatReplies.length - 1)] ?? '';
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      };
      if (path.includes('/embeddings') && state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    paths,
    chatReplies,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(ms: number) {
      state.delayMs = ms;
    },
  };
}

let root: string;
let endpoint: Endpoint;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-core-rag-'));
  endpoint = await startEndpoint();
});

afterEach(async () => {
  await endpoint.close();
  await rm(root, { recursive: true, force: true });
});

function profile(extra: Partial<ProviderProfileConfig> = {}): ProviderProfileConfig {
  return { name: 'test', preset: 'custom', baseUrl: endpoint.baseUrl, model: 'chat', ...extra };
}

/**
 * Resolves each role to the model named for it, recording which were asked.
 *
 * A resolver hands back an already-flattened profile whose `model` IS the
 * role's model — the inheritance chain lives in `resolveRole` (config/roles.ts)
 * now, not in the indexer and not in each host's copy of it. A role with no
 * entry here resolves to nothing, which is what an unassigned role means.
 */
function rolesFor(
  models: Partial<Record<ModelRole, string>>,
  asked: ModelRole[] = [],
  base: ProviderProfileConfig = profile(),
): RagRoleResolver {
  return async (role) => {
    asked.push(role);
    const model = models[role];
    if (!model) return undefined;
    const p = { ...base, model };
    return { provider: createProvider(p, undefined), profile: p };
  };
}

function indexer(roles: RagRoleResolver, opts: { requireEmbedderForReady?: boolean; onLog?: (l: string) => void } = {}): RagIndexer {
  return new RagIndexer({
    files: nodeFileSource(root, { exclude: ['**/node_modules/**'] }),
    store: nodeTextStore(join(root, '.state', RAG_INDEX_FILE)),
    roles,
    ...opts,
  });
}

/** Enough distinct files that a query over-fetches past k and rerank has something to do. */
async function writeCorpus(): Promise<void> {
  const files: Array<[string, string]> = [
    ['auth.ts', 'export function authenticate(user: string) {\n  return checkCredentials(user);\n}\n'],
    ['billing.ts', 'export function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}\n'],
    ['cache.ts', 'export function memoize(fn: () => number) {\n  return fn;\n}\n'],
    ['db.ts', 'export function connect(url: string) {\n  return pool.acquire(url);\n}\n'],
    ['email.ts', 'export function sendMail(to: string) {\n  return smtp.send(to);\n}\n'],
    ['files.ts', 'export function readAll(path: string) {\n  return fs.read(path);\n}\n'],
    ['graph.ts', 'export function traverse(node: string) {\n  return walk(node);\n}\n'],
    ['http.ts', 'export function request(url: string) {\n  return fetch(url);\n}\n'],
  ];
  for (const [name, body] of files) await writeFile(join(root, name), body);
}

const chatCalls = (): number => endpoint.paths.filter((p) => p.includes('/chat/completions')).length;
const embeddingCalls = (): number => endpoint.paths.filter((p) => p.includes('/embeddings')).length;

describe('RagIndexer — contextual retrieval (host policy, per request)', () => {
  it('makes no LLM call when off — the extension\'s shipped default', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();

    await index.buildIndex({ contextualRetrieval: false });

    expect(chatCalls()).toBe(0);
    expect(index.chunkCount).toBeGreaterThan(0);
  });

  it('calls the context model when on — the CLI\'s behaviour, which has no setting for it', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    endpoint.chatReplies.push('1: adds two numbers');
    const index = indexer(rolesFor({ embeddings: 'embed', context: 'ctx' }));
    await index.init();

    await index.buildIndex({ contextualRetrieval: true });

    expect(chatCalls()).toBeGreaterThan(0);
  });

  it('defaults to off when unspecified', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const index = indexer(rolesFor({ embeddings: 'embed', context: 'ctx' }));
    await index.init();

    await index.buildIndex();

    expect(chatCalls()).toBe(0);
  });

  it('never fails indexing when the context model errors', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const roles: RagRoleResolver = async (role) => {
      if (role === 'context') throw new Error('the context connection is broken');
      const p = { ...profile(), model: 'embed' };
      return { provider: createProvider(p, undefined), profile: p };
    };
    const index = indexer(roles);
    await index.init();

    const result = await index.buildIndex({ contextualRetrieval: true });

    expect(result?.chunks).toBeGreaterThan(0);
  });
});

describe('RagIndexer — hybrid search and rerank (host policy, per request)', () => {
  it('fuses BM25 when hybrid is on, which is the only thing that can rank identical vectors', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();
    await index.buildIndex();

    const hits = await index.query('chargeCard gateway', 3, { hybridSearch: true, rerank: false });

    expect(hits[0]!.record.path).toBe('billing.ts');
  });

  it('cannot rank identical vectors when hybrid is off', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();
    await index.buildIndex();

    const hits = await index.query('chargeCard gateway', 3, { hybridSearch: false, rerank: false });

    // Every vector is [1,0,0], so pure cosine is a tie and billing.ts has no
    // reason to come first. This is the control for the test above.
    expect(hits.map((h) => h.record.path)).not.toEqual(['billing.ts', ...hits.slice(1).map((h) => h.record.path)]);
  });

  it('makes no LLM call when rerank is off', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed', rerank: 'rr' }));
    await index.init();
    await index.buildIndex();
    const before = chatCalls();

    await index.query('authenticate', 3, { rerank: false });

    expect(chatCalls()).toBe(before);
  });

  it('reranks into the model\'s order when on', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed', rerank: 'rr' }));
    await index.init();
    await index.buildIndex();
    // rerankHits shows numbered candidates and keeps the ones the model picks,
    // in its order (rerank.ts:54-57).
    endpoint.chatReplies.push('3, 1');

    const hits = await index.query('anything', 2, { rerank: true });
    const unranked = await index.query('anything', 2, { rerank: false });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.record.path).not.toBe(unranked[0]!.record.path);
  });

  it('reranks on whatever the rerank role inherited, without knowing it inherited', async () => {
    // The chain (rerank → edit → chat) is the resolver's job now, so from here
    // an inherited model is indistinguishable from an assigned one. That is
    // the point: the indexer used to walk `rerankModel || editModel || model`
    // itself, and so did each host, three copies of one rule.
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed', rerank: 'chat' }));
    await index.init();
    await index.buildIndex();
    const before = chatCalls();

    await index.query('chargeCard gateway', 3, { rerank: true });

    expect(chatCalls()).toBe(before + 1);
  });

  it('falls back to hybrid order when nothing serves the rerank role', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();
    await index.buildIndex();
    const before = chatCalls();

    const hits = await index.query('chargeCard gateway', 3, { rerank: true });

    expect(chatCalls()).toBe(before);
    expect(hits[0]!.record.path).toBe('billing.ts');
  });

  it('falls back to hybrid order when the rerank profile is unreachable', async () => {
    // Only the rerank role points at a dead endpoint — the realistic shape,
    // since its assignment can name an entirely different connection than the
    // embeddings one does.
    await writeCorpus();
    const embeddings = { ...profile(), model: 'embed' };
    const broken = profile({ name: 'down', baseUrl: 'http://127.0.0.1:1/v1', model: 'rr' });
    const index = indexer(async (role) => {
      const p = role === 'rerank' ? broken : embeddings;
      return { provider: createProvider(p, undefined), profile: p };
    });
    await index.init();
    await index.buildIndex();

    const hits = await index.query('chargeCard gateway', 3, { rerank: true });

    expect(hits[0]!.record.path).toBe('billing.ts');
  });

  it('both default to on', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();
    await index.buildIndex();

    // Hybrid on is what makes this ordering possible at all.
    expect((await index.query('chargeCard gateway', 3))[0]!.record.path).toBe('billing.ts');
  });
});

describe('RagIndexer — the role seam', () => {
  it('asks for embeddings, context and rerank as separate roles', async () => {
    await writeCorpus();
    const asked: ModelRole[] = [];
    const index = indexer(rolesFor({ embeddings: 'embed', context: 'ctx', rerank: 'rr' }, asked));
    await index.init();
    endpoint.chatReplies.push('1: a blurb');
    await index.buildIndex({ contextualRetrieval: true });
    await index.query('authenticate');

    expect(new Set(asked)).toEqual(new Set(['embeddings', 'context', 'rerank']));
  });

  it('reports no-embedder when nothing is assigned to the embeddings role', async () => {
    const index = indexer(rolesFor({}));
    await index.init();

    expect((await index.status()).state).toBe('no-embedder');
    expect(await index.buildIndex()).toBeUndefined();
  });

  it('reports no-embedder when the role resolves to nothing at all', async () => {
    // Session.providerForRole returns undefined for a profile the host does
    // not know; the two host resolvers always fall back to the active profile.
    const index = indexer(async () => undefined);
    await index.init();

    expect((await index.status()).state).toBe('no-embedder');
    expect(await index.buildIndex()).toBeUndefined();
  });
});

describe('RagIndexer — ready', () => {
  it('needs only content by default, which is what the CLI relies on', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    let current: ProviderProfileConfig | undefined = { ...profile(), model: 'embed' };
    const index = indexer(async () =>
      current ? { provider: createProvider(current, undefined), profile: current } : undefined,
    );
    await index.init();
    await index.buildIndex();

    // The embeddings assignment goes away; the index still has content.
    current = undefined;
    await index.status(); // refreshes the cached embedder
    expect(index.ready).toBe(true);
  });

  it('additionally needs an embeddings model when the host asks for that, which is the extension\'s rule', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    let current: ProviderProfileConfig | undefined = { ...profile(), model: 'embed' };
    const index = indexer(
      async () =>
        current ? { provider: createProvider(current, undefined), profile: current } : undefined,
      { requireEmbedderForReady: true },
    );
    await index.init();
    await index.buildIndex();
    expect(index.ready).toBe(true);

    current = undefined;
    await index.status();
    expect(index.ready).toBe(false);
  });
});

describe('RagIndexer — overlapping builds', () => {
  /**
   * The unit-level half of the `/index` bug. `buildIndex` used to return
   * undefined the moment it saw a build already running, which reads as "no
   * embeddings model configured" to every caller — the same value the
   * no-embedder path returns — and left the caller to report the running
   * build's state as its own result.
   */
  it('waits for the build in flight and rebuilds, rather than returning undefined', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();
    endpoint.delayMs = 40;

    const first = index.buildIndex({ contextualRetrieval: false });
    await vi.waitFor(() => expect(embeddingCalls()).toBeGreaterThan(0));
    const second = index.buildIndex({ contextualRetrieval: false });

    expect(await first).toMatchObject({ files: 8 });
    // Undefined here would be the old behavior, indistinguishable from
    // "no embedder" (see the two no-embedder cases above).
    expect(await second).toMatchObject({ files: 8 });
    expect((await index.status()).state).toBe('idle');
  });

  it('runs one shared follow-up however many requests pile up behind a build', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();
    endpoint.delayMs = 40;

    const first = index.buildIndex({ contextualRetrieval: false });
    await vi.waitFor(() => expect(embeddingCalls()).toBeGreaterThan(0));
    const waiters = [index.buildIndex(), index.buildIndex(), index.buildIndex()];

    const settled = await Promise.all(waiters);
    await first;
    // One follow-up, not three: they all resolve to the very same build — and
    // to a real result, since three undefineds would also be "identical".
    expect(settled[0]).toMatchObject({ files: 8 });
    expect(settled[0]).toBe(settled[1]);
    expect(settled[1]).toBe(settled[2]);
    expect((await index.status()).state).toBe('idle');
  });
});

describe('RagIndexer — buildIndex result', () => {
  it('reports files, chunks and how many files actually re-embedded', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();

    const first = await index.buildIndex();
    expect(first).toEqual({ files: 8, chunks: expect.any(Number), embedded: 8 });

    // Nothing changed — the embedding cache means no file re-embeds.
    const second = await index.buildIndex();
    expect(second?.embedded).toBe(0);
    expect(second?.files).toBe(8);
  });

  it('drops files that disappeared between runs', async () => {
    await writeCorpus();
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();
    await index.buildIndex();

    await rm(join(root, 'billing.ts'));
    const after = await index.buildIndex();

    expect(after?.files).toBe(7);
  });
});

/**
 * Which model wrote the index.
 *
 * Vectors from two embedding models are not comparable — cosine distance
 * between them is noise, not a weak signal — so an index holding a mixture
 * answers confidently and wrongly, with no error anywhere to notice.
 *
 * Nothing recorded the model before, and the embeddings role was a field on
 * whichever profile happened to be active. Switching profile was therefore
 * enough to start interleaving two models' vectors in one file. Making roles
 * global removes that trigger; this is the guard for every other way it could
 * happen — editing config by hand, sharing a workspace, changing the model on
 * purpose.
 */
describe('RagIndexer — the embedder stamp', () => {
  const statePath = (): string => join(root, '.state', RAG_INDEX_FILE);

  it('records the model that produced the vectors', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();
    await index.buildIndex();

    expect(JSON.parse(index.serialize()) as { embedder?: string }).toMatchObject({ embedder: 'embed' });
  });

  it('reads an index back when the same model is still in use', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const first = indexer(rolesFor({ embeddings: 'embed' }));
    await first.init();
    const built = await first.buildIndex();
    expect(built?.chunks).toBeGreaterThan(0);

    const second = indexer(rolesFor({ embeddings: 'embed' }));
    await second.init();

    expect(second.chunkCount).toBe(built!.chunks);
  });

  it('discards an index built by a different model rather than searching across both', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const first = indexer(rolesFor({ embeddings: 'embed' }));
    await first.init();
    await first.buildIndex();

    const second = indexer(rolesFor({ embeddings: 'other-embed' }));
    await second.init();

    // Empty, which every caller already treats as "no index" and rebuilds
    // from. One cold rebuild beats silently bad search.
    expect(second.chunkCount).toBe(0);
  });

  it('rebuilds cleanly after the model changes, and restamps', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const first = indexer(rolesFor({ embeddings: 'embed' }));
    await first.init();
    await first.buildIndex();

    const second = indexer(rolesFor({ embeddings: 'other-embed' }));
    await second.init();
    const rebuilt = await second.buildIndex();

    expect(rebuilt?.chunks).toBeGreaterThan(0);
    expect(JSON.parse(second.serialize()) as { embedder?: string }).toMatchObject({ embedder: 'other-embed' });
  });

  it('discards an index that predates stamping, since it cannot prove it is not already a mixture', async () => {
    await mkdir(join(root, '.state'), { recursive: true });
    await writeFile(
      statePath(),
      JSON.stringify({ version: 1, fileHashes: { 'a.ts': 'h' }, records: [] }),
      'utf8',
    );
    const index = indexer(rolesFor({ embeddings: 'embed' }));
    await index.init();

    expect(index.fileCount).toBe(0);
  });

  it('says which models disagreed, rather than rebuilding in silence', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const first = indexer(rolesFor({ embeddings: 'embed' }));
    await first.init();
    await first.buildIndex();

    const lines: string[] = [];
    const second = indexer(rolesFor({ embeddings: 'other-embed' }), { onLog: (l) => lines.push(l) });
    await second.init();

    expect(lines.join('\n')).toContain('embed');
    expect(lines.join('\n')).toContain('other-embed');
  });
});
