import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeWebSearchState,
  formatSearchResults,
  isSearchPresetId,
  isWebSearchEnabled,
  looksLikeDdgChallenge,
  normalizeSearchResults,
  parseDuckDuckGoHtml,
  searchPresets,
  webSearch,
  WEB_SEARCH_DISABLED_NOTICE,
  MAX_SNIPPET_CHARS,
  type WebSearchConfig,
} from '../src/agent/webSearch.js';
import { sharedAgentTools } from '../src/agent/toolDefinitions.js';
import { decodeHtmlEntities, htmlToText } from '../src/agent/workspaceTools.js';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server | undefined;

/** A stand-in search endpoint that records what it was asked and answers with `body`. */
async function startSearchServer(
  body: unknown,
  opts: { status?: number; redirectTo?: string } = {},
): Promise<{ baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw });
      if (opts.redirectTo) {
        res.writeHead(302, { location: opts.redirectTo });
        return res.end();
      }
      res.writeHead(opts.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/search`, requests };
}


/** Like startSearchServer, but the caller decides how each request is answered. */
async function startSearchServerDynamic(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ baseUrl: string }> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', () => (raw += ''));
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/search` };
}

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe('isWebSearchEnabled', () => {
  it('is off when nothing is configured — the default', () => {
    expect(isWebSearchEnabled(undefined)).toBe(false);
    expect(isWebSearchEnabled({})).toBe(false);
  });

  it('is off for a key-requiring provider with no key', () => {
    expect(isWebSearchEnabled({ provider: 'brave' })).toBe(false);
    expect(isWebSearchEnabled({ provider: 'brave' }, 'k')).toBe(true);
  });

  it('is on for a keyless provider that has a default endpoint', () => {
    expect(isWebSearchEnabled({ provider: 'searxng' })).toBe(true);
  });

  it('honours the explicit off switch even when fully configured', () => {
    expect(isWebSearchEnabled({ provider: 'brave', enabled: false }, 'k')).toBe(false);
  });

  it('is off for custom with no baseUrl, since the preset supplies none', () => {
    expect(isWebSearchEnabled({ provider: 'custom' })).toBe(false);
    expect(isWebSearchEnabled({ provider: 'custom', baseUrl: 'https://x/search' })).toBe(true);
  });
});

describe('describeWebSearchState', () => {
  it('distinguishes never-configured from missing-key', () => {
    expect(describeWebSearchState(undefined)).toMatch(/no search provider/);
    expect(describeWebSearchState({ provider: 'brave' })).toMatch(/needs an API key/);
    expect(describeWebSearchState({ provider: 'brave' }, 'k')).toMatch(/^on /);
  });
});

describe('normalizeSearchResults', () => {
  it('reads the Brave shape', () => {
    const out = normalizeSearchResults(
      { web: { results: [{ title: 'A', url: 'https://a', description: 'da' }] } },
      5,
    );
    expect(out).toEqual([{ title: 'A', url: 'https://a', snippet: 'da' }]);
  });

  it('reads the Tavily shape', () => {
    const out = normalizeSearchResults({ results: [{ title: 'B', url: 'https://b', content: 'cb' }] }, 5);
    expect(out).toEqual([{ title: 'B', url: 'https://b', snippet: 'cb' }]);
  });

  it('reads the Serper shape, whose url field is called link', () => {
    const out = normalizeSearchResults({ organic: [{ title: 'C', link: 'https://c', snippet: 'sc' }] }, 5);
    expect(out).toEqual([{ title: 'C', url: 'https://c', snippet: 'sc' }]);
  });

  it('strips the engine’s own highlight markup out of snippets', () => {
    const out = normalizeSearchResults(
      { results: [{ title: '<strong>T</strong>', url: 'https://a', content: 'a <strong>hit</strong> here' }] },
      5,
    );
    expect(out[0]!.title).toBe('T');
    expect(out[0]!.snippet).toBe('a hit here');
  });

  it('caps snippet length so one result cannot flood the context window', () => {
    const out = normalizeSearchResults({ results: [{ title: 'T', url: 'https://a', content: 'x'.repeat(5_000) }] }, 5);
    expect(out[0]!.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 1);
  });

  it('drops rows with no URL and honours the limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://x/${i}` }));
    rows.push({ title: 'no url', url: '' as string });
    expect(normalizeSearchResults({ results: rows }, 3)).toHaveLength(3);
  });

  it('returns nothing for a shape it does not recognize', () => {
    expect(normalizeSearchResults({ unexpected: true }, 5)).toEqual([]);
    expect(normalizeSearchResults(undefined, 5)).toEqual([]);
  });
});

