import { decodeHtmlEntities } from './workspaceTools.js';

/**
 * Web search for the agent, shared by every client.
 *
 * heapcode ships no search index of its own, and the providers people already
 * point it at (Ollama, LM Studio, vLLM…) have no web access either — so this
 * follows the same shape as provider presets: a small set of known backends,
 * each normalized to one result type, plus a custom escape hatch. Nothing
 * here is client-specific, so the CLI and the extension both get it by
 * wiring config into `webSearch` and one executor case.
 *
 * Off unless configured. `isWebSearchEnabled` is the single predicate every
 * host checks, so "disabled" cannot come to mean different things in the
 * terminal and the editor.
 *
 * Results are untrusted input in the strongest sense — arbitrary text from
 * arbitrary sites, chosen by a query the model itself wrote. The tool
 * definition marks `untrustedOutput`, so the agent loop wraps results before
 * the model sees them, and the URLs it hands back are just text: following
 * one means calling fetch_url, which applies the full SSRF guard.
 *
 * The request to the search endpoint deliberately does NOT go through
 * safeFetch. That guard exists for destinations untrusted content can choose;
 * a search endpoint is user-configured, putting it in the same trust domain
 * as the model endpoint (see net/safeFetch.ts and localModelReachable.test.ts
 * for that distinction). Routing it through safeFetch would block
 * `http://localhost:8888` and so break self-hosted SearXNG — the one backend
 * here needing no API key and no third party, which would be a perverse thing
 * for a privacy control to forbid. What the endpoint must not do is *move*:
 * redirects are refused outright rather than followed and re-checked, since
 * no real search API needs one and following them is exactly how a configured
 * host would become an arbitrary one.
 */

export const SEARCH_PRESETS = ['duckduckgo', 'brave', 'tavily', 'serper', 'searxng', 'custom'] as const;

export type SearchPresetId = (typeof SEARCH_PRESETS)[number];

export interface SearchProviderPreset {
  id: SearchPresetId;
  label: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  /** Whether an instance can be run locally — surfaced in setup UIs the way `local` is for model providers. */
  selfHosted: boolean;
  /**
   * Smallest gap between two requests to this backend. Brave's free tier is
   * literally one request per second, and DuckDuckGo's HTML endpoint starts
   * returning challenge pages well before that — an agent that fires three
   * searches in a row would otherwise rate-limit itself on its first task.
   */
  minIntervalMs: number;
  hint: string;
}

export const searchPresets: readonly SearchProviderPreset[] = [
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    // DuckDuckGo publishes no general search API. api.duckduckgo.com is the
    // Instant Answer endpoint, and it is not an index: a probe for "zig
    // comptime" returned an empty abstract, zero Results and zero
    // RelatedTopics. The HTML endpoint is the only one that answers a
    // developer query with actual links, so that is what this parses — with
    // the caveats that buys, documented on parseDuckDuckGoHtml.
    defaultBaseUrl: 'https://html.duckduckgo.com/html/',
    requiresApiKey: false,
    selfHosted: false,
    minIntervalMs: 2_000,
    hint: 'No key or signup — but unofficial, and rate-limits quickly',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    defaultBaseUrl: 'https://api.search.brave.com/res/v1/web/search',
    requiresApiKey: true,
    selfHosted: false,
    minIntervalMs: 1_100,
    hint: 'Independent index, generous free tier — api.search.brave.com',
  },
  {
    id: 'tavily',
    label: 'Tavily',
    defaultBaseUrl: 'https://api.tavily.com/search',
    requiresApiKey: true,
    selfHosted: false,
    minIntervalMs: 0,
    hint: 'Built for agents — returns cleaned snippets rather than raw SERP text',
  },
  {
    id: 'serper',
    label: 'Serper',
    defaultBaseUrl: 'https://google.serper.dev/search',
    requiresApiKey: true,
    selfHosted: false,
    minIntervalMs: 0,
    hint: 'Google results via API',
  },
  {
    id: 'searxng',
    label: 'SearXNG',
    defaultBaseUrl: 'http://localhost:8888/search',
    requiresApiKey: false,
    selfHosted: true,
    minIntervalMs: 0,
    hint: 'Self-hosted metasearch — no key, no signup, no third party',
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    defaultBaseUrl: '',
    requiresApiKey: false,
    selfHosted: false,
    minIntervalMs: 0,
    hint: 'Any endpoint returning Brave/Tavily/Serper/SearXNG-shaped JSON',
  },
];

export function getSearchPreset(id: SearchPresetId): SearchProviderPreset {
  return searchPresets.find((p) => p.id === id) ?? searchPresets[searchPresets.length - 1]!;
}

export function isSearchPresetId(value: unknown): value is SearchPresetId {
  return typeof value === 'string' && (SEARCH_PRESETS as readonly string[]).includes(value);
}

