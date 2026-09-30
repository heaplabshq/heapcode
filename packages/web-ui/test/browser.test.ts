/**
 * The Browser view's address bar and the dev-server scanner that feeds it.
 * The view itself needs Electron's <webview>, so these are the parts that can
 * be wrong without one.
 */
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/components/Browser.js';
import { localUrlsIn } from '../src/localUrls.js';

describe('the address bar', () => {
  it('treats a bare local address as http, the way dev servers speak', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeUrl('127.0.0.1:8000/docs')).toBe('http://127.0.0.1:8000/docs');
    expect(normalizeUrl('0.0.0.0:3000')).toBe('http://localhost:3000');
  });

  it('treats a bare domain as https', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('github.com/heaplabshq/heapcode')).toBe('https://github.com/heaplabshq/heapcode');
  });

  it('keeps an explicit scheme', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('searches for anything that is not an address', () => {
    expect(normalizeUrl('react useEffect cleanup')).toBe('https://duckduckgo.com/?q=react%20useEffect%20cleanup');
  });

  it('ignores an empty bar', () => {
    expect(normalizeUrl('   ')).toBeUndefined();
  });
});

describe('finding dev servers in command output', () => {
  it('reads through the colour codes vite puts inside its URL', () => {
    expect(localUrlsIn('  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toEqual([
      'http://localhost:5173/',
    ]);
  });

  it('rewrites 0.0.0.0, which is a bind address and not somewhere to go', () => {
    expect(localUrlsIn('Serving on http://0.0.0.0:8000.')).toEqual(['http://localhost:8000']);
  });

  it('reports each address once, and ignores remote ones', () => {
    const out = 'url: http://127.0.0.1:3000\nagain http://127.0.0.1:3000\nsee https://example.com:443';
    expect(localUrlsIn(out)).toEqual(['http://127.0.0.1:3000']);
  });
});
