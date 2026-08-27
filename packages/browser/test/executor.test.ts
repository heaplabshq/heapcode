import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserToolExecutor } from '../src/agent/executor.js';
import { READ_ONLY_TOOLS } from '../src/agent/tools.js';
import type { PageSnapshot } from '../src/shared/snapshot.js';

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://shop.example.com/laptops',
    title: 'Laptops',
    viewport: { width: 1440, height: 900, scrollY: 0, scrollHeight: 8400 },
    text: 'Laptops for sale.',
    controls: [
      { handle: 1, role: 'button', name: 'Add to cart', score: 90, context: 'ThinkPad X1' },
      { handle: 2, role: 'select', name: 'Sort by', score: 80, options: ['Price', 'Rating'] },
      { handle: 3, role: 'link', name: 'Next page', score: 40, href: '/laptops?page=2' },
    ],
    tables: [],
    generation: 1,
    ...overrides,
  };
}

/** Chrome, reduced to what the executor actually touches. */
function stubChrome(replies: unknown[]) {
  const sendMessage = vi.fn();
  for (const reply of replies) sendMessage.mockResolvedValueOnce(reply);
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://shop.example.com/laptops' }]),
      sendMessage,
    },
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  });
  return sendMessage;
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: 'c1', name, args });

afterEach(() => vi.unstubAllGlobals());

describe('the tool belt', () => {
  it('is entirely read-only, because M2 ships before the permission engine', () => {
    // PLAN guardrail 5: a tool with permission 'write' does not ship without the
    // confirmation UI, and that lands in M3.
    expect(READ_ONLY_TOOLS.every((t) => t.permission === 'read')).toBe(true);
  });

  it('marks every page-reading tool as untrusted output', () => {
    // Results are whatever an arbitrary site put on screen, arriving while the
    // agent sits beside the user's logged-in session.
    for (const tool of READ_ONLY_TOOLS.filter((t) => t.name !== 'wait')) {
      expect(tool.untrustedOutput, tool.name).toBe(true);
    }
  });
});

describe('read_page', () => {
  it('returns the whole page the first time', async () => {
    stubChrome([{ ok: true, kind: 'snapshot', snapshot: snapshot() }]);
    const result = await new BrowserToolExecutor('what can I do').execute(call('read_page'));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('URL: https://shop.example.com/laptops');
    expect(result.content).toContain('Add to cart');
  });

  it('returns only the changes on the second read', async () => {
    // The whole point: a ten-step run must not cost ten pages.
    const second = snapshot({
      controls: [...snapshot().controls, { handle: 4, role: 'button', name: 'Compare', score: 50 }],
      generation: 2,
    });
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'snapshot', snapshot: second },
    ]);

    const executor = new BrowserToolExecutor('what can I do');
    const first = await executor.execute(call('read_page'));
    const next = await executor.execute(call('read_page'));

    expect(next.content).toMatch(/New controls/);
    expect(next.content).toContain('Compare');
    expect(next.content.length).toBeLessThan(first.content.length);
  });

  it('re-reads in full when asked', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'snapshot', snapshot: snapshot({ generation: 2 }) },
    ]);
    const executor = new BrowserToolExecutor('x');
    await executor.execute(call('read_page'));
    const full = await executor.execute(call('read_page', { full: true }));
    expect(full.content).toContain('URL:');
  });

  it('reports a permission problem as a tool error the model can act on', async () => {
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://shop.example.com/x' }]) },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
      scripting: { executeScript: vi.fn() },
    });
    const result = await new BrowserToolExecutor('x').execute(call('read_page'));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not been granted access/);
  });
});

describe('get_elements', () => {
  it('filters by name and by role', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
    ]);
    const executor = new BrowserToolExecutor('x');

    const byName = await executor.execute(call('get_elements', { filter: 'cart' }));
    expect(byName.content).toContain('Add to cart');
    expect(byName.content).not.toContain('Next page');

    const byRole = await executor.execute(call('get_elements', { role: 'link' }));
    expect(byRole.content).toContain('Next page');
    expect(byRole.content).not.toContain('Sort by');
  });

  it('says what it searched for when nothing matched, so the model changes tack', async () => {
    stubChrome([{ ok: true, kind: 'snapshot', snapshot: snapshot() }]);
    const result = await new BrowserToolExecutor('x').execute(
      call('get_elements', { filter: 'checkout' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/checkout/);
    expect(result.content).toMatch(/3 controls in total/);
  });
});

describe('extract_data', () => {
  it('returns table rows with their headers', async () => {
    stubChrome([
      {
        ok: true,
        kind: 'snapshot',
        snapshot: snapshot({
          tables: [
            {
              label: 'table#results',
              rows: 24,
              columns: 3,
              headers: ['Model', 'RAM', 'Price'],
              sample: [['X1', '16GB', '1200']],
            },
          ],
        }),
      },
    ]);
    const result = await new BrowserToolExecutor('x').execute(call('extract_data'));
    expect(result.content).toContain('Model | RAM | Price');
    expect(result.content).toContain('X1 | 16GB | 1200');
    expect(result.content).toMatch(/1 of 24 rows/);
  });

  it('points at read_page when the page has no real table', async () => {
    stubChrome([{ ok: true, kind: 'snapshot', snapshot: snapshot() }]);
    const result = await new BrowserToolExecutor('x').execute(call('extract_data'));
    expect(result.content).toMatch(/no table with column headers/);
    expect(result.content).toMatch(/read_page/);
  });
});

describe('scroll', () => {
  it('reports reaching the end instead of letting the agent loop', async () => {
    // Scrolling to the same offset forever is how a read-only agent burns its
    // whole step budget on a page that has already ended.
    const still = snapshot({ generation: 2 });
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'snapshot', snapshot: still },
    ]);
    const executor = new BrowserToolExecutor('x');
    await executor.execute(call('read_page'));
    const result = await executor.execute(call('scroll', { direction: 'down' }));
    expect(result.content).toMatch(/did not move/);
    expect(result.content).toMatch(/nothing further in that direction/);
  });

  it('rejects a direction it does not understand', async () => {
    stubChrome([]);
    const result = await new BrowserToolExecutor('x').execute(
      call('scroll', { direction: 'sideways' }),
    );
    expect(result.isError).toBe(true);
  });
});

describe('wait', () => {
  it('distinguishes a page that settled from one still changing', async () => {
    stubChrome([{ ok: true, kind: 'settled', settled: true, waitedMs: 620 }]);
    const settled = await new BrowserToolExecutor('x').execute(call('wait'));
    expect(settled.content).toMatch(/settled after 620ms/);

    stubChrome([{ ok: true, kind: 'settled', settled: false, waitedMs: 3000 }]);
    const busy = await new BrowserToolExecutor('x').execute(call('wait', { seconds: 3 }));
    expect(busy.content).toMatch(/still changing/);
  });
});

describe('unknown tools', () => {
  it('are an error, not a silent success', async () => {
    stubChrome([]);
    const result = await new BrowserToolExecutor('x').execute(call('click'));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Unknown tool/);
  });
});
