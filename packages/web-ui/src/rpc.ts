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

import { desktopBridge } from './desktop.js';

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

/**
 * `signed-out` is the one state retrying cannot fix: the server is up but no
 * longer accepts this page's cookie. Retrying it anyway is what used to get
 * every window on the machine blocked as a brute-force attempt.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'signed-out';

/** web-host's sign-in check (server.ts): 204 when signed in, 401 when not. */
export const AUTH_CHECK_PATH = '/auth-check';

/** Waits between reconnect attempts; the last repeats. Reset by a successful open. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export interface RpcClientOptions {
  /**
   * Called once when a failed reconnect turns out to be a lost sign-in.
   * Defaults to asking the desktop app to sign the window back in; a plain
   * browser tab has no way to, so it only shows the state.
   */
  onSignedOut?: () => void;
  /** Injected for tests. */
  fetch?: typeof fetch;
  retryDelaysMs?: readonly number[];
}

/** What to tell someone whose page was signed out, wherever it runs. */
export function signedOutMessage(): string {
  return desktopBridge()?.signIn
    ? 'Signed out of the Heap Code server — signing back in…'
    : 'Signed out — open the link `heapcode web` printed to sign back in.';
}

export class RpcClient {
  private ws?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve(v: unknown): void; reject(e: Error): void }>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private closedByUs = false;
  /** Failed attempts since the last open; picks the next wait. */
  private failures = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly retryDelaysMs: readonly number[];
  private readonly fetchImpl: typeof fetch;
  private readonly onSignedOut: () => void;

  /**
   * Called after every (re)connection, including automatic ones. The caller
   * uses this to re-send `ui/hello` — a reconnect must re-establish session
   * state, not silently sit on a live socket with a stale view.
   */
  onOpen?: () => void;

  constructor(
    private readonly url: string,
    private readonly onStatus: (status: ConnectionStatus) => void,
    options: RpcClientOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.onSignedOut = options.onSignedOut ?? (() => desktopBridge()?.signIn?.());
  }

  connect(): void {
    this.closedByUs = false;
    clearTimeout(this.retryTimer);
    this.onStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.failures = 0;
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
      if (this.closedByUs || ws !== this.ws) return;
      // A socket that was up and dropped (sleep, a restarted network process)
      // most likely just needs another try. One that never opened was refused
      // or found nothing listening — and a browser hides which, so ask.
      if (opened) this.retryLater();
      else void this.afterFailedOpen();
    };

    ws.onerror = () => {
      /* onclose always follows; handling it twice would double the retry */
    };
  }

  close(): void {
    this.closedByUs = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  private async afterFailedOpen(): Promise<void> {
    if (await this.signedOut()) {
      if (this.closedByUs) return;
      // No retry: the cookie will not get better by being sent again, and
      // each refusal counts toward the server blocking this address.
      this.onStatus('signed-out');
      this.onSignedOut();
      return;
    }
    if (!this.closedByUs) this.retryLater();
  }

  /** True only on a definite "not signed in"; a server that is down is not that. */
  private async signedOut(): Promise<boolean> {
    const check = new URL(this.url);
    check.protocol = check.protocol === 'wss:' ? 'https:' : 'http:';
    check.pathname = AUTH_CHECK_PATH;
    check.search = '';
    try {
      const res = await this.fetchImpl(check.toString(), { credentials: 'same-origin', cache: 'no-store' });
      return res.status === 401 || res.status === 429;
    } catch {
      return false;
    }
  }

  /** Backs off rather than knocking once a second for as long as the tab is open. */
  private retryLater(): void {
    const delays = this.retryDelaysMs;
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 1_000;
    this.failures += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
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
