import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcClient, signedOutMessage, type ConnectionStatus } from '../src/rpc.js';

/** Just enough of a browser WebSocket for RpcClient: open, close, nothing sent. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (ev: unknown) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** The server refused it, or the connection dropped. */
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  close(): void {
    this.drop();
  }
  send(): void {}
}

const latest = (): FakeSocket => FakeSocket.all[FakeSocket.all.length - 1]!;

/** A fetch that answers the sign-in check with this status, or fails like a dead server. */
function checkAnswering(status: number | 'down') {
  return vi.fn(async (_url: string) => {
    if (status === 'down') throw new TypeError('Failed to fetch');
    return new Response(null, { status });
  });
}

/** Let the sign-in check's promise settle without running any timers. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('RpcClient reconnects', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('backs off instead of retrying once a second forever', async () => {
    const fetch = checkAnswering(204);
    const client = new RpcClient('ws://127.0.0.1:7411/rpc', () => {}, { fetch, retryDelaysMs: [1_000, 2_000, 4_000] });
    client.connect();

    const waits: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      latest().drop();
      await settle();
      const before = FakeSocket.all.length;
      let waited = 0;
      while (FakeSocket.all.length === before) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      waits.push(waited);
    }
    // The last wait repeats rather than growing without end.
    expect(waits).toEqual([1_000, 2_000, 4_000, 4_000]);
    client.close();
  });

  it('starts over from the shortest wait once a connection opens', async () => {
    const fetch = checkAnswering(204);
    const client = new RpcClient('ws://127.0.0.1:7411/rpc', () => {}, { fetch, retryDelaysMs: [1_000, 8_000] });
    client.connect();
    latest().drop();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    latest().open();

    // Up for a while, then dropped — sleep, say. Back in a second, not eight.
    latest().drop();
    const before = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all.length).toBe(before + 1);
    client.close();
  });

  it('does not ask the server about sign-in when an open socket merely dropped', async () => {
    const fetch = checkAnswering(401);
    const client = new RpcClient('ws://127.0.0.1:7411/rpc', () => {}, { fetch });
    client.connect();
    latest().open();
    latest().drop();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    client.close();
  });

  for (const status of [401, 429]) {
    it(`stops retrying and reports signed-out when the server answers ${status}`, async () => {
      const fetch = checkAnswering(status);
      const onSignedOut = vi.fn();
      const statuses: ConnectionStatus[] = [];
      const client = new RpcClient('ws://127.0.0.1:7411/rpc', (s) => statuses.push(s), { fetch, onSignedOut });
      client.connect();
      latest().drop();
      await settle();

      expect(statuses.at(-1)).toBe('signed-out');
      expect(onSignedOut).toHaveBeenCalledTimes(1);
      // Every extra refusal would count toward blocking this address.
      const sockets = FakeSocket.all.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(FakeSocket.all.length).toBe(sockets);
    });
  }

  it('keeps retrying when the server is simply not there', async () => {
    const fetch = checkAnswering('down');
    const onSignedOut = vi.fn();
    const statuses: ConnectionStatus[] = [];
    const client = new RpcClient('ws://127.0.0.1:7411/rpc', (s) => statuses.push(s), { fetch, onSignedOut });
    client.connect();
    latest().drop();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onSignedOut).not.toHaveBeenCalled();
    expect(statuses).not.toContain('signed-out');
    expect(FakeSocket.all.length).toBe(2);
    client.close();
  });

  it('asks the root sign-in check, whichever product socket it uses', async () => {
    const fetch = checkAnswering(204);
    const client = new RpcClient('ws://127.0.0.1:7411/chat/rpc', () => {}, { fetch });
    client.connect();
    latest().drop();
    await settle();
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:7411/auth-check');
    client.close();
  });

  it('a closed client schedules nothing more', async () => {
    const fetch = checkAnswering(204);
    const client = new RpcClient('ws://127.0.0.1:7411/rpc', () => {}, { fetch });
    client.connect();
    latest().open();
    latest().drop(); // a retry is now pending
    client.close();
    const sockets = FakeSocket.all.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all.length).toBe(sockets);
  });

  it('by default asks the desktop app to sign the window back in', async () => {
    const signIn = vi.fn();
    vi.stubGlobal('heapDesktop', { signIn });
    const client = new RpcClient('ws://127.0.0.1:7411/rpc', () => {}, { fetch: checkAnswering(401) });
    client.connect();
    latest().drop();
    await settle();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signedOutMessage()).toMatch(/signing back in/);
  });

  it('in a plain browser tab, says how to sign back in', () => {
    expect(signedOutMessage()).toMatch(/heapcode web/);
  });
});