describe('webSearch requests', () => {
  it('sends Brave its key as a header and the query as a param', async () => {
    const { baseUrl, requests } = await startSearchServer({ web: { results: [] } });
    await webSearch({ provider: 'brave', baseUrl }, 'secret-key', 'rust lifetimes', 3);
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toContain('q=rust+lifetimes');
    expect(requests[0]!.url).toContain('count=3');
    expect(requests[0]!.headers['x-subscription-token']).toBe('secret-key');
  });

  it('sends Tavily a POST body carrying the key', async () => {
    const { baseUrl, requests } = await startSearchServer({ results: [] });
    await webSearch({ provider: 'tavily', baseUrl }, 'tv-key', 'zig comptime', 2);
    expect(requests[0]!.method).toBe('POST');
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ api_key: 'tv-key', query: 'zig comptime', max_results: 2 });
  });

  it('asks SearXNG for JSON, since it serves HTML by default', async () => {
    const { baseUrl, requests } = await startSearchServer({ results: [] });
    await webSearch({ provider: 'searxng', baseUrl }, undefined, 'ripgrep');
    expect(requests[0]!.url).toContain('format=json');
  });

  it('clamps max_results to the hard ceiling', async () => {
    const { baseUrl, requests } = await startSearchServer({ web: { results: [] } });
    await webSearch({ provider: 'brave', baseUrl }, 'k', 'q', 999);
    expect(requests[0]!.url).toContain('count=10');
  });

  it('refuses an empty query without making a request', async () => {
    const { baseUrl, requests } = await startSearchServer({ results: [] });
    await expect(webSearch({ provider: 'searxng', baseUrl }, undefined, '   ')).rejects.toThrow(/empty/i);
    expect(requests).toHaveLength(0);
  });

  it('points at the API key on a 401', async () => {
    const { baseUrl } = await startSearchServer({}, { status: 401 });
    await expect(webSearch({ provider: 'brave', baseUrl }, 'bad', 'q')).rejects.toThrow(/Check the search API key/);
  });

  /**
   * The endpoint is user-configured and so may be local (that is the whole
   * point of self-hosted SearXNG), but it must not be able to *move* — a
   * redirect is how a configured host would turn into an arbitrary one.
   */
  it('refuses to follow a redirect away from the configured endpoint', async () => {
    const { baseUrl } = await startSearchServer({}, { redirectTo: 'http://169.254.169.254/latest/meta-data/' });
    await expect(webSearch({ provider: 'searxng', baseUrl }, undefined, 'q')).rejects.toThrow();
  });

  it('reaches a localhost endpoint — self-hosted SearXNG must work', async () => {
    const { baseUrl } = await startSearchServer({ results: [{ title: 'T', url: 'https://a', content: 'c' }] });
    expect(baseUrl).toContain('127.0.0.1');
    await expect(webSearch({ provider: 'searxng', baseUrl }, undefined, 'q')).resolves.toHaveLength(1);
  });
});

describe('formatSearchResults', () => {
  it('lists URLs and points the model at fetch_url for full pages', () => {
    const text = formatSearchResults('q', [{ title: 'T', url: 'https://a', snippet: 's' }]);
    expect(text).toContain('https://a');
    expect(text).toContain('fetch_url');
  });

  it('says plainly when there is nothing', () => {
    expect(formatSearchResults('nothing', [])).toMatch(/No results for "nothing"/);
  });
});

describe('the tool itself', () => {
  it('is marked untrusted, like fetch_url and MCP output', () => {
    expect(sharedAgentTools.web_search!.untrustedOutput).toBe(true);
    expect(sharedAgentTools.web_search!.permission).toBe('execute');
  });

  /** A model that is told nothing invents a search; the notice must forbid that explicitly. */
  it('tells the model not to claim it searched, and how to enable it', () => {
    expect(WEB_SEARCH_DISABLED_NOTICE).toMatch(/not claim/i);
    expect(WEB_SEARCH_DISABLED_NOTICE).toMatch(/websearch/i);
  });

  it('only accepts the known preset ids', () => {
    expect(isSearchPresetId('brave')).toBe(true);
    expect(isSearchPresetId('off')).toBe(false);
    expect(isSearchPresetId(undefined)).toBe(false);
  });
});

