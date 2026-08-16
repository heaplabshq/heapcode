import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { RpcPeer } from '@heapcode/core';
import { webSocketDuplex } from '../src/wsDuplex.js';
import { isLoopback } from '../src/server.js';

/**
 * The framing contract between the browser and `NdjsonChannel`: one JSON
 * object per WebSocket message, no newline on the wire. Everything else in the
 * suite exercises this adapter incidentally; these cases pin the edges that
 * integration tests would not notice until they broke in a browser.
 */

let http: Server;
let wss: WebSocketServer;
let port: number;

beforeEach(async () => {
  http = createServer();
  wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as { port: number }).port;
});

afterEach(async () => {
  wss.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

/** Server side: a peer answering `ping` with the params it received. */
function serveEcho(): void {
  wss.on('connection', (ws) => {
    const peer = new RpcPeer(webSocketDuplex(ws), 's');
    peer.onRequest('ping', async (params) => ({ echoed: params }));
  });
}

async function client(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

describe('webSocketDuplex framing', () => {
  it('sends one JSON object per message, with no trailing newline on the wire', async () => {
    serveEcho();
    const ws = await client();

    const raw = await new Promise<string>((resolve) => {
      ws.once('message', (d: Buffer) => resolve(d.toString('utf8')));
      // A hand-rolled client that knows nothing about NDJSON.
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { hi: true } }));
    });

    expect(raw.endsWith('\n')).toBe(false);
    expect(JSON.parse(raw)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { echoed: { hi: true } } });
    ws.close();
  });

  it('tolerates a client that appends its own newline, without producing a blank record', async () => {
    serveEcho();
    const ws = await client();

    const raw = await new Promise<string>((resolve) => {
      ws.once('message', (d: Buffer) => resolve(d.toString('utf8')));
      ws.send(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: 'x' })}\n`);
    });

    expect(JSON.parse(raw)).toMatchObject({ id: 7, result: { echoed: 'x' } });
    ws.close();
  });

  it('ignores binary frames rather than decoding a second, undocumented encoding', async () => {
    serveEcho();
    const ws = await client();

    let replied = false;
    ws.on('message', () => (replied = true));
    ws.send(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }), 'utf8'), { binary: true });
    await new Promise((r) => setTimeout(r, 120));
    expect(replied).toBe(false);

    // ...and the connection still works for text afterwards.
    const raw = await new Promise<string>((resolve) => {
      ws.once('message', (d: Buffer) => resolve(d.toString('utf8')));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: 'ok' }));
    });
    expect(JSON.parse(raw)).toMatchObject({ id: 3 });
    ws.close();
  });

  it('rejects in-flight requests when the socket closes', async () => {
    wss.on('connection', (ws) => {
      const peer = new RpcPeer(webSocketDuplex(ws), 's');
      // Never answers; the close is what must settle the caller.
      peer.onRequest('hang', () => new Promise<never>(() => {}));
    });
    const ws = await client();
    const peer = new RpcPeer(webSocketDuplex(ws), 'c');
    const pending = peer.request('hang');
    setTimeout(() => ws.close(), 80);
    await expect(pending).rejects.toThrow();
  });
});

describe('isLoopback — decides whether the LAN warning fires', () => {
  it('treats only loopback addresses as private', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    // The two that MUST warn.
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
  });
});
