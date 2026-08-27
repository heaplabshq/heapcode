import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, RunBudget } from '../src/agent/limits.js';
import { BrowserToolExecutor } from '../src/agent/executor.js';

/**
 * What a real task ran into.
 *
 * Applying to five jobs on LinkedIn is naturally dozens of clicks and tens of
 * navigations, and the first version of this walked into three separate walls
 * in one run. Each is a different bug and each made the agent look broken in a
 * different way.
 */

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: 'c1', name, args });

afterEach(() => vi.unstubAllGlobals());

describe('the ceilings', () => {
  it('are sized for a real task, not a demo', () => {
    // The first numbers (30/8/20) were guesses, and one job-application run
    // walked straight through all three. A ceiling that stops legitimate work
    // is a bug that happens to fail closed.
    expect(DEFAULT_LIMITS.maxActions).toBeGreaterThanOrEqual(100);
    expect(DEFAULT_LIMITS.maxNavigations).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_LIMITS.maxPerHost).toBeGreaterThanOrEqual(100);
  });

  it('still bound an unattended run', () => {
    const budget = new RunBudget({ maxActions: 3, maxNavigations: 3, maxPerHost: 3 });
    const attempts = Array.from({ length: 5 }, () => budget.spend('click', 'evil.example'));
    expect(attempts.filter((a) => a.ok)).toHaveLength(3);
  });

  it('say what limit was hit, in terms the model can act on', () => {
    const budget = new RunBudget({ maxActions: 1, maxNavigations: 9, maxPerHost: 9 });
    budget.spend('click', 'a.example');
    const stopped = budget.spend('click', 'a.example');
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) expect(stopped.reason).toMatch(/limit/i);
  });
});

/**
 * The trap: an application redirected to an external Workday portal, and every
 * attempt to get back to LinkedIn was refused, because navigating away required
 * permission to read the page being left. The agent spent the rest of the run
 * explaining that it was stuck.
 */
function stubUngrantedPage() {
  const update = vi.fn().mockResolvedValue({});
  const goBack = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue([{ id: 1, url: 'https://arcticwolf.wd1.myworkdayjobs.com/apply' }]),
      get: vi.fn().mockResolvedValue({ id: 1, status: 'complete' }),
      update,
      goBack,
      sendMessage: vi
        .fn()
        .mockResolvedValue({ ok: true, kind: 'settled', settled: true, waitedMs: 5 }),
    },
    // The current origin is NOT granted -- that is the whole scenario.
    permissions: { contains: vi.fn().mockResolvedValue(false) },
    scripting: { executeScript: vi.fn().mockRejectedValue(new Error('no access')) },
  });
  return { update, goBack };
}

describe('leaving a page the extension cannot read', () => {
  it('can navigate away without permission to read where it is', async () => {
    // Leaving is not reading. Requiring the page's own consent to leave it makes
    // any ungranted redirect a dead end.
    const { update } = stubUngrantedPage();
    const result = await new BrowserToolExecutor('x').execute(
      call('navigate', { url: 'https://www.linkedin.com/jobs' }),
    );
    expect(update).toHaveBeenCalledWith(1, { url: 'https://www.linkedin.com/jobs' });
    expect(result.content).toContain('linkedin.com');
  });

  it('can go back without the content script being present', async () => {
    // The case where going back matters most is exactly the one where our
    // script was never injected, so it cannot be the thing that performs it.
    const { goBack } = stubUngrantedPage();
    await new BrowserToolExecutor('x').execute(call('go_back'));
    expect(goBack).toHaveBeenCalledWith(1);
  });

  it('explains that the new page needs granting, rather than failing silently', async () => {
    stubUngrantedPage();
    const result = await new BrowserToolExecutor('x').execute(
      call('navigate', { url: 'https://www.linkedin.com/jobs' }),
    );
    expect(result.content).toMatch(/not been granted access/);
  });
});
