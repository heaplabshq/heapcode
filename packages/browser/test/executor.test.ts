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
    // agent sits beside the user's logged-in session. Named explicitly rather
    // than by exclusion, so a new page-reading tool added without the flag
    // fails here instead of quietly slipping past a filter.
    const readsThePage = ['read_page', 'get_elements', 'extract_data', 'scroll'];
    for (const name of readsThePage) {
      const tool = READ_ONLY_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.untrustedOutput, name).toBe(true);
    }
  });

  it('does not mark tools that return nothing from the page', () => {
    // `wait` reports timing and `ask_user` returns the user's own words —
    // wrapping those as untrusted page data would be a lie about their origin.
    for (const name of ['wait', 'ask_user']) {
      expect(READ_ONLY_TOOLS.find((t) => t.name === name)?.untrustedOutput, name).toBeFalsy();
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

  // It reads repeated blocks as well as real tables now, so the empty answer
  // has to mean "neither", or a model told "no table" will go looking for the
  // list it can see on screen and be told the same thing again.
  it('points at reading the page when there is neither a table nor a list', async () => {
    stubChrome([{ ok: true, kind: 'snapshot', snapshot: snapshot() }]);
    const result = await new BrowserToolExecutor('x').execute(call('extract_data'));
    expect(result.content).toMatch(/neither a table nor|no table|repeated list/i);
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
    const result = await new BrowserToolExecutor('x').execute(call('upload_file'));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Unknown tool/);
  });
});

describe('acting without having read', () => {
  it('is refused, because a handle number would be a guess', async () => {
    stubChrome([]);
    const result = await new BrowserToolExecutor('x').execute(call('click', { handle: 4 }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Read the page first/);
  });
});

/**
 * The camera is the most expensive tool on the belt.
 *
 * The image goes into the conversation and is carried for every turn after it,
 * and the model reaches for one out of habit -- right after a read that already
 * answered the question. Being told so in the prompt is not enough; models take
 * the picture anyway. So the first such request is turned down and the model is
 * reminded of what it is holding.
 *
 * Turned down once, not twice. A chart, a canvas or a layout question is a real
 * reason to look, and a tool that can be refused indefinitely is one the model
 * stops trusting and stops reaching for when it genuinely needs it.
 */
describe('taking a picture', () => {
  it('is refused right after a read, because the text is the same page', async () => {
    stubChrome([{ ok: true, kind: 'snapshot', snapshot: snapshot() }]);
    const executor = new BrowserToolExecutor('what does it cost');

    await executor.execute(call('read_page'));
    const shot = await executor.execute(call('screenshot'));

    expect(shot.isError).toBe(true);
    expect(shot.content).toContain('Answer from what you read');
    expect(shot.images).toBeUndefined();
  });

  it('goes through when the model asks again, having been told why', async () => {
    stubChrome([{ ok: true, kind: 'snapshot', snapshot: snapshot() }]);
    const executor = new BrowserToolExecutor('what does the chart show');

    await executor.execute(call('read_page'));
    await executor.execute(call('screenshot'));
    const second = await executor.execute(call('screenshot'));

    // It gets as far as the driver, which without the debugger cannot take one.
    // What matters is that it was not turned away on the same grounds twice.
    expect(second.content).not.toContain('Answer from what you read');
  });

  it('is not refused before anything has been read', async () => {
    stubChrome([]);
    const executor = new BrowserToolExecutor('what is on screen');
    const shot = await executor.execute(call('screenshot'));

    expect(shot.content).not.toContain('Answer from what you read');
  });

  /**
   * After an action the page is not the page that was read, so the reason for
   * refusing does not hold. This is the case a naive "have we read once?" flag
   * gets wrong.
   */
  it('is allowed again once the page has changed under it', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: snapshot() },
      { ok: true, kind: 'acted', note: 'Clicked "Add to cart".' },
      { ok: true, kind: 'snapshot', snapshot: snapshot({ text: 'In your basket.' }) },
    ]);
    const executor = new BrowserToolExecutor('add it');

    await executor.execute(call('read_page'));
    await executor.execute(call('click', { handle: 1, generation: 1 }));
    const shot = await executor.execute(call('screenshot'));

    expect(shot.content).not.toContain('Answer from what you read');
  });
});

/**
 * Reading a page you have already read.
 *
 * `get_page_text` returns up to sixty thousand characters and had no memory of
 * having done so, so a run that read a page, looked at it another way, and came
 * back paid for the same sixty thousand characters twice. On a real run against
 * Amazon that was more than every other step put together, and it is the single
 * largest thing that enters the context on this product.
 *
 * Told once and then given it. The context can be compacted out from under a
 * long run, and a model that has genuinely lost the page has to be able to get
 * it back -- refused twice with "you already have this" when it demonstrably
 * does not is how a run stalls with nothing to work from.
 */
describe('reading the same page twice', () => {
  const wordy = snapshot({ text: 'Seat height 17 inches. Weight 4.2kg. Ships from Bengaluru.' });

  it('hands the text over the first time', async () => {
    stubChrome([{ ok: true, kind: 'snapshot', snapshot: wordy }]);
    const result = await new BrowserToolExecutor('how tall').execute(call('get_page_text'));
    expect(result.content).toContain('Seat height 17 inches');
  });

  it('does not send it again when nothing has changed', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: wordy },
      { ok: true, kind: 'snapshot', snapshot: wordy },
    ]);
    const executor = new BrowserToolExecutor('how tall');

    await executor.execute(call('get_page_text'));
    const again = await executor.execute(call('get_page_text'));

    expect(again.content).not.toContain('Seat height 17 inches');
    expect(again.content).toContain('has not changed');
    expect(again.isError).toBeFalsy();
  });

  it('gives it back when the model insists, in case the context was compacted', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: wordy },
      { ok: true, kind: 'snapshot', snapshot: wordy },
      { ok: true, kind: 'snapshot', snapshot: wordy },
    ]);
    const executor = new BrowserToolExecutor('how tall');

    await executor.execute(call('get_page_text'));
    await executor.execute(call('get_page_text'));
    const third = await executor.execute(call('get_page_text'));

    expect(third.content).toContain('Seat height 17 inches');
  });

  /** A search over text the model already has is new information, and it is small. */
  it('always runs a filtered read, however often the page was read', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: wordy },
      { ok: true, kind: 'snapshot', snapshot: wordy },
    ]);
    const executor = new BrowserToolExecutor('how heavy');

    await executor.execute(call('get_page_text'));
    const found = await executor.execute(call('get_page_text', { find: 'Weight' }));

    expect(found.content).toContain('Weight 4.2kg');
  });

  /**
   * A filtered read must not make the model look as though it has seen the
   * whole page -- it has seen three lines of it.
   */
  it('does not count a filtered read as having read the page', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: wordy },
      { ok: true, kind: 'snapshot', snapshot: wordy },
    ]);
    const executor = new BrowserToolExecutor('how heavy');

    await executor.execute(call('get_page_text', { find: 'Weight' }));
    const full = await executor.execute(call('get_page_text'));

    expect(full.content).toContain('Seat height 17 inches');
  });

  it('sends the new text when the page has actually changed', async () => {
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: wordy },
      { ok: true, kind: 'snapshot', snapshot: snapshot({ text: 'Out of stock in Bengaluru.' }) },
    ]);
    const executor = new BrowserToolExecutor('is it in stock');

    await executor.execute(call('get_page_text'));
    const after = await executor.execute(call('get_page_text'));

    expect(after.content).toContain('Out of stock');
  });
});
