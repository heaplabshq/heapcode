import { describe, expect, it } from 'vitest';
import { assertPublicUrl, BlockedUrlError } from '../src/net/safeFetch.js';

/**
 * The guard exists because fetch_url is reachable from content the agent
 * doesn't control (fetched pages, MCP output), so these cases are the actual
 * attack shapes, not hypotheticals — cloud metadata first among them.
 */
describe('assertPublicUrl', () => {
  const blocked = [
    ['cloud metadata (IMDS)', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['loopback by IP', 'http://127.0.0.1:8080/admin'],
    ['loopback, non-standard notation', 'http://127.1/'],
    ['private 10/8', 'http://10.0.0.5/'],
    ['private 172.16/12', 'http://172.20.10.1/'],
    ['private 192.168/16', 'https://192.168.1.1/'],
    ['CGNAT', 'http://100.64.0.1/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['IPv6 loopback', 'http://[::1]:3000/'],
    ['IPv6 unique-local', 'http://[fd00::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
  ] as const;

  for (const [label, url] of blocked) {
    it(`blocks ${label}`, async () => {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError);
    });
  }

  it('blocks non-http(s) schemes, including file:// and gopher://', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/Only http\(s\)/);
    await expect(assertPublicUrl('gopher://127.0.0.1:11211/')).rejects.toThrow(/Only http\(s\)/);
  });

  it('blocks a hostname that resolves to loopback (the DNS-based bypass)', async () => {
    // localhost is the everyday form of "public-looking name, private address".
    await expect(assertPublicUrl('http://localhost:9200/')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects malformed URLs rather than passing them through', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('allows a public address, preserving path and query', async () => {
    const url = await assertPublicUrl('https://93.184.216.34/docs?q=1');
    expect(url.pathname).toBe('/docs');
    expect(url.search).toBe('?q=1');
  });

  it('allows a public boundary address adjacent to a blocked range', async () => {
    // 169.253/16 and 172.32/16 sit just outside link-local and private space —
    // an off-by-one in the range checks would blackhole legitimate hosts.
    await expect(assertPublicUrl('http://169.253.0.1/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://172.32.0.1/')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://11.0.0.1/')).resolves.toBeInstanceOf(URL);
  });
});
