import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeapcodeServer, type ModelRoleTable, type ProviderProfileConfig } from '@heapcode/core';
import { ServerLink } from '../src/serverLink.js';
import type { ProfileManager } from '../src/profileManager.js';
import { __resetConfig, __setConfig, __setWorkspaceRoot } from './vscodeStub.js';

/**
 * Decision 6 of the RAG migration: the four `heapcode.rag.*` toggles stay host
 * policy, passed on each request, rather than becoming server-side defaults or
 * something the server reads out of this host's settings.
 *
 * These are behavior-preservation tests, not feature tests. What they pin is
 * that the extension's shipped defaults still produce the behavior they
 * produced before RAG moved: contextual retrieval **off**, hybrid search and
 * rerank **on**. (The CLI's opposite contextual-retrieval default — always on,
 * no setting — is pinned in packages/cli/test/app.test.tsx.)
 */

interface Endpoint {
  baseUrl: string;
  close(): Promise<void>;
  embeddingBatches: string[][];
  /** Non-streaming chat bodies: contextual retrieval and rerank both land here. */
  chatCalls: Array<{ role: string; content: string }[]>;
}

async function startEndpoint(): Promise<Endpoint> {
  const embeddingBatches: string[][] = [];
  const chatCalls: Endpoint['chatCalls'] = [];
  const server: HttpServer = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw
        ? (JSON.parse(raw) as { input?: string[]; messages?: Array<{ role: string; content: string }> })
        : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('/embeddings')) {
        const input = body.input ?? [];
        embeddingBatches.push(input);
        res.end(JSON.stringify({ data: input.map((_, i) => ({ embedding: [1, 0, 0], index: i })) }));
        return;
      }
      chatCalls.push(body.messages ?? []);
      res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    embeddingBatches,
    chatCalls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function stubProfiles(profile: ProviderProfileConfig, roles: ModelRoleTable): ProfileManager {
  return {
    getProfiles: () => [profile],
    getActiveProfile: () => profile,
    getRoles: () => roles,
    getApiKey: () => Promise.resolve(undefined),
  } as unknown as ProfileManager;
}

let root: string;
let home: string;
let core: HeapcodeServer;
let endpoint: Endpoint;
let link: ServerLink;
const log = { appendLine: () => {} } as never;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-vsc-rag-'));
  home = await mkdtemp(join(tmpdir(), 'heapcode-vsc-rag-home-'));
  vi.stubEnv('HEAPCODE_HOME', home);
  __setWorkspaceRoot(root);
  endpoint = await startEndpoint();
  core = new HeapcodeServer({ home, address: join(home, 't.sock'), idleShutdownMs: 0 });
  await core.listen();
  await writeFile(join(root, 'billing.ts'), 'export function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}\n');
  await writeFile(join(root, 'auth.ts'), 'export function authenticateUser(token: string) {\n  return verifySession(token);\n}\n');
});

