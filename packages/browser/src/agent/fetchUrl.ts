import { BlockedUrlError, htmlToText, isBlockedAddress, MAX_FETCH_CHARS } from '@heapcode/core/agent';

/**
 * fetch_url for a context that has no DNS: core's `safeFetch` cannot be
 * used here (it resolves the hostname with `node:dns` before fetching, so
 * the guard can judge every address a name resolves to), and a browser
 * cannot do that — `fetch` resolves internally, before any code of ours
 * runs. So this applies the half of the SSRF guard a browser *can* apply:
 *
 * - only http(s) URLs are fetched;
 * - a literal IP in the host is checked against the same blocked ranges
 *   (core's `addressGuard`, the exact same list `safeFetch` uses);
 * - the address the browser actually landed on is checked the same way, and
 *   a body that arrived from a blocked one is thrown away unread.
 *
 * WHY THE REDIRECT CHECK IS AFTER THE FACT, NOT PER HOP
 * Core's `safeFetch` passes `redirect: 'manual'` so it can read each `Location`
 * and vet the next hop before requesting it. That works under Node. In a
 * browser it does not work at all: per the Fetch spec, redirect mode `manual`
 * yields an *opaque-redirect* response — `type` is `'opaqueredirect'`, `status`
 * is `0`, `ok` is false and the headers are empty — so there is no `Location`
 * to read and nothing to follow. Copying core's loop here meant every
 * redirecting URL (plain http → https, apex → www, every link shortener) died
 * as `HTTP 0`, and the tests missed it because a stubbed `fetch` hands back a
 * real 302 that no browser ever would.
 *
 * So the browser follows the chain itself and we judge `res.url`, the address
 * it ended on. The honest cost: a redirect into a private address is *issued*
 * before we can refuse it, where core would have refused it first. What that
 * is worth in this context: the extension holds host permissions only for
 * origins the user granted, so a redirect elsewhere is refused by CORS and
 * arrives unreadable anyway, and Chrome's own extension network isolation sits
 * under both. We still refuse to hand the model the body.
 *
 * What remains open either way is the DNS-rebinding window core documents on
 * `safeFetch`: a *hostname* that resolves to a private address. Nothing a page
 * context runs can close it, so the literal-IP and landing-address checks are
 * the floor.
 *
 * The other browser reality is CORS. Without a host grant, a cross-origin
 * fetch from the panel succeeds only where the site sends
 * `Access-Control-Allow-Origin` for an extension origin, which almost
 * nothing does — so a failure names both causes and steers to the
 * heapbrowse-native fallback: open the page in a tab and read it with
 * `get_page_text`, which no site can refuse.
 */

const TIMEOUT_MS = 20_000;

/** Parse and literal-IP-check one address. Throws `BlockedUrlError` on refusal. */
function guard(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('Only http(s) URLs are supported.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // `isBlockedAddress` refuses anything that is not a literal IP — hostnames
  // pass through here by design, since this half cannot resolve them.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isBlockedAddress(host)) {
      throw new BlockedUrlError(
        `Refusing to fetch ${url.origin} — it points at a private, loopback, or link-local address. ` +
          'Agent fetches are restricted to public internet hosts.',
      );
    }
  }
  return url;
}

export async function fetchUrl(rawUrl: string): Promise<string> {
  const url = guard(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    // `redirect: 'follow'` — the default, and the only mode that works here.
    // See the header: `manual` returns an opaque redirect a browser cannot
    // read, and `error` would refuse the http → https hop most sites open with.
    res = await fetch(url, { redirect: 'follow', signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timed out fetching ${url}`);
    }
    // A network failure, a CORS refusal and a redirect loop are the same
    // TypeError here; name the real causes rather than guessing one.
    throw new Error(
      `Could not fetch ${url.host}: either the site refuses to be read this way (most do not ` +
        'allow cross-origin reads from an extension) or it is unreachable. Open the page in a ' +
        'tab and read it with get_page_text instead.',
    );
  } finally {
    clearTimeout(timer);
  }

  // Where it actually landed. `res.url` is the address after every redirect the
  // browser followed; it is empty on a stubbed or opaque response, in which
  // case there is nothing new to judge and the entry check stands.
  if (res.url && res.url !== url.toString()) guard(res.url);

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const type = res.headers.get('content-type') ?? '';
  let body = await res.text();
  if (type.includes('html')) body = htmlToText(body);
  if (body.length > MAX_FETCH_CHARS) body = body.slice(0, MAX_FETCH_CHARS) + '\n…[truncated]';
  return body.trim() || '(empty response)';
}
