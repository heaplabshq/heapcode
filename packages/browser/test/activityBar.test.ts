// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideActivity, noteActivity, showActivity } from '../src/agent/activity.js';

/**
 * The bar heapbrowse draws along the bottom of a page it is driving.
 *
 * These functions are serialized by `chrome.scripting.executeScript` and run in
 * the page, which makes them awkward to reach and easy to break quietly: they
 * may close over nothing, and the only thing that notices when one starts
 * closing over a module constant is Chrome, at runtime, on a user's page.
 *
 * So the stub here does what Chrome does -- calls the function with the args it
 * was given -- against a jsdom document. A `func` that reached for anything
 * outside itself throws here, which is the whole point.
 */

function stubChrome() {
  const sent: unknown[] = [];
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'abc',
      sendMessage: vi.fn((message: unknown) => {
        sent.push(message);
      }),
    },
    tabs: {
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      query: vi.fn(async () => [{ id: 1, url: 'https://example.com/' }]),
    },
    permissions: { contains: vi.fn(async () => true) },
    scripting: {
      executeScript: vi.fn(
        async ({ func, args }: { func: (...a: never[]) => void; args?: unknown[] }) => {
          func(...((args ?? []) as never[]));
          return [];
        },
      ),
    },
  });
  return { sent };
}

/** The bar's host element, as the page sees it. */
function host(): HTMLElement | null {
  return document.getElementById('__heapbrowse_activity');
}

/**
 * The bar's contents.
 *
 * The root is closed on purpose -- the page's own scripts must not be able to
 * reach into it -- so `element.shadowRoot` is null here exactly as it is in
 * Chrome. Production code updates through the `__hbSet` handle for that reason;
 * the test gets in by watching roots being created, which is the only seam that
 * does not require weakening the thing under test.
 */
const roots: ShadowRoot[] = [];
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function patched(this: Element, init: ShadowRootInit) {
  const root = attach.call(this, init);
  roots.push(root);
  return root;
};

function shadow(): ShadowRoot {
  const root = roots[roots.length - 1];
  if (!root) throw new Error('nothing was painted');
  return root;
}

