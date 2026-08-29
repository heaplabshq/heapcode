import type { Duplex } from 'node:stream';
import { NdjsonChannel } from './ndjson.js';
import {
  CANCEL_METHOD,
  isNotification,
  isRequest,
  isResponse,
  RPC_ERRORS,
  type CancelParams,
  type RpcId,
  type RpcMessage,
  type RpcRequest,
} from './protocol.js';

export type RequestHandler = (params: unknown, signal: AbortSignal) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

/**
 * Rejection for a call the caller aborted. Named `AbortError` on purpose: it
 * makes a cancellation that crossed the socket indistinguishable from an
 * in-process one, so the agent loop's existing abort handling
 * (packages/core/src/agent/loop.ts:709, via isAbortError) yields outcome
 * 'stopped' rather than surfacing "Tool failed: cancelled" or throwing out of
 * agent/run entirely.
 */
function abortError(): Error {
  const err = new Error('cancelled');
  err.name = 'AbortError';
  return err;
}

class RpcCallError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcCallError';
  }
}

/**
 * A symmetric JSON-RPC peer over an NDJSON channel: either side may send
 * requests, notifications, and responses. Symmetry is the point — the server
 * has to be able to ask the host to execute a tool and wait for the answer
 * (docs/phase3-protocol-design.md §1's correction).
 *
 * `idPrefix` distinguishes the two directions' request ids. Strictly this
 * isn't required — each side matches responses against ids it issued itself,
 * and a request is told apart from a response by carrying `method` — but
 * distinct prefixes make a captured stream readable, which is most of why
 * NDJSON was chosen (§1).
 */
export class RpcPeer {
  private readonly channel: NdjsonChannel;
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  /** In-flight inbound requests, so `$/cancelRequest` can abort the work we started for the peer. */
  private readonly inbound = new Map<RpcId, AbortController>();
  private closed = false;

  /** Told once when the transport goes, so a caller can reconnect rather than wedge. */
  private readonly closeHandlers = new Set<() => void>();

  constructor(
    stream: Duplex,
    private readonly idPrefix: string,
    private readonly onError?: (err: Error) => void,
  ) {
    this.channel = new NdjsonChannel(stream, (m) => this.dispatch(m), onError);
    stream.on('close', () => this.fail(new Error('connection closed')));
    stream.on('error', (err: Error) => this.fail(err));
  }

  /**
   * Run `handler` when this connection ends, for whatever reason.
   *
   * A daemon exits — because it was rebuilt, because it went idle, because
   * someone killed it — and without this the host holds a dead peer and every
   * later request rejects with "connection closed" forever. The socket already
   * knew; nothing was listening.
   */
  onClose(handler: () => void): void {
    if (this.closed) {
      handler();
      return;
    }
    this.closeHandlers.add(handler);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  notify(method: string, params?: unknown): boolean {
    return this.channel.write({ jsonrpc: '2.0', method, params });
  }

  /** Notify, waiting for the peer to catch up if it's behind (§5 backpressure). */
  async notifyWithBackpressure(method: string, params?: unknown): Promise<void> {
    if (!this.notify(method, params) && !this.closed) await this.channel.drain();
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = `${this.idPrefix}${this.nextId++}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.channel.write({ jsonrpc: '2.0', id, method, params });

    if (signal) {
      const onAbort = (): void => {
        // Tell the peer to stop, and settle locally — an aborted caller
        // shouldn't wait on a peer that may never answer.
        if (!this.closed) this.notify(CANCEL_METHOD, { id } satisfies CancelParams);
        this.pending.get(id)?.reject(abortError());
        this.pending.delete(id);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    return promise;
  }

  private dispatch(message: RpcMessage): void {
    if (isResponse(message)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return; // already cancelled or unknown id
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(
          message.error.code === RPC_ERRORS.cancelled
            ? abortError()
            : new RpcCallError(message.error.message, message.error.code, message.error.data),
        );
      }
      else waiter.resolve(message.result);
      return;
    }

    if (isNotification(message)) {
      if (message.method === CANCEL_METHOD) {
        const { id } = (message.params ?? {}) as CancelParams;
        this.inbound.get(id)?.abort();
        return;
      }
      const handler = this.notificationHandlers.get(message.method);
      if (handler) {
        try {
          handler(message.params);
        } catch (err) {
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return;
    }

    if (isRequest(message)) void this.serve(message);
  }

  private async serve(message: RpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.channel.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: RPC_ERRORS.methodNotFound, message: `Unknown method: ${message.method}` },
      });
      return;
    }
    const controller = new AbortController();
    this.inbound.set(message.id, controller);
    try {
      const result = await handler(message.params, controller.signal);
      if (!this.closed) this.channel.write({ jsonrpc: '2.0', id: message.id, result: result ?? null });
    } catch (err) {
      const cancelled = controller.signal.aborted;
      if (!this.closed) {
        this.channel.write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: cancelled ? RPC_ERRORS.cancelled : RPC_ERRORS.internalError,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } finally {
      this.inbound.delete(message.id);
    }
  }

  /** Reject everything outstanding — used on close and on transport error. */
  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
    for (const [, controller] of this.inbound) controller.abort();
    this.inbound.clear();
    // After the rejections, so a handler that reconnects does not race the
    // failures belonging to the connection it is replacing.
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const handler of handlers) handler();
  }

  close(): void {
    this.fail(new Error('connection closed'));
    this.channel.close();
  }
}
