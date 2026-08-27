// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { findScroller, scrollBy } from '../src/content/scroll.js';

/**
 * Scrolling an app-shell layout.
 *
 * `window.scrollBy` assumes the document scrolls, and on a great many modern
 * apps it does not -- the shell is pinned to the viewport and the content lives
 * in an inner pane. LinkedIn's job search is exactly that, so every scroll was a
 * silently successful no-op and the agent read the same seven results over and
 * over before concluding the list had ended.
 *
 * jsdom has no layout, so element geometry is stubbed. What is being tested is
 * the choice of what to scroll and the arithmetic, which is where the bug was.
 */

function pane(html: string, geometry: { scrollHeight: number; clientHeight: number }) {
  document.body.innerHTML = html;
  const element = document.querySelector('#pane') as HTMLElement;
  Object.defineProperty(element, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: geometry.clientHeight, configurable: true });
  element.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect;
  return element;
}

/** A document that cannot scroll — the shape that broke this. */
function fixedDocument(viewportHeight = 600) {
  Object.defineProperty(window, 'innerHeight', { value: viewportHeight, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: viewportHeight,
    configurable: true,
  });
}

describe('choosing what to scroll', () => {
  it('scrolls the inner pane when the document cannot move', () => {
    fixedDocument();
    const element = pane(
      '<div id="pane" style="overflow-y: auto">content</div>',
      { scrollHeight: 4000, clientHeight: 600 },
    );

    const result = scrollBy(document, 'down');

    expect(result.element).toBe(element);
    expect(element.scrollTop).toBe(600);
  });

  it('scrolls the document when the document can move', () => {
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 5000,
      configurable: true,
    });
    document.body.innerHTML = '<p>content</p>';
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;

    const result = scrollBy(document, 'down');

    expect(result.element).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 600 }));
  });

  it('ignores a pane that has a scrollbar style but nothing to scroll', () => {
    fixedDocument();
    pane('<div id="pane" style="overflow-y: auto">short</div>', {
      scrollHeight: 600,
      clientHeight: 600,
    });
    expect(findScroller(document).element).toBeUndefined();
  });

  it('ignores a pane whose overflow is hidden', () => {
    fixedDocument();
    pane('<div id="pane" style="overflow-y: hidden">content</div>', {
      scrollHeight: 4000,
      clientHeight: 600,
    });
    expect(findScroller(document).element).toBeUndefined();
  });
});

describe('the arithmetic', () => {
  it('moves by whole viewports, and by several when asked', () => {
    fixedDocument();
    const element = pane('<div id="pane" style="overflow-y: auto">c</div>', {
      scrollHeight: 10_000,
      clientHeight: 600,
    });
    scrollBy(document, 'down', 3);
    expect(element.scrollTop).toBe(1800);
  });

  it('clamps at the bottom instead of running past it', () => {
    fixedDocument();
    const element = pane('<div id="pane" style="overflow-y: auto">c</div>', {
      scrollHeight: 1000,
      clientHeight: 600,
    });
    scrollBy(document, 'bottom');
    expect(element.scrollTop).toBe(400);
  });

  it('clamps at the top', () => {
    fixedDocument();
    const element = pane('<div id="pane" style="overflow-y: auto">c</div>', {
      scrollHeight: 4000,
      clientHeight: 600,
    });
    element.scrollTop = 100;
    scrollBy(document, 'up', 5);
    expect(element.scrollTop).toBe(0);
  });
});