describe('config shape', () => {
  it('never carries the API key', () => {
    const config: WebSearchConfig = { provider: 'brave', baseUrl: 'https://x', maxResults: 5, enabled: true };
    expect(Object.keys(config)).not.toContain('apiKey');
  });
});

/**
 * Markup captured from a live html.duckduckgo.com response — including the
 * `/l/?uddg=` redirect wrapper every result link carries, and the `%2D`
 * escaping their encoder emits for hyphens.
 */
const DDG_HTML = `
<div id="links" class="results">
<div class="result results_links web-result">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust%2Dlang.org%2Frust%2Dby%2Dexample%2Fscope%2Flifetime.html&amp;rut=69a25f">Lifetimes - <b>Rust</b> By Example</a>
</h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust%2Dlang.org%2F">A <b>lifetime</b> is a construct the compiler uses.</a>
</div>
<div class="result results_links web-result">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fziglang.org%2F&amp;rut=aa">Zig</a>
</h2>
<a class="result__snippet" href="#">General purpose language.</a>
</div>
</div>`;

describe('DuckDuckGo HTML parsing', () => {
  it('lifts the real URL out of the /l/?uddg= redirect wrapper', () => {
    const out = parseDuckDuckGoHtml(DDG_HTML, 5);
    // Handing back the wrapper would route every follow-up fetch_url through
    // duckduckgo.com — and that host is not what the model was told about.
    expect(out[0]!.url).toBe('https://doc.rust-lang.org/rust-by-example/scope/lifetime.html');
    expect(out[0]!.url).not.toContain('duckduckgo.com');
  });

  it('strips markup from titles and pairs each snippet with its result', () => {
    const out = parseDuckDuckGoHtml(DDG_HTML, 5);
    expect(out[0]!.title).toBe('Lifetimes - Rust By Example');
    expect(out[0]!.snippet).toBe('A lifetime is a construct the compiler uses.');
    expect(out[1]!.title).toBe('Zig');
    expect(out[1]!.snippet).toBe('General purpose language.');
  });

  it('honours the limit', () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1);
  });

  it('returns nothing rather than garbage for an unrecognized page', () => {
    expect(parseDuckDuckGoHtml('<html><body>nope</body></html>', 5)).toEqual([]);
  });

  /**
   * The important distinction: a challenge page is a 200 with no results, and
   * reporting it as "no results" would have the model tell the user their
   * query matched nothing when it was really rate limiting.
   */
  it('tells a rate-limit challenge apart from a genuinely empty result set', () => {
    expect(looksLikeDdgChallenge('<html>unusual traffic detected</html>')).toBe(true);
    expect(looksLikeDdgChallenge('<html>please solve this captcha</html>')).toBe(true);
    expect(looksLikeDdgChallenge(DDG_HTML)).toBe(false);
    expect(looksLikeDdgChallenge('<html>no results for your query</html>')).toBe(false);
  });

  it('decodes hex entities, which DuckDuckGo uses for apostrophes', () => {
    const out = parseDuckDuckGoHtml(
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com">Rust&#x27;s &amp; Zig&#39;s</a>',
      5,
    );
    expect(out[0]!.title).toBe("Rust's & Zig's");
  });

  it('is stateless across calls despite the module-level regexes', () => {
    // Global regexes carry lastIndex; reusing one without resetting silently
    // returns different results on the second call.
    expect(parseDuckDuckGoHtml(DDG_HTML, 5)).toEqual(parseDuckDuckGoHtml(DDG_HTML, 5));
    expect(looksLikeDdgChallenge(DDG_HTML)).toBe(looksLikeDdgChallenge(DDG_HTML));
  });
});

