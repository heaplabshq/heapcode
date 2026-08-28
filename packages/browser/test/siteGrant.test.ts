// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriverPool } from '../src/agent/driverPool.js';
import { grantPattern } from '../src/sidepanel/page.js';

/**
 * A site the run has not been allowed to read.
 *
 * Two things went wrong with the first version of this, and they are the two
 * things these tests hold down.
 *
 * The button did nothing, because the pattern was rebuilt from the host and had
 * to guess a scheme. The guess was a scheme wildcard, which is covered by
 * neither of the manifest's optional host permissions, so Chrome refused it
 * silently. The scheme is known where the failure is detected and nowhere else,
 * so it travels with the host.
 *
 * And the run did not wait. It was told and carried on, so the agent spent its
 * remaining steps explaining it was stuck while the question sat unread on
 * screen -- and by the time anyone answered, the run had written a conclusion
 * around a page it never read.
 */

/** Chrome, with a permission the extension does not hold until it is granted. */
function stubChrome({ granted = false } = {}) {
  const held = new Set<string>();
  if (granted) held.add('https://www.amazon.in/*');
  const request = vi.fn(async ({ origins }: { origins: string[] }) => {
    for (const origin of origins) held.add(origin);
    return true;
  });

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: 'https://www.amazon.in/s?k=mac+mini' }]),
      get: vi.fn(async () => ({ id: 7, url: 'https://www.amazon.in/s?k=mac+mini' })),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn(async ({ origins }: { origins: string[] }) =>
        origins.every((origin) => held.has(origin)),
      ),
      request,
    },
    scripting: { executeScript: vi.fn(async () => []) },
  });
  return { held, request };
}

afterEach(() => vi.unstubAllGlobals());

describe('asking for a site', () => {
  /**
   * The bug that made the button inert. `*://host/*` is not covered by either
   * `http` or `https` in `optional_host_permissions`, so Chrome refuses it.
   */
  it('asks for the scheme the page actually uses', async () => {
    const { request } = stubChrome();
    const pool = new DriverPool(false, undefined, async (needed) => {
      await grantPattern(needed.pattern);
      return true;
    });

    await pool.forActiveTab();

    expect(request).toHaveBeenCalledWith({ origins: ['https://www.amazon.in/*'] });
  });

  it('names the host in terms the user will recognise', async () => {
    stubChrome();
    const asked: string[] = [];
    const pool = new DriverPool(false, undefined, async (needed) => {
      asked.push(needed.host);
      return false;
    });

    await pool.forActiveTab();

    expect(asked).toEqual(['www.amazon.in']);
  });

  /**
   * The step that was blocked has to succeed once the permission exists. Any
   * other outcome means the user granted access and then had to ask again.
   */
  it('carries on with the step it was stopped on', async () => {
    stubChrome();
    const pool = new DriverPool(false, undefined, async (needed) => {
      await grantPattern(needed.pattern);
      return true;
    });

    const target = await pool.forActiveTab();

    expect(target.ok).toBe(true);
  });

  it('fails the step when the user says no', async () => {
    stubChrome();
    const pool = new DriverPool(false, undefined, async () => false);

    const target = await pool.forActiveTab();

    expect(target.ok).toBe(false);
  });

  /**
   * One "not now" is an answer. Re-raising it on every subsequent tool call
   * would be a dialog the user cannot get out of.
   */
  it('does not ask twice about a host that was refused', async () => {
    stubChrome();
    let asks = 0;
    const pool = new DriverPool(false, undefined, async () => {
      asks += 1;
      return false;
    });

    await pool.forActiveTab();
    await pool.forActiveTab();
    await pool.forActiveTab();

    expect(asks).toBe(1);
  });

  it('never asks about a site it already holds', async () => {
    stubChrome({ granted: true });
    let asks = 0;
    const pool = new DriverPool(false, undefined, async () => {
      asks += 1;
      return true;
    });

    const target = await pool.forActiveTab();

    expect(target.ok).toBe(true);
    expect(asks).toBe(0);
  });
});
