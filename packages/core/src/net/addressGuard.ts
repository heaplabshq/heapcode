/**
 * The pure half of the SSRF guard: which addresses are off-limits.
 *
 * Split from `safeFetch.ts` — which keeps the DNS resolution and the fetch
 * loop — because a browser cannot resolve DNS before fetching and so cannot
 * use that half at all, but it can and must apply this one. A non-Node host
 * (heapbrowse) imports this through the browser-safe agent barrel to guard
 * its own `fetch_url`; `test/browserSafety.test.ts` holds the barrel, and so
 * this module, to "no imports of anything Node-coupled".
 *
 * `isIP` here replaces `node:net`'s — the only Node API the code used — with
 * a deliberately dumb detector: a dotted quad is v4, a colon is v6, anything
 * else is not an IP literal. `assertPublicUrl` in safeFetch feeds it
 * `url.hostname`, which `new URL()` has already normalized, so this is not
 * asked to survive hostile input — it is asked to classify honest ones.
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

/** 4 for a dotted quad, 6 for anything containing a colon, 0 for not an IP. */
function isIP(host: string): 0 | 4 | 6 {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 4;
  if (host.includes(':')) return 6;
  return 0;
}

export function isBlockedAddress(ip: string): boolean {
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