/**
 * Persisted config. The API key is deliberately absent: it travels the same
 * custody path as provider keys (the CLI's secrets.json, the extension's
 * SecretStorage) and is passed to `webSearch` at call time, never written
 * into a config file.
 */
export interface WebSearchConfig {
  /** Absent means the feature was never set up — the tool stays refused. */
  provider?: SearchPresetId;
  /** Overrides the preset's endpoint. */
  baseUrl?: string;
  /** Hard cap on results returned to the model. */
  maxResults?: number;
  /** Per-attempt timeout in ms; defaults to 15s. Retries get a fresh one each. */
  timeoutMs?: number;
  /**
   * Explicit off switch that survives having a provider configured — lets a
   * user keep their key and endpoint while turning search off for a while.
   * Defaults to on when a provider is set.
   */
  enabled?: boolean;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Where the search API key is stored, alongside provider keys. Reserved
 * shape (leading/trailing underscores) so it cannot collide with a profile
 * name in the CLI's secrets.json, and so the extension's SecretStorage key
 * matches it without a second convention to remember.
 */
export const WEB_SEARCH_SECRET_NAME = '__websearch__';

export const DEFAULT_SEARCH_RESULTS = 5;
export const MAX_SEARCH_RESULTS_LIMIT = 10;
/** Per-result snippet cap — enough to judge relevance, not enough for one page to flood the window. */
export const MAX_SNIPPET_CHARS = 500;
const SEARCH_TIMEOUT_MS = 15_000;

/** What the model is told when it calls the tool without search configured. */
export const WEB_SEARCH_DISABLED_NOTICE =
  'web_search is disabled. It is off by default and has to be turned on with a search provider ' +
  'before it will run — DuckDuckGo needs no API key, and Brave, Tavily, Serper or a self-hosted ' +
  'SearXNG are also available. Do not claim to have searched the web. Either continue without it, ' +
  'or tell the user how to enable it: "/websearch duckduckgo" in the terminal, or the ' +
  'heapcode.webSearch settings in the extension.';

/**
 * Configured *and* not explicitly switched off. Hosts call this to decide
 * whether to execute; the tool itself stays visible either way (see the note
 * on the tool definition).
 */
export function isWebSearchEnabled(config: WebSearchConfig | undefined, apiKey?: string): boolean {
  if (!config?.provider) return false;
  if (config.enabled === false) return false;
  const preset = getSearchPreset(config.provider);
  if (preset.requiresApiKey && !apiKey) return false;
  return Boolean(config.baseUrl || preset.defaultBaseUrl);
}

/**
 * Why search is unavailable, for a status line — distinguishes "never set up"
 * from "set up but missing its key", which are very different fixes.
 */
export function describeWebSearchState(config: WebSearchConfig | undefined, apiKey?: string): string {
  if (!config?.provider) return 'disabled (no search provider configured)';
  const preset = getSearchPreset(config.provider);
  if (config.enabled === false) return `off (${preset.label} configured — turn back on to use it)`;
  if (preset.requiresApiKey && !apiKey) return `${preset.label} — needs an API key`;
  if (!config.baseUrl && !preset.defaultBaseUrl) return `${preset.label} — needs a base URL`;
  return `on (${preset.label})`;
}

function clampResults(n: number | undefined): number {
  if (!Number.isFinite(n) || !n || n < 1) return DEFAULT_SEARCH_RESULTS;
  return Math.min(Math.floor(n), MAX_SEARCH_RESULTS_LIMIT);
}

function clean(text: unknown): string {
  const s = typeof text === 'string' ? text : '';
  // Search snippets routinely carry the engine's own <strong> highlighting,
  // and entity-escaped punctuation (&#x27; for an apostrophe) on top of it.
  const stripped = decodeHtmlEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  return stripped.length > MAX_SNIPPET_CHARS ? `${stripped.slice(0, MAX_SNIPPET_CHARS)}…` : stripped;
}

/** Shapes each backend returns, narrowed just enough to normalize them. */
interface RawResults {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  results?: Array<{ title?: string; url?: string; content?: string; snippet?: string }>;
  organic?: Array<{ title?: string; link?: string; snippet?: string }>;
}

/**
 * One normalizer for every backend: they differ only in which key holds the
 * array and what the snippet field is called, so matching on shape rather
 * than on the configured preset means a `custom` endpoint imitating any of
 * them works without extra config.
 */
export function normalizeSearchResults(body: unknown, limit: number): WebSearchResult[] {
  const raw = (body ?? {}) as RawResults;
  const rows: Array<{ title?: string; url?: string; link?: string; description?: string; content?: string; snippet?: string }> =
    raw.web?.results ?? raw.results ?? raw.organic ?? [];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({
      title: clean(r.title) || '(untitled)',
      url: typeof r.url === 'string' ? r.url : typeof r.link === 'string' ? r.link : '',
      snippet: clean(r.description ?? r.content ?? r.snippet),
    }))
    .filter((r) => r.url)
    .slice(0, limit);
}

