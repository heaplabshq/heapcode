import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate } from '../src/updateCheck.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('checkForUpdate', () => {
  it('reports an available update when the registry has a newer version', async () => {
    stubFetch(async (url) => {
      expect(url).toBe('https://registry.npmjs.org/@heapcode/cli/latest');
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
    });
    const result = await checkForUpdate('@heapcode/cli', '0.1.0');
    expect(result).toEqual({ current: '0.1.0', latest: '0.2.0' });
  });

  it('resolves to undefined when already on the latest version', async () => {
    stubFetch(async () => new Response(JSON.stringify({ version: '0.1.0' }), { status: 200 }));
    expect(await checkForUpdate('@heapcode/cli', '0.1.0')).toBeUndefined();
  });

  it('resolves to undefined when the installed version is somehow newer than the registry (never suggests a downgrade)', async () => {
    stubFetch(async () => new Response(JSON.stringify({ version: '0.1.0' }), { status: 200 }));
    expect(await checkForUpdate('@heapcode/cli', '0.2.0')).toBeUndefined();
  });

  it('compares numeric segments, not lexical order (0.10.0 beats 0.9.0)', async () => {
    stubFetch(async () => new Response(JSON.stringify({ version: '0.10.0' }), { status: 200 }));
    expect(await checkForUpdate('@heapcode/cli', '0.9.0')).toEqual({ current: '0.9.0', latest: '0.10.0' });
  });

  it('never throws — a 404 (package not actually published yet) resolves to undefined', async () => {
    stubFetch(async () => new Response('{"error":"Not found"}', { status: 404 }));
    await expect(checkForUpdate('@heapcode/cli', '0.1.0')).resolves.toBeUndefined();
  });

  it('never throws — a network failure resolves to undefined', async () => {
    stubFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    });
    await expect(checkForUpdate('@heapcode/cli', '0.1.0')).resolves.toBeUndefined();
  });

  it('never hangs — aborts and resolves to undefined once the timeout elapses', async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    await expect(checkForUpdate('@heapcode/cli', '0.1.0', 20)).resolves.toBeUndefined();
  });
});