describe('rate limiting and retries', () => {
  it('retries a 429 and succeeds on the next attempt', async () => {
    let hits = 0;
    const { baseUrl } = await startSearchServerDynamic((_req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'T', url: 'https://a', content: 'c' }] }));
    });
    await expect(webSearch({ provider: 'custom', baseUrl }, undefined, 'q')).resolves.toHaveLength(1);
    expect(hits).toBe(2);
  });

  it('gives up after 3 attempts and names rate limiting in the message', async () => {
    let hits = 0;
    const { baseUrl } = await startSearchServerDynamic((_req, res) => {
      hits++;
      res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
      res.end('{}');
    });
    await expect(webSearch({ provider: 'custom', baseUrl }, undefined, 'q')).rejects.toThrow(/429/);
    expect(hits).toBe(3);
  });

  it('does not retry a 401 — a bad key will not fix itself', async () => {
    let hits = 0;
    const { baseUrl } = await startSearchServerDynamic((_req, res) => {
      hits++;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await expect(webSearch({ provider: 'brave', baseUrl }, 'bad', 'q')).rejects.toThrow(/API key/);
    expect(hits).toBe(1);
  });

  it('times out per attempt rather than across the whole retry sequence', async () => {
    const { baseUrl } = await startSearchServerDynamic(() => {
      /* never responds */
    });
    const started = Date.now();
    await expect(
      webSearch({ provider: 'custom', baseUrl, timeoutMs: 150 }, undefined, 'q'),
    ).rejects.toThrow(/timed out/i);
    // 3 attempts × 150ms each, not one 150ms budget for all of them.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  }, 10_000);

  it('spaces requests to backends that rate-limit by clock', () => {
    expect(searchPresets.find((p) => p.id === 'duckduckgo')!.minIntervalMs).toBeGreaterThan(0);
    // Brave's free tier is one request per second.
    expect(searchPresets.find((p) => p.id === 'brave')!.minIntervalMs).toBeGreaterThanOrEqual(1_000);
    expect(searchPresets.find((p) => p.id === 'searxng')!.minIntervalMs).toBe(0);
  });
});

/**
 * A search backend that is not there.
 *
 * `fetch` reports every transport failure as the same four characters, and
 * that string is what reached the model. It is indistinguishable from a
 * transient hiccup, so the model treated it as one: it abandoned search
 * without comment and rebuilt the answer from fifty-one shell calls instead.
 * The cost was never the failed request; it was the hour of substitutes.
 */
describe('a search endpoint that cannot be reached', () => {
  it('names the endpoint and what to do, instead of "fetch failed"', async () => {
    // A high port nothing binds — a genuine refused connection.
    await expect(
      webSearch({ provider: 'searxng', baseUrl: 'http://127.0.0.1:59999/search' }, undefined, 'anything'),
    ).rejects.toThrow(/nothing is listening at http:\/\/127\.0\.0\.1:59999/);
  });

  it('says to start it, for a backend the user hosts themselves', async () => {
    await expect(
      webSearch({ provider: 'searxng', baseUrl: 'http://127.0.0.1:59999/search' }, undefined, 'anything'),
    ).rejects.toThrow(/Start your SearXNG instance/);
  });

  it('tells the model not to paper over it', async () => {
    // The behaviour this exists to prevent: quietly substituting other tools
    // for search and never mentioning that search is down.
    await expect(
      webSearch({ provider: 'searxng', baseUrl: 'http://127.0.0.1:59999/search' }, undefined, 'anything'),
    ).rejects.toThrow(/say so rather than working around it/);
  });

  it('distinguishes a name that does not resolve from a port nobody answers', async () => {
    await expect(
      webSearch(
        { provider: 'custom', baseUrl: 'http://heapcode-no-such-host.invalid/search' },
        undefined,
        'anything',
      ),
    ).rejects.toThrow(/could not be resolved/);
  }, 15_000);
});

/** Shared with fetch_url's htmlToText, which had the same hex-entity gap. */
describe('decodeHtmlEntities', () => {
  it('handles named, decimal and hex escapes', () => {
    expect(decodeHtmlEntities('a &amp; b &#39;c&#39; &#x27;d&#x27; &lt;e&gt;')).toBe("a & b 'c' 'd' <e>");
  });

  it('decodes the ampersand last, so &amp;lt; does not become a tag', () => {
    expect(decodeHtmlEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('ignores an out-of-range code point rather than throwing', () => {
    expect(() => decodeHtmlEntities('&#x11FFFF;')).not.toThrow();
  });

  it('reaches fetch_url output too', () => {
    expect(htmlToText('<p>Rust&#x27;s</p>')).toContain("Rust's");
  });
});
