/**
 * Which elements are real enough to offer the model.
 *
 * Pages are full of controls that exist but cannot be used: collapsed menus,
 * offscreen carousels, `hidden` templates, zero-size click targets. Offering
 * them produces confident clicks that do nothing, which is the failure mode
 * hardest to distinguish from a broken agent (PRD §4.2).
 *
 * Disabled is deliberately *not* invisible — a disabled control is listed and
 * marked, because "the checkout button is greyed out" is frequently the answer.
 */

export function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;

  // `hidden`, `inert` and `aria-hidden` are declarations that this is not for
  // the user, independent of how it computes.
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style) {
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    if (Number(style.opacity) === 0) return false;
  }

  const rect = element.getBoundingClientRect();
  // jsdom reports every rect as zero, so a strict size test would empty every
  // fixture. Treat "no layout information at all" as unknown-but-present and
  // let the other signals decide; a real browser always has layout.
  const hasLayout = rect.width !== 0 || rect.height !== 0 || rect.top !== 0 || rect.left !== 0;
  if (hasLayout && (rect.width < 2 || rect.height < 2)) return false;

  return true;
}

export function isDisabled(element: Element): boolean {
  if ('disabled' in element && typeof (element as { disabled?: unknown }).disabled === 'boolean') {
    if ((element as { disabled: boolean }).disabled) return true;
  }
  if (element.getAttribute('aria-disabled') === 'true') return true;
  return element.closest('fieldset[disabled]') !== null;
}

/**
 * How much this element deserves to survive truncation.
 *
 * Two signals, both cheap: distance from the viewport, and whether it sits in
 * the page's main landmark rather than its navigation or footer. A control the
 * user can currently see is far more likely to be the one they mean.
 */
export function positionScore(element: Element): number {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  const height = view?.innerHeight ?? 0;

  let score = 0;
  if (height > 0) {
    const inViewport = rect.bottom > 0 && rect.top < height;
    if (inViewport) score += 100;
    else {
      // Fades with distance rather than dropping to zero: the next thing below
      // the fold is usually more relevant than the footer.
      const distance = rect.top < 0 ? -rect.top : rect.top - height;
      score += Math.max(0, 60 - Math.floor(distance / 200) * 10);
    }
  }

  if (element.closest('main, [role="main"], article')) score += 30;
  if (element.closest('nav, footer, [role="navigation"], [role="contentinfo"]')) score -= 25;

  return score;
}
