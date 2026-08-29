import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserToolExecutor } from '../src/agent/executor.js';
import { READ_PAGE } from '../src/agent/tools.js';
import type { PageSnapshot } from '../src/shared/snapshot.js';

/**
 * Noticing when the action did nothing.
 *
 * A content script's click is `isTrusted: false`. Plenty of pages ignore it,
 * and they ignore it *silently* -- the call returns normally and the agent has
 * no way to tell success from nothing at all. An agent that reports success for
 * a click that did nothing is indistinguishable from a broken one, and it is
 * the failure that erodes trust fastest (PRD section 7.3).
 */

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://shop.example.com/laptops',
    title: 'Laptops',
    viewport: { width: 1440, height: 900, scrollY: 0, scrollHeight: 2000 },
    text: 'Laptops for sale.',
    controls: [{ handle: 1, role: 'button', name: 'Add to cart', score: 90 }],
    tables: [],
    generation: 1,
    ...overrides,
  };
}

/** Chrome, scripted reply by reply so a whole action sequence can be played. */
function stubChrome(replies: unknown[]) {
  const sendMessage = vi.fn();
  for (const reply of replies) sendMessage.mockResolvedValueOnce(reply);
  sendMessage.mockResolvedValue({ ok: true, kind: 'settled', settled: true, waitedMs: 10 });
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://shop.example.com/laptops' }]),
      get: vi.fn().mockResolvedValue({ id: 1, status: 'complete' }),
      update: vi.fn().mockResolvedValue({}),
      sendMessage,
    },
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  });
  return sendMessage;
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: 'c1', name, args });

afterEach(() => vi.unstubAllGlobals());

describe('the verification gate', () => {
  it('marks reading as verification, so finish is blocked until it looks', () => {
    // Core blocks `finish` once if a mutating tool ran since the last
    // successful `verifies` call -- the same machinery that stops heapcode
    // finishing with untested edits.
    expect(READ_PAGE.verifies).toBe(true);
  });
});

describe('after a click', () => {
  it('says plainly that nothing changed, and says not to retry', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'acted', note: 'Dispatched a full click sequence.' },
      { ok: true, kind: 'settled', settled: true, waitedMs: 10 },
      { ok: true, kind: 'snapshot', snapshot: snapshot({ generation: 2 }) },
    ]);

    const executor = new BrowserToolExecutor('add to cart');
    await executor.execute(call('read_page'));
    const result = await executor.execute(call('click', { handle: 1 }));

    expect(result.content).toMatch(/nothing on the page changed/i);
    expect(result.content).toMatch(/no effect/i);
    // Blind retries are how an agent orders three of something.
    expect(result.content).toMatch(/[Dd]o not simply retry/);
  });

  it('reports what changed when something did, without a second round trip', async () => {
    // Before this, a click returned "handles are void, read again" and the
    // agent spent a whole turn discovering whether it had worked.
    const after = snapshot({
      generation: 2,
      controls: [
        { handle: 1, role: 'button', name: 'Add to cart', score: 90 },
        { handle: 2, role: 'link', name: 'View cart (1)', score: 80 },
      ],
    });
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'acted', note: 'Dispatched a full click sequence.' },
      { ok: true, kind: 'settled', settled: true, waitedMs: 10 },
      { ok: true, kind: 'snapshot', snapshot: after },
    ]);

    const executor = new BrowserToolExecutor('add to cart');
    await executor.execute(call('read_page'));
    const result = await executor.execute(call('click', { handle: 1 }));

    expect(result.content).toContain('View cart (1)');
    expect(result.content).not.toMatch(/nothing on the page changed/i);
  });

  it('reports a navigation as a navigation, with the new page', async () => {
    const elsewhere = snapshot({
      url: 'https://shop.example.com/cart',
      title: 'Your cart',
      generation: 2,
    });
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'acted', note: 'Dispatched a full click sequence.' },
      { ok: true, kind: 'settled', settled: true, waitedMs: 10 },
      { ok: true, kind: 'snapshot', snapshot: elsewhere },
    ]);

    const executor = new BrowserToolExecutor('open the cart');
    await executor.execute(call('read_page'));
    const result = await executor.execute(call('click', { handle: 1 }));

    expect(result.content).toMatch(/navigated to https:\/\/shop\.example\.com\/cart/);
    expect(result.content).toContain('URL: https://shop.example.com/cart');
  });

  it('treats the page becoming unreadable as the observation, not a crash', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'acted', note: 'Dispatched a full click sequence.' },
      { ok: true, kind: 'settled', settled: true, waitedMs: 10 },
      { ok: false, error: 'The page did not respond. It may have navigated while being read.' },
    ]);

    const executor = new BrowserToolExecutor('x');
    await executor.execute(call('read_page'));
    const result = await executor.execute(call('click', { handle: 1 }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/became unreadable/);
  });
});

describe('navigate', () => {
  it('waits for the new document before reporting anything about it', async () => {
    const arrived = snapshot({ url: 'https://shop.example.com/cart', generation: 2 });
    const send = stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'settled', settled: true, waitedMs: 10 },
      { ok: true, kind: 'snapshot', snapshot: arrived },
    ]);

    const executor = new BrowserToolExecutor('go to the cart');
    await executor.execute(call('read_page'));
    const result = await executor.execute(call('navigate', { url: '/cart' }));

    expect(chrome.tabs.get).toHaveBeenCalled();
    expect(result.content).toContain('https://shop.example.com/cart');
    expect(send).toHaveBeenCalled();
  });

  it('says so when the page never finished loading, rather than inventing a state', async () => {
    stubChrome([{ ok: true, kind: 'snapshot', snapshot: snapshot() }]);
    (chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, status: 'loading' });

    const executor = new BrowserToolExecutor('x', { loadTimeoutMs: 300 });
    await executor.execute(call('read_page'));
    const result = await executor.execute(call('navigate', { url: '/cart' }));

    expect(result.content).toMatch(/had not finished loading/);
  });
});
