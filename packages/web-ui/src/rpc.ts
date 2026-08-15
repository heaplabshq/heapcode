/**
 * A JSON-RPC 2.0 peer over a browser WebSocket.
 *
 * Deliberately NOT core's `RpcPeer`: that one is built on `node:stream` and
 * cannot run in a browser. This is the same protocol from the other side —
 * roughly eighty lines, because the wire format is small and the host's
 * `wsDuplex` adapter already spares us NDJSON framing (one JSON object per
 * message, no newline).
 *
 * Symmetric, like its counterpart: the host issues requests at us
 * (`ui/permissionRequest`, `ui/askUser`) and waits for an answer, so this has
 * to serve as well as call.
 */

type Id = string | number;

interface Req {
  jsonrpc: '2.0';
  id: Id;
  method: string;
  params?: unknown;
}
interface Note {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
interface Res {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}
type Msg = Req | Note | Res;

export type RequestHandler = (params: unknown) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

export class RpcClient {
  private ws?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private closedByUs = false;

  /**
   * Called after every (re)connection, including automatic ones. The caller
   * uses this to re-send `ui/hello` — a reconnect must re-establish session
   * state, not silently sit on a live socket with a stale view.
   */
  onOpen?: () => void;

  constructor(
    private readonly url: string,
    private readonly onStatus: (status: 'connecting' | 'open' | 'closed') => void,
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.onStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.onStatus('open');
      this.onOpen?.();
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: Msg;
      try {
        msg = JSON.parse(ev.data) as Msg;
      } catch {
        return; // a malformed frame is a framing bug, not something to act on
      }
      this.dispatch(msg);
    };

    ws.onclose = () => {
      this.onStatus('closed');
      // Everything outstanding must settle — a hung promise is a spinner that
      // never stops, which reads to the user as the app being broken.
      for (const [, waiter] of this.pending) waiter.reject(new Error('connection closed'));
      this.pending.clear();
      if (!this.closedByUs) setTimeout(() => this.connect(), 1_000);
    };

    ws.onerror = () => {
      /* onclose always follows; handling it twice would double the retry */
    };
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'));
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private dispatch(msg: Msg): void {
    if ('id' in msg && !('method' in msg)) {
      const res = msg as Res;
      const waiter = this.pending.get(res.id);
      if (!waiter) return;
      this.pending.delete(res.id);
      if (res.error) waiter.reject(new Error(res.error.message));
      else waiter.resolve(res.result);
      return;
    }

    if ('method' in msg && 'id' in msg) {
      void this.serve(msg as Req);
      return;
    }

    const note = msg as Note;
    this.notificationHandlers.get(note.method)?.(note.params);
  }

  private async serve(req: Req): Promise<void> {
    const handler = this.requestHandlers.get(req.method);
    if (!handler) {
      this.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } });
      return;
    }
    try {
      const result = await handler(req.params);
      this.send({ jsonrpc: '2.0', id: req.id, result: result ?? null });
    } catch (err) {
      this.send({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private send(msg: Msg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
