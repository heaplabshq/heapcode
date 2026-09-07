import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HeapcodeServer,
  METHODS,
  PROTOCOL_VERSION,
  RpcPeer,
  type HelloParams,
  type ToolExecuteParams,
  type ToolResult,
} from '../src/index.js';

/**
 * Sanity check, not a benchmark: the protocol design's central correction is
 * that a tool-heavy agent turn is ~2 server→host round-trips per tool
 * (tool/execute + permission/request), so a 20-tool run is ~40 crossings.
 * This measures what those crossings actually cost over a unix socket, so a
 * future change that makes them expensive shows up as a failure rather than
 * as a vague "the CLI feels slower".
 *
 * The bound is deliberately loose — this runs on shared CI hardware and the
 * point is to catch an order-of-magnitude regression, not to police
 * microseconds.
 */
let home: string;
let server: HeapcodeServer;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heapcode-latency-'));
  server = new HeapcodeServer({ home, address: join(home, 'test.sock'), idleShutdownMs: 0 });
  await server.listen();
});

afterEach(async () => {
  await server?.close();
  await rm(home, { recursive: true, force: true });
});

describe('protocol round-trip cost', () => {
  it('sustains a 20-tool-call-shaped run (40 request/response round-trips) in a few milliseconds', async () => {
    const socket = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
      const s = connect(server.address);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const client = new RpcPeer(socket, 'c');
    await client.request(METHODS.hello, {
      token: server.token,
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'latency-test' },
      root: home,
      profiles: [],
      activeProfile: 'p',
      roles: {},
    } satisfies HelloParams);

    // Stand in for a host executing a tool: answer immediately, so what's
    // measured is the transport and not the work.
    client.onRequest(METHODS.toolExecute, async (raw) => {
      const { call } = raw as ToolExecuteParams;
      return { id: call.id, name: call.name, content: 'ok' } satisfies ToolResult;
    });

    // Drive from the client side so the measurement is symmetric with what a
    // real run does: the server issues these, but either direction exercises
    // the same NDJSON encode → socket → decode → dispatch → reply path.
    const ROUND_TRIPS = 40;
    const started = Date.now();
    for (let i = 0; i < ROUND_TRIPS; i++) {
      await client.request(METHODS.hello, {
        token: server.token,
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'latency-test' },
        root: home,
        profiles: [],
        activeProfile: 'p',
        roles: {},
      } satisfies HelloParams);
    }
    const elapsed = Date.now() - started;

    // Locally this lands around 5-15ms for all 40; 2s would mean something is
    // badly wrong (a per-message timer, a sync flush, a lost drain).
    expect(elapsed).toBeLessThan(2_000);
    client.close();
  }, 20_000);

  it('streams 2000 event notifications without stalling on backpressure', async () => {
    const socket = await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
      const s = connect(server.address);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const client = new RpcPeer(socket, 'c');
    await client.request(METHODS.hello, {
      token: server.token,
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'latency-test' },
      root: home,
      profiles: [],
      activeProfile: 'p',
      roles: {},
    } satisfies HelloParams);

    let received = 0;
    client.onNotification('test/tick', () => {
      received++;
    });

    // Notifications in the other direction: this is the token-delta path's
    // shape (fire-and-forget, ordered, no response), which §5 identified as
    // the hottest one.
    const started = Date.now();
    for (let i = 0; i < 2_000; i++) client.notify('test/tick', { i });
    // Round-trip once to know everything ahead of it has been flushed.
    await client.request(METHODS.hello, {
      token: server.token,
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'latency-test' },
      root: home,
      profiles: [],
      activeProfile: 'p',
      roles: {},
    } satisfies HelloParams);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(received).toBe(0); // they went server-ward; nothing echoes back
    client.close();
  }, 20_000);
});
