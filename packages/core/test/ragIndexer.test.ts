import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  let chatCount = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = req.url ?? '';
      paths.push(path);
      const body = raw ? (JSON.parse(raw) as { input?: string[] }) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      if (path.includes('/embeddings')) {
        const input = body.input ?? [];
        res.end(JSON.stringify({ data: input.map((_, i) => ({ embedding: [1, 0, 0], index: i })) }));
        return;
      }
      const reply = chatReplies[Math.min(chatCount++, chatReplies.length - 1)] ?? '';
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    paths,
    chatReplies,
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

/** Resolves every role to one profile, recording which roles were asked for. */
function rolesFor(p: ProviderProfileConfig, asked: ModelRole[] = []): RagRoleResolver {
  return async (role) => {
    asked.push(role);
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

describe('RagIndexer — contextual retrieval (host policy, per request)', () => {
  it('makes no LLM call when off — the extension\'s shipped default', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed' })));
    await index.init();

    await index.buildIndex({ contextualRetrieval: false });

    expect(chatCalls()).toBe(0);
    expect(index.chunkCount).toBeGreaterThan(0);
  });

  it('calls the context model when on — the CLI\'s behaviour, which has no setting for it', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    endpoint.chatReplies.push('1: adds two numbers');
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed', contextModel: 'ctx' })));
    await index.init();

    await index.buildIndex({ contextualRetrieval: true });

    expect(chatCalls()).toBeGreaterThan(0);
  });

  it('defaults to off when unspecified', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed', contextModel: 'ctx' })));
    await index.init();

    await index.buildIndex();

    expect(chatCalls()).toBe(0);
  });

  it('never fails indexing when the context model errors', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const roles: RagRoleResolver = async (role) => {
      if (role === 'contextModel') throw new Error('context profile is broken');
      return { provider: createProvider(profile({ embeddingsModel: 'embed' }), undefined), profile: profile({ embeddingsModel: 'embed' }) };
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
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed' })));
    await index.init();
    await index.buildIndex();

    const hits = await index.query('chargeCard gateway', 3, { hybridSearch: true, rerank: false });

    expect(hits[0]!.record.path).toBe('billing.ts');
  });

  it('cannot rank identical vectors when hybrid is off', async () => {
    await writeCorpus();
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed' })));
    await index.init();
    await index.buildIndex();

    const hits = await index.query('chargeCard gateway', 3, { hybridSearch: false, rerank: false });

    // Every vector is [1,0,0], so pure cosine is a tie and billing.ts has no
    // reason to come first. This is the control for the test above.
    expect(hits.map((h) => h.record.path)).not.toEqual(['billing.ts', ...hits.slice(1).map((h) => h.record.path)]);
  });

  it('makes no LLM call when rerank is off', async () => {
    await writeCorpus();
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed', rerankModel: 'rr' })));
    await index.init();
    await index.buildIndex();
    const before = chatCalls();

    await index.query('authenticate', 3, { rerank: false });

    expect(chatCalls()).toBe(before);
  });

  it('reranks into the model\'s order when on', async () => {
    await writeCorpus();
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed', rerankModel: 'rr' })));
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

  it('falls back rerankModel → editModel → model, so an unset rerank model still reranks', async () => {
    // Worth pinning because it is easy to read `rerankModel` being unset as
    // "no rerank": the profile's chat model backstops it (profiles.ts:31), and
    // that is what both hosts did before this moved.
    await writeCorpus();
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed' })));
    await index.init();
    await index.buildIndex();
    const before = chatCalls();

    await index.query('chargeCard gateway', 3, { rerank: true });

    expect(chatCalls()).toBe(before + 1);
  });

  it('falls back to hybrid order when the profile has no usable model for it', async () => {
    await writeCorpus();
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed', model: '' })));
    await index.init();
    await index.buildIndex();
    const before = chatCalls();

    const hits = await index.query('chargeCard gateway', 3, { rerank: true });

    expect(chatCalls()).toBe(before);
    expect(hits[0]!.record.path).toBe('billing.ts');
  });

  it('falls back to hybrid order when the rerank profile is unreachable', async () => {
    // Only the rerank role points at a dead endpoint — the realistic shape,
    // since rerankProfile can name an entirely different provider than
    // embeddings do.
    await writeCorpus();
    const embeddings = profile({ embeddingsModel: 'embed' });
    const broken = profile({ name: 'down', baseUrl: 'http://127.0.0.1:1/v1', rerankModel: 'rr' });
    const index = indexer(async (role) => {
      const p = role === 'rerankModel' ? broken : embeddings;
      return { provider: createProvider(p, undefined), profile: p };
    });
    await index.init();
    await index.buildIndex();

    const hits = await index.query('chargeCard gateway', 3, { rerank: true });

    expect(hits[0]!.record.path).toBe('billing.ts');
  });

  it('both default to on', async () => {
    await writeCorpus();
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed' })));
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
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed', contextModel: 'ctx', rerankModel: 'rr' }), asked));
    await index.init();
    endpoint.chatReplies.push('1: a blurb');
    await index.buildIndex({ contextualRetrieval: true });
    await index.query('authenticate');

    expect(new Set(asked)).toEqual(new Set(['embeddingsModel', 'contextModel', 'rerankModel']));
  });

  it('reports no-embedder when the role resolves to a profile with no embeddings model', async () => {
    const index = indexer(rolesFor(profile()));
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
    const withEmbedder = profile({ embeddingsModel: 'embed' });
    let current = withEmbedder;
    const index = indexer(async () => ({ provider: createProvider(current, undefined), profile: current }));
    await index.init();
    await index.buildIndex();

    // Embeddings model goes away; the index still has content.
    current = profile();
    await index.status(); // refreshes the cached embedder
    expect(index.ready).toBe(true);
  });

  it('additionally needs an embeddings model when the host asks for that, which is the extension\'s rule', async () => {
    await writeFile(join(root, 'a.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    const withEmbedder = profile({ embeddingsModel: 'embed' });
    let current = withEmbedder;
    const index = indexer(
      async () => ({ provider: createProvider(current, undefined), profile: current }),
      { requireEmbedderForReady: true },
    );
    await index.init();
    await index.buildIndex();
    expect(index.ready).toBe(true);

    current = profile();
    await index.status();
    expect(index.ready).toBe(false);
  });
});

describe('RagIndexer — buildIndex result', () => {
  it('reports files, chunks and how many files actually re-embedded', async () => {
    await writeCorpus();
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed' })));
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
    const index = indexer(rolesFor(profile({ embeddingsModel: 'embed' })));
    await index.init();
    await index.buildIndex();

    await rm(join(root, 'billing.ts'));
    const after = await index.buildIndex();

    expect(after?.files).toBe(7);
  });
});
