/**
 * Finding the thing that actually scrolls.
 *
 * `window.scrollBy` assumes the document scrolls. On a great many modern apps
 * it does not: the shell is fixed to the viewport and the content lives in an
 * inner pane with its own scrollbar. LinkedIn's job search is exactly this --
 * the document height equals the viewport height, so every scroll was a
 * silently successful no-op, and the agent read the same seven results over and
 * over before giving up.
 *
 * The tell was in the snapshot all along: "scrolled 0/979" on a 979px viewport
 * means the document cannot move at all.
 */

function canScroll(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (!style) return false;
  const overflow = `${style.overflowY} ${style.overflow}`;
  if (!/(auto|scroll|overlay)/.test(overflow)) return false;
  // A pane that fits its content has a scrollbar style but nothing to scroll.
  return element.scrollHeight - element.clientHeight > 40;
}

/** How much of the viewport this element covers -- a proxy for "the main pane". */
function area(element: Element): number {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  const width = Math.min(rect.right, view?.innerWidth ?? rect.right) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, view?.innerHeight ?? rect.bottom) - Math.max(rect.top, 0);
  return Math.max(0, width) * Math.max(0, height);
}

export interface Scroller {
  /** undefined means the document itself. */
  element?: Element;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * The element a scroll should act on.
 *
 * The document wins when it can actually move -- it is what the user's own
 * scroll wheel would drive. Otherwise the largest scrollable pane on screen,
 * which is the one a person would have aimed at.
 */
export function findScroller(doc: Document, scope?: Element): Scroller {
  const view = doc.defaultView;
  const root = doc.scrollingElement ?? doc.documentElement;
  const viewportHeight = view?.innerHeight ?? 0;

  // Inside an open dialog the document is usually locked and the pane that moves
  // is in the dialog, so the search starts there rather than finding the
  // (larger, inert) list behind it.
  if (scope) {
    const inside = largestScrollable(scope);
    if (inside) {
      return {
        element: inside,
        scrollTop: inside.scrollTop,
        scrollHeight: inside.scrollHeight,
        clientHeight: inside.clientHeight,
      };
    }
    if (canScroll(scope)) {
      return {
        element: scope,
        scrollTop: scope.scrollTop,
        scrollHeight: scope.scrollHeight,
        clientHeight: scope.clientHeight,
      };
    }
  }

  if (root && root.scrollHeight - viewportHeight > 40) {
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: viewportHeight,
    };
  }

  const best = largestScrollable(doc);

  if (best) {
    return {
      element: best,
      scrollTop: best.scrollTop,
      scrollHeight: best.scrollHeight,
      clientHeight: best.clientHeight,
    };
  }

  return {
    scrollTop: root?.scrollTop ?? 0,
    scrollHeight: root?.scrollHeight ?? 0,
    clientHeight: viewportHeight,
  };
}

/** The biggest thing under `root` that can actually scroll. */
function largestScrollable(root: Document | Element): Element | undefined {
  let best: Element | undefined;
  let bestArea = 0;
  for (const element of root.querySelectorAll('*')) {
    if (!canScroll(element)) continue;
    const size = area(element);
    if (size > bestArea) {
      best = element;
      bestArea = size;
    }
  }
  return best;
}

export type ScrollDirection = 'down' | 'up' | 'top' | 'bottom';

/** Scroll whichever element actually moves, and report where it ended up. */
export function scrollBy(
  doc: Document,
  direction: ScrollDirection,
  pages = 1,
  scope?: Element,
): Scroller {
  const scroller = findScroller(doc, scope);
  const step = scroller.clientHeight * pages;

  const target = (() => {
    switch (direction) {
      case 'down':
        return scroller.scrollTop + step;
      case 'up':
        return scroller.scrollTop - step;
      case 'top':
        return 0;
      case 'bottom':
        return scroller.scrollHeight;
    }
  })();

  const clamped = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));

  if (scroller.element) scroller.element.scrollTop = clamped;
  else doc.defaultView?.scrollTo({ top: clamped, behavior: 'instant' as ScrollBehavior });

  return { ...scroller, scrollTop: clamped };
}