afterEach(async () => {
  link?.dispose();
  await core?.close();
  await endpoint?.close();
  __setWorkspaceRoot(undefined);
  __resetConfig();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/**
 * Roles are one global table now, so what the extension pushes at hello is the
 * table — not a profile carrying seven role fields. Everything here runs on
 * one connection; only the models differ per role.
 */
function makeLink(extraRoles: ModelRoleTable = {}): ServerLink {
  const full: ProviderProfileConfig = {
    name: 'test',
    preset: 'custom',
    baseUrl: endpoint.baseUrl,
    model: 'chat',
  };
  const roles: ModelRoleTable = {
    chat: { connection: 'test', model: 'chat' },
    embeddings: { connection: 'test', model: 'embed' },
    ...extraRoles,
  };
  link = new ServerLink(stubProfiles(full, roles), log, {
    address: core.address,
    token: core.token,
    autostart: false,
  });
  return link;
}

describe('ServerLink RAG — the extension\'s toggle defaults', () => {
  it('leaves contextual retrieval off by default, so indexing makes no LLM call', async () => {
    // heapcode.rag.contextualRetrieval ships false: it runs once per *changed
    // chunk*, so it adds real time to indexing (package.json's own wording).
    const l = makeLink({ context: { connection: 'test', model: 'ctx' } });

    const result = await l.ragIndex({ full: true });

    expect(result?.files).toBe(2);
    expect(endpoint.embeddingBatches.length).toBeGreaterThan(0);
    expect(endpoint.chatCalls).toEqual([]);
  });

  it('turns it on when the setting is on', async () => {
    __setConfig('heapcode', { 'rag.contextualRetrieval': true });
    const l = makeLink({ context: { connection: 'test', model: 'ctx' } });

    await l.ragIndex({ full: true });

    expect(endpoint.chatCalls.some((m) => m.at(-1)!.content.includes('Snippets:'))).toBe(true);
  });

  it('keeps hybrid search on by default, which is what ranks identical vectors', async () => {
    // Every embedding this endpoint returns is [1,0,0], so pure cosine is a
    // tie and only BM25 fusion can put billing.ts first.
    const l = makeLink();
    await l.ragIndex({ full: true });

    const { hits } = await l.ragQuery('chargeCard gateway', 1);

    expect(hits[0]!.path).toBe('billing.ts');
  });

  it('keeps rerank on by default', async () => {
    // Enough chunks that the candidate set exceeds k, which is what makes the
    // rerank stage do anything at all (indexer skips it otherwise).
    for (let i = 0; i < 8; i++) {
      await writeFile(join(root, `m${i}.ts`), `export function fn${i}() {\n  return ${i};\n}\n`);
    }
    const l = makeLink({ rerank: { connection: 'test', model: 'rr' } });
    await l.ragIndex({ full: true });
    const before = endpoint.chatCalls.length;

    await l.ragQuery('fn3', 2);

    expect(endpoint.chatCalls.length).toBe(before + 1);
  });

  it('skips rerank when the setting is off', async () => {
    for (let i = 0; i < 8; i++) {
      await writeFile(join(root, `m${i}.ts`), `export function fn${i}() {\n  return ${i};\n}\n`);
    }
    __setConfig('heapcode', { 'rag.rerank': false });
    const l = makeLink({ rerank: { connection: 'test', model: 'rr' } });
    await l.ragIndex({ full: true });
    const before = endpoint.chatCalls.length;

    await l.ragQuery('fn3', 2);

    expect(endpoint.chatCalls.length).toBe(before);
  });
});

describe('ServerLink RAG — reporting', () => {
  it('reports the index available and its counts through rag/status', async () => {
    const l = makeLink();
    await l.ragIndex({ full: true });

    const status = await l.ragStatus();

    expect(status).toMatchObject({ available: true, state: 'idle', files: 2 });
  });

  it('flags the first build as fresh — the one-time rebuild after the index moved', async () => {
    // Decision 5: the extension's index used to live in its own workspace
    // storage and is deliberately not migrated. `fresh` is what extension.ts
    // turns into a log line so the slow first build has a stated reason.
    const l = makeLink();

    expect((await l.ragIndex({ full: true }))?.fresh).toBe(true);
    expect((await l.ragIndex({ full: true }))?.fresh).toBe(false);
  });

  it('surfaces indexing progress as rag/event notifications', async () => {
    const l = makeLink();
    const events: string[] = [];
    const sub = l.onRagEvent((event) => events.push(event.kind));

    await l.ragIndex({ full: true, runId: 'r1' });
    sub.dispose();

    expect(events).toContain('progress');
    expect(events.at(-1)).toBe('state');
  });

  it('empties the index on clear', async () => {
    const l = makeLink();
    await l.ragIndex({ full: true });

    await l.ragClear();

    expect((await l.ragStatus())?.chunks).toBe(0);
    expect((await l.ragQuery('chargeCard')).hits).toEqual([]);
  });

  it('degrades to an empty result rather than throwing when the server is unreachable', async () => {
    // Every caller — chat @mentions, inline edit, ghost text's manual trigger —
    // treats "no results" and "no server" the same way, so ragQuery never
    // throws and none of them needs its own try/catch.
    const l = new ServerLink(stubProfiles({ name: 'test', preset: 'custom', baseUrl: endpoint.baseUrl, model: 'chat' }), log, {
      address: join(home, 'nothing-here.sock'),
      token: 'x',
      autostart: false,
    });

    expect(await l.ragQuery('anything')).toEqual({ formatted: '', hits: [] });
    expect(await l.ragIndex({ full: true })).toBeUndefined();
    expect(await l.ragStatus()).toBeUndefined();
    l.dispose();
  });
});

describe('ServerLink RAG — a workspace the server cannot read', () => {
  it('tells the server the root is not local, and gets no index', async () => {
    // Decision 3: a virtual or remote-scheme workspace, where only the host can
    // resolve paths. Better than letting the server index whatever `fsPath`
    // happened to produce — the same posture ShadowGit already takes.
    __setWorkspaceRoot(root, 'vscode-vfs');
    const l = makeLink();

    const status = await l.ragStatus();

    expect(status?.available).toBe(false);
    expect(await l.ragIndex({ full: true })).toMatchObject({ files: 0, chunks: 0 });
    expect(endpoint.embeddingBatches).toEqual([]);
    expect((await l.ragQuery('chargeCard')).hits).toEqual([]);
  });

  it('reports unavailable for a root that is not there', async () => {
    __setWorkspaceRoot(join(root, 'does-not-exist'));
    const l = makeLink();

    expect((await l.ragStatus())?.available).toBe(false);
  });
});