afterEach(() => {
  roots.length = 0;
  document.documentElement.querySelector('#__heapbrowse_activity')?.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the bar on the page', () => {
  it('goes up with what the run is doing', async () => {
    stubChrome();
    await showActivity(1, 'Reading the page', 'example.com');

    expect(shadow().querySelector('.label')?.textContent).toBe('Reading the page');
    expect(shadow().querySelector('.detail')?.textContent).toBe('example.com');
  });

  /**
   * The glow answers a different question from the bar: "is something driving
   * this page", from the corner of the eye, without being read. It is the part
   * that has to survive a page the agent has scrolled away from the bar on.
   */
  it('lights the edges of the page as well as naming the step', async () => {
    stubChrome();
    await showActivity(1, 'Reading the page');
    expect(shadow().querySelector('.glow')).toBeTruthy();
  });

  it('takes the glow down with the bar', async () => {
    vi.useFakeTimers();
    stubChrome();
    await showActivity(1);
    await hideActivity(1);
    vi.advanceTimersByTime(300);

    expect(document.querySelector('#__heapbrowse_activity')).toBeNull();
  });

  it('lands on documentElement, so a page mid-navigation still gets one', async () => {
    stubChrome();
    await showActivity(1);
    // Exactly when the mark is most worth showing there may be no body yet.
    expect(host()?.parentElement).toBe(document.documentElement);
  });

  it('is injected once, however many times a tab is acquired', async () => {
    stubChrome();
    await showActivity(1, 'First');
    await showActivity(1, 'Second');

    expect(document.querySelectorAll('#__heapbrowse_activity')).toHaveLength(1);
    expect(shadow().querySelector('.label')?.textContent).toBe('First');
  });

  it('is retitled in place rather than rebuilt', async () => {
    stubChrome();
    await showActivity(1, 'Reading the page');
    const before = host();

    await noteActivity(1, 'Clicking', 'Add to cart');

    expect(host()).toBe(before);
    expect(shadow().querySelector('.label')?.textContent).toBe('Clicking');
    expect(shadow().querySelector('.detail')?.textContent).toBe('Add to cart');
  });

  it('does nothing on a tab that was never marked', async () => {
    stubChrome();
    await noteActivity(1, 'Clicking');
    expect(host()).toBeNull();
  });

  /**
   * A run that ended has to leave no trace. An indicator still up after the
   * agent stopped says something is happening when nothing is, which is the one
   * failure mode this whole mechanism exists to avoid.
   */
  it('comes down when the run ends', async () => {
    vi.useFakeTimers();
    stubChrome();
    await showActivity(1);
    await hideActivity(1);

    vi.advanceTimersByTime(300);
    expect(host()).toBeNull();
  });

  it('survives being taken down twice', async () => {
    vi.useFakeTimers();
    stubChrome();
    await showActivity(1);
    await hideActivity(1);
    vi.advanceTimersByTime(300);

    await expect(hideActivity(1)).resolves.toBeUndefined();
  });

  /**
   * Stop, pressed on the page rather than in the panel.
   *
   * The run lives in the side panel and the page cannot reach it, so the button
   * goes through the worker. What matters here is that it sends exactly the one
   * message the worker accepts, and that the bar admits it has been pressed --
   * a stop that looks like nothing happened gets pressed again.
   */
  it('sends stop through the worker when the page button is pressed', async () => {
    const { sent } = stubChrome();
    await showActivity(1, 'Clicking');

    shadow().querySelector<HTMLButtonElement>('.stop')!.click();

    expect(sent).toEqual([{ __heapbrowse: 'stop' }]);
    expect(shadow().querySelector('.label')?.textContent).toBe('Stopping…');
  });

  it('cannot be asked to stop twice from the same bar', async () => {
    const { sent } = stubChrome();
    await showActivity(1);
    const stop = shadow().querySelector<HTMLButtonElement>('.stop')!;

    stop.click();
    stop.click();

    expect(stop.disabled).toBe(true);
    expect(sent).toHaveLength(1);
  });

  /**
   * Silent on failure throughout. A tab with no grant, a page Chrome will not
   * let anyone script, a tab that closed mid-run: none is worth interrupting a
   * run over, and the mark is reassurance, so a missing one costs nothing.
   */
  it('says nothing when the tab cannot be scripted', async () => {
    vi.stubGlobal('chrome', {
      scripting: { executeScript: vi.fn(async () => Promise.reject(new Error('no access'))) },
    });

    await expect(showActivity(9)).resolves.toBeUndefined();
    await expect(noteActivity(9, 'Clicking')).resolves.toBeUndefined();
    await expect(hideActivity(9)).resolves.toBeUndefined();
  });
});

/**
 * The mark lives in the page's own DOM, so a navigation destroys it along with
 * the document -- and an agent that searches a site navigates constantly. The
 * first version of `mark` skipped the injection when the tab was already in its
 * set, which meant the glow went out the moment the agent submitted a search
 * and did not come back until the run happened to touch a different tab.
 */
describe('a page that navigates under the mark', () => {
  it('is painted again, rather than skipped for having been marked once', async () => {
    stubChrome();
    const { DriverPool } = await import('../src/agent/driverPool.js');
    const pool = new DriverPool(false);

    pool.mark(1);
    expect(host()).toBeTruthy();

    // What a navigation does: the document, and everything in it, goes.
    host()!.remove();
    roots.length = 0;

    pool.mark(1);
    expect(host()).toBeTruthy();
  });

  it('carries the step it was on across the navigation', async () => {
    stubChrome();
    const { DriverPool } = await import('../src/agent/driverPool.js');
    const pool = new DriverPool(false);

    pool.mark(1);
    pool.note('Filling in the form', '3 fields');
    host()!.remove();
    roots.length = 0;

    pool.mark(1);
    expect(shadow().querySelector('.label')?.textContent).toBe('Filling in the form');
  });
});
