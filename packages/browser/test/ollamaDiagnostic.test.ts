import { describe, expect, it } from 'vitest';
import { describe as summarize, diagnose, ollamaOriginsFix } from '../src/shared/ollamaDiagnostic.js';
import { originPatternFor } from '../src/shared/hostPermission.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnop';

/** A fetch that behaves like a browser: CORS failures throw, they do not return. */
function fetchStub(handler: (url: string, init?: RequestInit) => Response | Error) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const outcome = handler(String(input), init);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as typeof fetch;
}

const corsFailure = () => new TypeError('Failed to fetch');

/** Chrome has granted access to the endpoint. `chrome` does not exist here. */
const granted = async () => true;

describe('endpoint diagnosis', () => {
  it('reports ok when the endpoint answers and we may read it', async () => {
    const result = await diagnose(
      'http://localhost:11434/v1',
      ORIGIN,
      undefined,
      fetchStub(() => new Response('{"data":[]}', { status: 200 })),
      granted,
    );
    expect(result.kind).toBe('ok');
  });

  it('distinguishes a refused origin from a dead endpoint', async () => {
    // Ollama is running but our origin is not in OLLAMA_ORIGINS: the normal
    // request is blocked by CORS and throws, while the no-cors request is
    // actually sent and something answers it.
    const result = await diagnose(
      'http://localhost:11434/v1',
      ORIGIN,
      undefined,
      fetchStub((_url, init) =>
        init?.mode === 'no-cors' ? new Response('', { status: 200 }) : corsFailure(),
      ),
      granted,
    );
    expect(result.kind).toBe('origin-blocked');
    if (result.kind === 'origin-blocked') {
      expect(result.origin).toBe(ORIGIN);
      expect(result.fix).toContain('OLLAMA_ORIGINS');
    }
  });

  it('reports unreachable when nothing answers either request', async () => {
    const result = await diagnose(
      'http://localhost:11434/v1',
      ORIGIN,
      undefined,
      fetchStub(() => corsFailure()),
      granted,
    );
    expect(result.kind).toBe('unreachable');
  });

  it('surfaces an HTTP rejection rather than calling it a connectivity problem', async () => {
    // We could read the response, so connectivity is fine — the endpoint is
    // objecting. Calling this "unreachable" would send the user to fix the
    // wrong thing.
    const result = await diagnose(
      'https://api.openai.com/v1',
      ORIGIN,
      'wrong-key',
      fetchStub(() => new Response('{"error":"invalid api key"}', { status: 401 })),
      granted,
    );
    expect(result.kind).toBe('http-error');
    expect(summarize(result)).toMatch(/API key/i);
  });

  it('sends the API key on the probe, so a keyed endpoint is not misdiagnosed', async () => {
    let seen: string | undefined;
    await diagnose(
      'https://api.openai.com/v1',
      ORIGIN,
      'sk-test',
      fetchStub((_url, init) => {
        seen = new Headers(init?.headers).get('authorization') ?? undefined;
        return new Response('{}', { status: 200 });
      }),
      granted,
    );
    expect(seen).toBe('Bearer sk-test');
  });

  it('probes the models endpoint of the configured base URL, trailing slash or not', async () => {
    const urls: string[] = [];
    const record = fetchStub((url) => {
      urls.push(url);
      return new Response('{}', { status: 200 });
    });
    await diagnose('http://localhost:11434/v1/', ORIGIN, undefined, record, granted);
    await diagnose('http://localhost:11434/v1', ORIGIN, undefined, record, granted);
    expect(urls).toEqual([
      'http://localhost:11434/v1/models',
      'http://localhost:11434/v1/models',
    ]);
  });
});

describe('host permission', () => {
  it('reports a missing grant instead of probing and blaming the server', async () => {
    // Without the grant the browser blocks the request before it leaves, which
    // looks identical to a dead endpoint. Saying "unreachable" here would send
    // the user to restart a server that was running the whole time.
    let fetched = false;
    const result = await diagnose(
      'https://ollama.com/v1',
      ORIGIN,
      'key',
      fetchStub(() => {
        fetched = true;
        return new Response('{}', { status: 200 });
      }),
      async () => false,
    );
    expect(result.kind).toBe('no-permission');
    if (result.kind === 'no-permission') expect(result.pattern).toBe('https://ollama.com/*');
    expect(fetched).toBe(false);
  });
});

describe('a 403 from a keyless endpoint', () => {
  it('is read as a refused origin, not a bad API key', async () => {
    // Ollama rejects a chrome-extension origin server-side with 403, and once
    // the host grant is in place that 403 becomes readable. Treating it as a
    // credential problem would point at a key the endpoint never wanted.
    const result = await diagnose(
      'http://localhost:11434/v1',
      ORIGIN,
      undefined,
      fetchStub(() => new Response('Forbidden', { status: 403 })),
      granted,
    );
    expect(result.kind).toBe('origin-blocked');
    if (result.kind === 'origin-blocked') expect(result.fix).toContain('OLLAMA_ORIGINS');
  });

  it('is still read as a bad key when a key was actually sent', async () => {
    const result = await diagnose(
      'https://ollama.com/v1',
      ORIGIN,
      'wrong-key',
      fetchStub(() => new Response('Forbidden', { status: 403 })),
      granted,
    );
    expect(result.kind).toBe('http-error');
    expect(summarize(result)).toMatch(/API key/i);
  });
});

describe('the OLLAMA_ORIGINS fix text', () => {
  // The command is platform specific and easy to get wrong in a way that looks
  // right: on macOS the variable has to reach the launchd environment the menu
  // bar app inherits, so a shell `export` silently does nothing.
  it('uses launchctl on macOS, not export', () => {
    const fix = ollamaOriginsFix(ORIGIN, 'MacIntel');
    expect(fix).toContain('launchctl setenv OLLAMA_ORIGINS');
    expect(fix).not.toContain('export ');
  });

  it('uses setx on Windows', () => {
    expect(ollamaOriginsFix(ORIGIN, 'Win32')).toContain('setx OLLAMA_ORIGINS');
  });

  it('uses systemd elsewhere', () => {
    expect(ollamaOriginsFix(ORIGIN, 'Linux x86_64')).toContain('systemctl');
  });

  it('embeds the actual extension origin, which is not knowable at build time', () => {
    for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
      expect(ollamaOriginsFix(ORIGIN, platform)).toContain(ORIGIN);
    }
  });
});

describe('origin patterns', () => {
  it('covers the whole origin of a base URL, port included', () => {
    expect(originPatternFor('https://ollama.com/v1')).toBe('https://ollama.com/*');
    expect(originPatternFor('http://192.168.29.92:11434/v1')).toBe('http://192.168.29.92:11434/*');
    expect(originPatternFor('http://localhost:11434/v1/')).toBe('http://localhost:11434/*');
  });

  it('refuses anything that is not http(s), rather than producing a pattern Chrome will reject', () => {
    expect(originPatternFor('file:///etc/passwd')).toBeUndefined();
    expect(originPatternFor('not a url')).toBeUndefined();
    expect(originPatternFor('')).toBeUndefined();
  });
});
