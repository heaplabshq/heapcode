import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { BlockedUrlError, isBlockedAddress } from './addressGuard.js';

// Re-exported so callers that catch the refusal keep importing from here, as
// they did before the pure half moved to `addressGuard`.
export { BlockedUrlError };

/**
 * SSRF guard for agent-driven HTTP.
 *
 * fetch_url is reachable from content the agent doesn't control — web pages it
 * fetches, MCP server output — both of which the tool list already marks
 * `untrustedOutput` because text in them can steer the model. That flag covers
 * what comes *back*; this covers where the agent is allowed to *go*. Without
 * it, an injected instruction can reach a cloud metadata endpoint
 * (169.254.169.254 hands out IAM credentials), an internal admin service on
 * localhost, or anything else on the user's LAN — and since request data can
 * be smuggled in a query string, the same tool is the way it leaves.
 *
 * Known limitation (deliberate): resolving here and letting fetch resolve
 * again leaves a DNS-rebinding window, where a hostname passes the check and
 * then resolves to a private address microseconds later. Closing it means
 * connecting to the pinned IP and carrying the original Host header, which
 * breaks TLS certificate validation unless done carefully — not worth it for
 * the threat model (a local dev tool), and materially worse if done wrong.
 * The per-hop redirect check below is the more important half in practice:
 * a public URL 302-ing to 169.254.169.254 is the easy version of this attack,
 * and that one is fully closed.
 *
 * The address classification itself lives in `addressGuard.ts` — the pure half
 * of this guard, which a host with no DNS resolution (a browser bundle) can
 * still apply. This module is the half that needs `node:dns`.
 */

/**
 * Throws unless `rawUrl` is http(s) and every address its host resolves to is
 * publicly routable. Exported for tests and for callers that want to validate
 * before doing their own request.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
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
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedUrlError(
        `Refusing to fetch ${url.origin} — it points at a private, loopback, or link-local address. ` +
          'Agent fetches are restricted to public internet hosts.',
      );
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}.`);
  }
  // Every resolved address must be public — a host with one public and one
  // private A record is exactly the shape of a rebinding/bypass attempt.
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedUrlError(
      `Refusing to fetch ${url.origin} — ${host} resolves to a private, loopback, or link-local address. ` +
        'Agent fetches are restricted to public internet hosts.',
    );
  }
  return url;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() with the SSRF guard applied to the initial URL *and to every
 * redirect hop*. Redirects are followed manually (`redirect: 'manual'`)
 * precisely so each new location gets checked — the built-in `redirect:
 * 'follow'` would let a permitted public URL bounce straight into the private
 * range with no further validation.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (!REDIRECT_CODES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res; // a redirect status with nowhere to go — hand it back as-is
    current = new URL(location, url).toString();
  }
  throw new BlockedUrlError(`Too many redirects (>${maxRedirects}) starting from ${rawUrl}.`);
}