/**
 * DuckDuckGo's HTML results page → structured results.
 *
 * This is scraping, and it is the only way to get general web results from
 * DuckDuckGo — there is no public search API (see the note on the preset).
 * That has three consequences worth stating plainly rather than discovering
 * later: the markup can change without warning, the endpoint rate-limits
 * aggressively (hence minIntervalMs and the retry policy below), and it can
 * answer 200 with a challenge page instead of results. `looksLikeDdgChallenge`
 * exists so that last case reports itself as rate limiting rather than as
 * "no results found", which would otherwise send the model off telling the
 * user their query had no matches.
 *
 * Each result link is wrapped in DuckDuckGo's own redirector
 * (`//duckduckgo.com/l/?uddg=<encoded target>`), so the real URL has to be
 * lifted out of the query string — handing the model the wrapper would make
 * every follow-up fetch_url a redirect through duckduckgo.com.
 */
const DDG_RESULT = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const DDG_SNIPPET = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

function unwrapDdgUrl(href: string): string {
  const raw = href.startsWith('//') ? `https:${href}` : href;
  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return '';
  }
}

/** A 200 that is really a rate-limit/bot challenge rather than results. */
export function looksLikeDdgChallenge(html: string): boolean {
  if (DDG_RESULT.test(html)) {
    DDG_RESULT.lastIndex = 0;
    return false;
  }
  DDG_RESULT.lastIndex = 0;
  return /anomaly|challenge|captcha|unusual traffic|blocked/i.test(html);
}

export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const snippets: string[] = [];
  DDG_SNIPPET.lastIndex = 0;
  for (let m = DDG_SNIPPET.exec(html); m; m = DDG_SNIPPET.exec(html)) snippets.push(clean(m[1]));

  const out: WebSearchResult[] = [];
  DDG_RESULT.lastIndex = 0;
  for (let m = DDG_RESULT.exec(html); m && out.length < limit; m = DDG_RESULT.exec(html)) {
    const url = unwrapDdgUrl(m[1]!.replace(/&amp;/g, '&'));
    if (!url || !/^https?:/i.test(url)) continue;
    out.push({ title: clean(m[2]) || '(untitled)', url, snippet: snippets[out.length] ?? '' });
  }
  return out;
}

function buildRequest(
  config: WebSearchConfig,
  apiKey: string | undefined,
  query: string,
  limit: number,
): { url: string; init: RequestInit } {
  const preset = getSearchPreset(config.provider ?? 'custom');
  const base = config.baseUrl || preset.defaultBaseUrl;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'HeapCode-Agent' };

  switch (config.provider) {
    case 'duckduckgo': {
      const url = new URL(base);
      url.searchParams.set('q', query);
      return {
        url: url.toString(),
        init: {
          // The HTML endpoint prefers a form POST and is markedly less likely
          // to challenge one than a bare GET. A browser user-agent is
          // required rather than cosmetic: the default one is served a
          // near-empty page.
          method: 'POST',
          headers: {
            accept: 'text/html',
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          body: new URLSearchParams({ q: query }).toString(),
        },
      };
    }
    case 'tavily':
      // The only backend here that wants a POST body; the key goes in it.
      return {
        url: base,
        init: {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey, query, max_results: limit }),
        },
      };
    case 'serper':
      return {
        url: base,
        init: {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'X-API-KEY': apiKey ?? '' },
          body: JSON.stringify({ q: query, num: limit }),
        },
      };
    case 'brave': {
      const url = new URL(base);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(limit));
      return {
        url: url.toString(),
        init: { headers: { ...headers, 'X-Subscription-Token': apiKey ?? '' } },
      };
    }
    case 'searxng':
    default: {
      const url = new URL(base);
      url.searchParams.set('q', query);
      // SearXNG serves HTML unless asked for JSON; harmless on a custom endpoint.
      if (!url.searchParams.has('format')) url.searchParams.set('format', 'json');
      return {
        url: url.toString(),
        init: { headers: apiKey ? { ...headers, authorization: `Bearer ${apiKey}` } : headers },
      };
    }
  }
}

/**
 * Run a search. Throws with a message meant for the model — a failed search
 * should tell it what went wrong so it can adapt, not just fail silently.
 */
/**
 * Rate-limit bookkeeping, per backend, for the life of the process. Search
 * runs from a tool call, so nothing upstream serializes it: an agent that
 * decides to run three searches issues them back to back, which is precisely
 * what trips Brave's one-per-second free tier and DuckDuckGo's bot
 * detection. Spacing them here is cheaper than discovering the limit as a
 * 429 and then waiting out a much longer penalty.
 */
const lastRequestAt = new Map<string, number>();

