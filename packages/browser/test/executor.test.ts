import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_SEARCH_DISABLED_NOTICE } from '@heapcode/core/agent';
import { BrowserToolExecutor } from '../src/agent/executor.js';
import { READ_ONLY_TOOLS } from '../src/agent/tools.js';
import { ALL_ACTION_TOOLS } from '../src/agent/actions.js';
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

  it('marks every acting tool too, because they all return the page afterwards', () => {
    // The hardcoded read-only list above was the whole of this assertion for a
    // long time, and the acting tools -- all of which come back through
    // `#observe` with a snapshot or a delta in hand -- carried no flag at all.
    // Asserted over the belt rather than over a list, so a fifteenth action
    // tool cannot be added without one.
    for (const tool of ALL_ACTION_TOOLS) {
      expect(tool.untrustedOutput, tool.name).toBe(true);
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

describe('the click variants', () => {
  it('escalate exactly as far as a plain click on the same control would', async () => {
    // The classification is decided from what the element is, not which tool
    // name reached it — `right_click` on "Place order" is the same commit as
    // `click` on it, and must never be the easy way past a destructive verdict.
    const orderPage = snapshot({
      controls: [
        { handle: 1, role: 'button', name: 'Place order', score: 90, context: '' },
        { handle: 2, role: 'button', name: 'Change quantity', score: 80, context: '' },
      ],
    });
    stubChrome([
      { ok: true, kind: 'snapshot', snapshot: orderPage },
      { ok: true, kind: 'snapshot', snapshot: orderPage },
    ]);
    const executor = new BrowserToolExecutor('x');
    await executor.execute(call('read_page'));

    for (const name of ['click', 'double_click', 'triple_click', 'right_click']) {
      const verdict = await executor.classify(call(name, { handle: 1 }));
      expect(verdict.classification.permission, name).toBe('destructive');
    }

    // And the same names on an ordinary control stay ordinary.
    const benign = await executor.classify(call('right_click', { handle: 2 }));
    expect(benign.classification.permission).toBe('write');
  });
});

describe('resize_window', () => {
  it('resizes the window the working tab is in, and clamps to a floor', async () => {
    // A model asked for a "small" window could otherwise shrink the very UI
    // the user is watching it in — including the next confirmation.
    const windowsUpdate = vi.fn().mockResolvedValue({});
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://shop.example.com/laptops' }]),
        get: vi.fn().mockResolvedValue({ id: 1, windowId: 5 }),
        sendMessage: vi.fn().mockResolvedValue({ ok: true, kind: 'settled', settled: true, waitedMs: 5 }),
      },
      permissions: { contains: vi.fn().mockResolvedValue(true) },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
      windows: { update: windowsUpdate },
    });

    const result = await new BrowserToolExecutor('x').execute(
      call('resize_window', { width: 50, height: 20 }),
    );

    expect(windowsUpdate).toHaveBeenCalledWith(5, { width: 400, height: 300 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/400×300/);
  });

  it('is an error the model can act on when the dimensions are missing', async () => {
    stubChrome([]);
    const result = await new BrowserToolExecutor('x').execute(call('resize_window', {}));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/width and a height/);
  });

  it('never puts NaN on the card the user is asked to approve', async () => {
    // `classify` runs before the dimensions are validated, so it is handed raw
    // arguments. `Math.round(Number(undefined))` is NaN, which read as
    // "resize the window to NaN×NaN" on the confirmation itself.
    stubChrome([]);
    const executor = new BrowserToolExecutor('x');

    const missing = await executor.classify(call('resize_window', {}));
    expect(missing.describe).not.toMatch(/NaN/);

    const given = await executor.classify(call('resize_window', { width: 1280, height: 800 }));
    expect(given.describe).toMatch(/1280×800/);
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

/**
 * fetch_url, whose guard is the whole point.
 *
 * The address being fetched is model-chosen text, and the model sits beside
 * the user's logged-in session — so the SSRF floor (http(s) only, literal-IP
 * refused, the address it lands on re-checked) is not hardening, it is the
 * reason the tool may exist at all. Each refusal below is the attack it closes.
 *
 * These stubs model a *browser's* fetch, which is the whole point: a browser
 * following redirects itself and reporting where it landed in `res.url`. An
 * earlier version of this suite stubbed a Node-style 302-with-Location, which
 * `redirect: 'manual'` never produces in a page — so the tests passed while
 * every redirecting URL failed as `HTTP 0` in the real extension.
 */
describe('fetch_url', () => {
  /** Chrome is untouched by a fetch; the stub is here for afterEach symmetry. */
  const page = (
    body: string,
    init: { status?: number; headers?: Record<string, string>; url?: string } = {},
  ) => {
    const res = new Response(body, { status: init.status ?? 200, headers: init.headers });
    // `Response.url` is read-only and empty on a constructed response; a real
    // one carries the address after every redirect the browser followed.
    if (init.url) Object.defineProperty(res, 'url', { value: init.url });
    return res;
  };

  function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    // `init` is recorded as well as passed on: `redirect` is part of the
    // contract with the browser, so the tests assert on it.
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('refuses a link-local literal IP before any request is made', async () => {
    const fetchMock = stubFetch(async () => page('metadata'));
    const result = await new BrowserToolExecutor('x').execute(
      call('fetch_url', { url: 'http://169.254.169.254/latest/meta-data' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Refusing to fetch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a loopback literal and anything that is not http(s)', async () => {
    stubFetch(async () => page('nope'));
    const executor = new BrowserToolExecutor('x');

    const loopback = await executor.execute(call('fetch_url', { url: 'http://127.0.0.1:8888/search' }));
    expect(loopback.isError).toBe(true);
    expect(loopback.content).toMatch(/Refusing to fetch/);

    const ftp = await executor.execute(call('fetch_url', { url: 'file:///etc/passwd' }));
    expect(ftp.isError).toBe(true);
    expect(ftp.content).toMatch(/Only http\(s\) URLs/);
  });

  it('refuses the body when a public URL redirected onto a private address', async () => {
    // The browser followed the chain and landed on the metadata range. We
    // cannot un-issue that request, but the model must not be handed what
    // came back.
    stubFetch(async () =>
      page('ami-id\naws-secret', { url: 'http://169.254.169.254/latest/meta-data' }),
    );
    const result = await new BrowserToolExecutor('x').execute(
      call('fetch_url', { url: 'https://public.example.com/redirect' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Refusing to fetch/);
    expect(result.content).not.toMatch(/aws-secret/);
  });

  it('follows a safe redirect and returns the final page as text', async () => {
    // One call, as a browser makes it: `redirect: 'follow'`, landing reported.
    const fetchMock = stubFetch(async () =>
      page('Landed: <b>Rust 2.0</b> released', {
        headers: { 'content-type': 'text/html' },
        url: 'https://example.com/landed',
      }),
    );
    const result = await new BrowserToolExecutor('x').execute(
      call('fetch_url', { url: 'https://example.com/start' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Landed: Rust 2.0 released');
    expect(result.content).not.toContain('<b>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'follow' });
  });

  it('never asks for redirect: manual, which a browser answers with an unreadable HTTP 0', async () => {
    // The regression this file exists to hold: `manual` yields an opaque
    // redirect (status 0, no headers), so a plain http -> https hop — which is
    // most of the web — came back as `HTTP 0` instead of the page.
    const fetchMock = stubFetch(async () => page('ok', { url: 'https://example.com/' }));
    await new BrowserToolExecutor('x').execute(call('fetch_url', { url: 'http://example.com/' }));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).not.toBe('manual');
  });

  it('reports the status of a page that answers with an error', async () => {
    stubFetch(async () => page('missing', { status: 404 }));
    const result = await new BrowserToolExecutor('x').execute(
      call('fetch_url', { url: 'https://example.com/gone' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/HTTP 404/);
  });

  it('names both real causes when the fetch fails, and steers to the tab', async () => {
    // A CORS refusal and a dead host are the same TypeError to a browser; the
    // model gets both possibilities plus the fallback no site can refuse.
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await new BrowserToolExecutor('x').execute(
      call('fetch_url', { url: 'https://refuses-cors.example.com/' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/refuses to be read this way/);
    expect(result.content).toMatch(/get_page_text/);
  });
});

describe('web_search', () => {
  it('answers with the disabled notice when no settings resolver was provided', async () => {
    stubChrome([]);
    const result = await new BrowserToolExecutor('x').execute(
      call('web_search', { query: 'rust release notes' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe(WEB_SEARCH_DISABLED_NOTICE);
  });

  it('answers with the disabled notice when the settings exist but say disabled', async () => {
    stubChrome([]);
    const executor = new BrowserToolExecutor('x', {
      webSearch: async () => ({ config: { provider: 'brave', enabled: false }, apiKey: 'k' }),
    });
    const result = await executor.execute(call('web_search', { query: 'rust' }));

    expect(result.isError).toBe(true);
    expect(result.content).toBe(WEB_SEARCH_DISABLED_NOTICE);
  });

  it('searches the configured backend and formats the results', async () => {
    // `custom` with a shape-matching body: core's normalizer keys on the JSON's
    // own shape, so this is a real end-to-end webSearch() call, not a stub.
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      new Response(
        JSON.stringify({
          organic: [
            { title: 'Rust 2.0 released', link: 'https://blog.rust-lang.org/2.0', snippet: 'Announcing Rust 2.0' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const executor = new BrowserToolExecutor('x', {
      webSearch: async () => ({ config: { provider: 'custom', baseUrl: 'https://search.example.com/api' } }),
    });

    const result = await executor.execute(call('web_search', { query: 'rust 2.0' }));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Rust 2.0 released');
    expect(result.content).toContain('https://blog.rust-lang.org/2.0');
    // The model's query reached the backend as a parameter, not lost along the way.
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.origin).toBe('https://search.example.com');
  });

  it('surfaces a backend failure as a tool error the model can act on', async () => {
    vi.stubGlobal(
      'fetch',
      // Retry-After: 0 keeps core's retry backoff from sleeping in the test —
      // the behavior under test is the failure surfacing, not the pacing.
      vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })),
    );
    const executor = new BrowserToolExecutor('x', {
      webSearch: async () => ({ config: { provider: 'custom', baseUrl: 'https://search.example.com/api' } }),
    });
    const result = await executor.execute(call('web_search', { query: 'rust' }));

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/HTTP 429/);
  });
});
