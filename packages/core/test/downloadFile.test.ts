import { describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('../src/net/safeFetch.js', () => ({ safeFetch }));

const { downloadFile, formatBytes, MAX_DOWNLOAD_BYTES } = await import('../src/agent/workspaceTools.js');

/** A response whose body streams `chunks`, with whatever headers are given. */
function streaming(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

const collect = () => {
  const out: number[] = [];
  return { out, write: (c: Uint8Array) => void out.push(...c) };
};

describe('downloadFile', () => {
  it('streams the body through to the writer and reports what arrived', async () => {
    safeFetch.mockResolvedValueOnce(
      streaming([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], {
        'content-type': 'image/png; charset=binary',
        'content-length': '5',
      }),
    );
    const sink = collect();
    const res = await downloadFile('https://example.com/a.png', sink.write);
    expect(sink.out).toEqual([1, 2, 3, 4, 5]);
    expect(res.bytes).toBe(5);
    // Parameters stripped: the model gets `image/png`, not the charset noise.
    expect(res.contentType).toBe('image/png');
  });

  it('refuses a file the server declares as too large, before reading a byte', async () => {
    safeFetch.mockResolvedValueOnce(
      streaming([new Uint8Array([1])], { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) }),
    );
    const sink = collect();
    await expect(downloadFile('https://example.com/big.iso', sink.write)).rejects.toThrow(/over the .*limit/);
    expect(sink.out).toHaveLength(0);
  });

  it('still stops a server that under-declares its size', async () => {
    // The declaration is a claim, not a fact — and omitting content-length is
    // legal for a chunked response, so the running total is the real guard.
    const chunk = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 101 }, () => chunk);
    safeFetch.mockResolvedValueOnce(streaming(chunks));
    await expect(downloadFile('https://example.com/lies', () => {})).rejects.toThrow(/exceeds the .*limit/);
  });

  it('treats an empty body as a failure, not a successful download', async () => {
    // A zero-byte file looks like success to every tool downstream.
    safeFetch.mockResolvedValueOnce(streaming([]));
    await expect(downloadFile('https://example.com/nothing', () => {})).rejects.toThrow(/empty file/);
  });

  it('surfaces the status when the server refuses', async () => {
    safeFetch.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(downloadFile('https://example.com/gone', () => {})).rejects.toThrow(/HTTP 404/);
  });
});

describe('formatBytes', () => {
  it('reads at the scale a person thinks in', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
