import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

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
 */

/** Address ranges that must never be reachable from an agent-issued fetch. */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expand an IPv6 address to its 8 numeric groups. Text matching is not enough
 * here: `new URL()` re-serializes the host to the shortest form, so a literal
 * written `::ffff:127.0.0.1` arrives as `::ffff:7f00:1` and any dotted-quad
 * pattern misses it. Returns undefined for anything unparseable, which callers
 * treat as blocked.
 */
function expandIPv6(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!; // strip brackets + zone id
  // A trailing dotted-quad (::ffff:127.0.0.1) becomes the final two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1]!.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    s = s.slice(0, v4.index) + (((o[0]! << 8) | o[1]!) >>> 0).toString(16) + ':' + (((o[2]! << 8) | o[3]!) >>> 0).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  if (groups.length !== 8) return undefined;
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? undefined : nums;
}

function isBlockedIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const topFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::, ::1
  if (topFiveZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) — judge the
  // embedded v4 address, or 127.0.0.1 sneaks past wearing an IPv6 costume.
  if (topFiveZero && (g5 === 0xffff || g5 === 0)) {
    return isBlockedIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.'));
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return true; // unparseable — refuse rather than guess
}

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

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
