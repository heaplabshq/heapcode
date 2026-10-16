import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createSignIn } = require('../src/signIn.cjs') as typeof import('../src/signIn.cjs');

const LAUNCH = 'http://127.0.0.1:49289/?token=abc';

function setup(launch: string | null = LAUNCH) {
  let t = 0;
  const load = vi.fn();
  const signIn = createSignIn({ launchUrl: () => launch, load, now: () => t, minGapMs: 10_000 });
  return { signIn, load, advance: (ms: number) => (t += ms) };
}

describe('signing the desktop window back in', () => {
  it('loads the launch URL when the page asks', () => {
    const { signIn, load } = setup();
    expect(signIn.signIn()).toBe(true);
    expect(load).toHaveBeenCalledWith(LAUNCH);
  });

  it('does it again only after a pause, so a failing URL cannot loop', () => {
    const { signIn, load, advance } = setup();
    signIn.signIn();
    advance(5_000);
    expect(signIn.signIn()).toBe(false);
    advance(5_000);
    expect(signIn.signIn()).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('notices the window landing on its own server refusing it — ⌘R on a signed-out page', () => {
    for (const status of [401, 429]) {
      const { signIn, load } = setup();
      expect(signIn.onNavigate('http://127.0.0.1:49289/', status)).toBe(true);
      expect(load).toHaveBeenCalledWith(LAUNCH);
    }
  });

  it('ignores ordinary pages and other servers', () => {
    const { signIn, load } = setup();
    expect(signIn.onNavigate('http://127.0.0.1:49289/', 200)).toBe(false);
    expect(signIn.onNavigate('http://localhost:5179/', 401)).toBe(false);
    expect(signIn.onNavigate('http://127.0.0.1:1234/', 401)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('does nothing before the server has started', () => {
    const { signIn, load } = setup(null);
    expect(signIn.signIn()).toBe(false);
    expect(signIn.onNavigate('http://127.0.0.1:49289/', 401)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});
