import type { Duplex } from 'node:stream';
import type { RpcMessage } from './protocol.js';

/**
 * Newline-delimited JSON over a duplex stream.
 *
 * Framing is one JSON object per line. JSON.stringify never emits a raw
 * newline inside a string (they come out as `\n`), so a bare `\n` is
 * unambiguously a record separator — no escaping layer needed.
 *
 * Backpressure is honored rather than ignored: a fast local model can emit
 * deltas faster than a slow host reads them, and unbounded buffering in the
 * server is the failure mode docs/phase3-protocol-design.md §5 calls out.
 * `write()` reports whether the stream wants a pause, and `drain()` is the
 * matching wait.
 */
export class NdjsonChannel {
  private buffer = '';
  private closed = false;

  constructor(
    private readonly stream: Duplex,
    private readonly onMessage: (message: RpcMessage) => void,
    private readonly onError?: (err: Error) => void,
  ) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => this.consume(chunk));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          this.onMessage(JSON.parse(line) as RpcMessage);
        } catch (err) {
          // A malformed line is a framing failure, not a protocol error we
          // can respond to (there is no id to respond about) — surface it and
          // keep reading, since the next line may well be intact.
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Returns false when the peer is behind and the caller should await drain(). */
  write(message: RpcMessage): boolean {
    if (this.closed) return false;
    return this.stream.write(`${JSON.stringify(message)}\n`);
  }

  drain(): Promise<void> {
    return new Promise((resolve) => this.stream.once('drain', resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.end();
  }
}