async function throttle(providerId: string, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const previous = lastRequestAt.get(providerId) ?? 0;
  const wait = previous + minIntervalMs - Date.now();
  // Reserved before awaiting, so two concurrent calls queue behind each other
  // instead of both reading the same stale timestamp and firing together.
  lastRequestAt.set(providerId, Math.max(Date.now(), previous + minIntervalMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const RETRYABLE_SEARCH_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_SEARCH_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 10_000;

/** Honors Retry-After (seconds, or an HTTP date) when the server sends one. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Run a search.
 *
 * Retries 429/5xx with exponential backoff, mirroring the provider client's
 * policy (providers/openaiCompatible.ts) so the two behave the same way under
 * load. Throws with a message meant for the model — a failed search should
 * say what went wrong so it can adapt, not fail silently.
 */
export async function webSearch(
  config: WebSearchConfig,
  apiKey: string | undefined,
  query: string,
  maxResults?: number,
): Promise<WebSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('Search query was empty.');
  const limit = clampResults(maxResults ?? config.maxResults);
  const providerId = config.provider ?? 'custom';
  const preset = getSearchPreset(providerId);
  const base = config.baseUrl || preset.defaultBaseUrl;
  if (!base) throw new Error('No search endpoint configured.');

  const { url, init } = buildRequest(config, apiKey, trimmed, limit);
  const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : SEARCH_TIMEOUT_MS;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
    await throttle(providerId, preset.minIntervalMs);
    // A fresh controller per attempt: the timeout bounds each try, not the
    // whole retry sequence, or the last attempt would inherit an already-fired
    // abort and never actually run.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // redirect: 'error' — see the module note. The destination is the user's
      // own configured endpoint; a redirect would be the one way that stops
      // being true, so it fails rather than being followed.
      const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });

      if (!res.ok) {
        if (RETRYABLE_SEARCH_STATUS.has(res.status) && attempt < MAX_SEARCH_ATTEMPTS) {
          const after = retryAfterMs(res.headers.get('retry-after'));
          await sleepBeforeRetry(attempt, after);
          lastError = new Error(`Search failed: HTTP ${res.status} ${res.statusText}.`);
          continue;
        }
        throw new Error(`Search failed: HTTP ${res.status} ${res.statusText}.${describeStatus(res.status, preset)}`);
      }

      // DuckDuckGo answers HTML; everything else answers JSON.
      if (providerId === 'duckduckgo') {
        const html = await res.text();
        if (looksLikeDdgChallenge(html)) {
          if (attempt < MAX_SEARCH_ATTEMPTS) {
            await sleepBeforeRetry(attempt);
            lastError = new Error('DuckDuckGo returned a rate-limit challenge instead of results.');
            continue;
          }
          throw new Error(
            'DuckDuckGo is rate-limiting this machine (it answered with a challenge page, not results). ' +
              'Wait a minute and retry, or configure a keyed provider (Brave, Tavily, Serper) or a self-hosted SearXNG.',
          );
        }
        return parseDuckDuckGoHtml(html, limit);
      }

      const body: unknown = await res.json().catch(() => undefined);
      if (body === undefined) throw new Error('Search endpoint did not return JSON.');
      return normalizeSearchResults(body, limit);
    } catch (err) {
      const error =
        err instanceof Error && err.name === 'AbortError'
          ? new Error(`Search timed out after ${Math.round(timeoutMs / 1000)}s.`)
          : err instanceof Error
            ? err
            : new Error(String(err));
      // A timeout is worth one more try; a thrown non-retryable HTTP error is not.
      const retryable = error.message.startsWith('Search timed out');
      if (retryable && attempt < MAX_SEARCH_ATTEMPTS) {
        lastError = error;
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('Search failed.');
}

function describeStatus(status: number, preset: SearchProviderPreset): string {
  if (status === 401 || status === 403) return ' Check the search API key.';
  if (status === 429) {
    return preset.requiresApiKey
      ? ` ${preset.label} is rate-limiting or out of quota — wait, or check your plan's limits.`
      : ` ${preset.label} is rate-limiting this machine — wait a minute, or switch to a keyed provider.`;
  }
  return '';
}

async function sleepBeforeRetry(attempt: number, retryAfter?: number): Promise<void> {
  const backoff = retryAfter ?? 500 * 2 ** (attempt - 1) + Math.random() * 250;
  await new Promise((r) => setTimeout(r, Math.min(backoff, MAX_BACKOFF_MS)));
}

/**
 * Results as the model sees them. URLs are listed so it can follow up with
 * fetch_url — search returns snippets, and a snippet is rarely enough to
 * answer from, so the two tools are meant to be used together.
 */
export function formatSearchResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const body = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n');
  return `Search results for "${query}":\n\n${body}\n\nUse fetch_url on any of these to read the full page.`;
}
