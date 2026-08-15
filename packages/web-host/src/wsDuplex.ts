import { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

/**
 * A `node:stream` Duplex over a WebSocket, so `RpcPeer` works unchanged.
 *
 * `RpcPeer` takes a Duplex (packages/core/src/server/rpc.ts:66) and frames
 * with `NdjsonChannel`, which appends `\n` on write and splits on `\n` when
 * reading. A WebSocket is already message-framed, so that newline would be
 * redundant on the wire — and worse, it would leak into the browser protocol,
 * forcing every client to remember to append one.
 *
 * So this adapter translates between the two framings:
 *   • inbound  — one WS message → one line (a `\n` is appended for the parser)
 *   • outbound — one line → one WS message (the trailing `\n` is stripped)
 *
 * The browser therefore speaks plain "one JSON object per message", which is
 * what any WebSocket client would expect, while core's framing stays intact.
 * Reusing `RpcPeer` this way is the whole point: bidirectional requests,
 * `$/cancelRequest`, and id correlation are already implemented and tested —
 * a second JSON-RPC implementation for the browser leg is exactly the kind of
 * duplication docs/phase3-protocol-design.md §6 exists to avoid.
 *
 * Binary frames are dropped rather than decoded: this protocol is JSON text,
 * and silently accepting binary would invite a second, undocumented encoding.
 */
export function webSocketDuplex(ws: WebSocket): Duplex {
  let destroyed = false;

  const duplex = new Duplex({
    // NdjsonChannel calls setEncoding('utf8') and expects string chunks.
    read(): void {
      /* pushed from the ws 'message' handler; nothing to pull */
    },

    write(chunk: Buffer | string, _encoding, callback): void {
      if (destroyed || ws.readyState !== ws.OPEN) {
        callback();
        return;
      }
      // One NDJSON line in → one WS message out, newline removed.
      const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).replace(/\n$/, '');
      if (!text) {
        callback();
        return;
      }
      ws.send(text, (err) => callback(err ?? null));
    },

    final(callback): void {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'done');
      callback();
    },

    destroy(err, callback): void {
      destroyed = true;
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
      callback(err);
    },
  });

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) return;
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as Buffer).toString('utf8');
    // Re-add the record separator NdjsonChannel splits on. A client that
    // helpfully sent its own newline must not produce a blank second line.
    duplex.push(text.endsWith('\n') ? text : `${text}\n`);
  });

  ws.on('close', () => {
    if (destroyed) return;
    destroyed = true;
    duplex.push(null);
    // RpcPeer rejects everything outstanding on 'close' (rpc.ts:71).
    duplex.emit('close');
  });

  ws.on('error', (err: Error) => {
    duplex.emit('error', err);
  });

  return duplex;
}
