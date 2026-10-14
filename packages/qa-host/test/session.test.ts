import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcPeer } from '@heapcode/core';
import type { ConfigStore, SecretsStore } from '@heapcode/host';
import { QaSession } from '../src/session.js';
import { QA_METHODS, type QaEvent, type QaState } from '../src/protocol.js';

/** A stand-in for the page's socket: requests in, notifications out. */
function fakePeer() {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const events: QaEvent[] = [];
  const states: QaState[] = [];
  const peer = {
    onRequest: (method: string, h: (p: unknown) => Promise<unknown>) => handlers.set(method, h),
    notify: (method: string, params: unknown) => {
      if (method === QA_METHODS.event) events.push(params as QaEvent);
      if (method === QA_METHODS.stateChanged) states.push(params as QaState);
      return true;
    },
    request: async () => ({ allow: false }),
  } as unknown as RpcPeer;
  const call = <T>(method: string, params: unknown = {}): Promise<T> => handlers.get(method)!(params) as Promise<T>;
  return { peer, call, events, states };
}

const noModel = { resolve: async () => undefined } as unknown as ConfigStore;
const noSecrets = {} as SecretsStore;

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/' ? '<!doctype html><title>Home</title><h1>Hello</h1>' : '<h1>Other</h1>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(() => new Promise((r) => server.close(r)), 60_000);

const until = async (check: () => boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('QaSession', { timeout: 60_000 }, () => {
  it('sets up a folder, runs a flow with live events, and serves only its results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heapqa-session-'));
    const session = new QaSession({ root, config: noModel, secrets: noSecrets, lan: false });
    const { peer, call, events } = fakePeer();
    session.attach(peer);

    const before = await call<{ state: QaState }>(QA_METHODS.hello);
    expect(before.state.folder).toBeUndefined();
    expect(before.state.suggestedFolder).toBe(join(root, 'heapqa'));

    const after = await call<QaState>(QA_METHODS.init);
    expect(after.folder).toBe(join(root, 'heapqa'));
    expect(after.flows.map((f) => f.id)).toEqual(['home']);
    writeFileSync(join(root, 'heapqa', 'heapqa.yaml'), `baseUrl: ${base}\nheal: similarity\n`);

    const { runId } = await call<{ runId: string }>(QA_METHODS.run, { flows: [] });
    await expect(call(QA_METHODS.run, {})).rejects.toThrow(/Busy/);
    await until(() => events.some((e) => e.type === 'runEnd' || e.type === 'error'));
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.filter((e) => e.type === 'step').map((e) => (e as { step: { status: string } }).step.status)).toEqual(['passed', 'passed']);
    expect(events.at(-1)).toMatchObject({ type: 'runEnd', runId, passed: 1, failed: 0 });

    // The job ends just after its last event, when the browser has closed.
    let state = await call<QaState>(QA_METHODS.state);
    for (let i = 0; state.busy && i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      state = await call<QaState>(QA_METHODS.state);
    }
    expect(state.busy).toBeUndefined();
    expect(state.runs[0]).toMatchObject({ id: runId, kind: 'run', passed: 1 });
    expect(state.flows[0]!.last).toEqual({ status: 'passed', runId });

    const detail = await call<{ kind: string; summary: { flows: unknown[] } }>(QA_METHODS.runDetail, { runId });
    expect(detail.kind).toBe('run');
    const report = await session.attachment(`runs/${runId}/report.html`);
    expect(report?.mediaType).toMatch(/^text\/html/);
    expect(report?.bytes.toString()).toContain('All 1 passed');
    expect(await session.attachment(`runs/${runId}/screenshots/home/1.png`)).toMatchObject({ mediaType: 'image/png' });
    expect(await session.attachment('runs/../heapqa.yaml')).toBeUndefined();
    expect(await session.attachment(`runs/${runId}/../../.env.test`)).toBeUndefined();
    await expect(call(QA_METHODS.runDetail, { runId: '../x' })).rejects.toThrow(/No such run/);
    await session.close();
  });

  it('finds an existing test folder in the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heapqa-session-'));
    const { initWorkspace } = await import('@heapcode/qa');
    initWorkspace(join(root, 'qa'));
    const session = new QaSession({ root, config: noModel, secrets: noSecrets, lan: true });
    expect((await session.state()).folder).toBe(join(root, 'qa'));
    expect((await session.state()).lan).toBe(true);
  });
});
