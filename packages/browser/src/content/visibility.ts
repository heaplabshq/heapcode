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

/**
 * The checkbox you cannot see but can still press.
 *
 * Modern form controls are built as a real `<input>` made invisible -- opacity
 * zero, or a one-pixel box -- with a styled span or svg beside it doing the
 * looking, and a `<label>` over both so a person's click lands on the real
 * control. `isVisible` is right to say the input cannot be seen, and acting on
 * that alone is how heapbrowse ended up offering the model everything in the
 * row *except* the thing that toggles.
 *
 * Watched it happen on GitHub's label picker: the checkbox was dropped, the
 * row's link survived, and the model clicked the only control it had been
 * given -- which navigated to the filtered issue list. It then spent a very
 * long turn reasoning about why a checkbox it had been told was not there was
 * not there. Every conclusion it reached was correct. The snapshot was wrong.
 *
 * So the test is not "can this be seen" but "can a person work it": the input
 * is still rendered, still focusable, and something visible is wired to
 * activate it. A control hidden by `display:none`, `[hidden]`, `inert` or
 * `aria-hidden` fails all of that and stays excluded -- those say the control
 * is not for anyone right now, which is a different claim from "drawn by
 * something else".
 */
export function isVisuallyHiddenControl(element: Element): boolean {
  if (!(element instanceof HTMLInputElement)) return false;
  if (element.type !== 'checkbox' && element.type !== 'radio' && element.type !== 'file') {
    return false;
  }
  // Declared not-for-the-user, which the styled-label idiom never does.
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) {
    return false;
  }
  return labelledBySomethingVisible(element);
}

/**
 * Whether something a person can see is wired to this control.
 *
 * `labels` covers both spellings -- `<label for>` and a label wrapped around
 * the input -- and a visible one of either is what makes the hidden input
 * reachable. Without it there is nothing to click and nothing to see, and the
 * input really is furniture.
 */
function labelledBySomethingVisible(element: HTMLInputElement): boolean {
  const labels = element.labels ? [...element.labels] : [];
  const wrapping = element.closest('label');
  if (wrapping && !labels.includes(wrapping)) labels.push(wrapping);
  return labels.some((label) => isVisible(label));
}

/**
 * What to put the confirmation ring around.
 *
 * For almost everything that is the element itself. For a control drawn by a
 * styled label it cannot be: a ring around a one-pixel input, or around one
 * with no size at all, is a ring around nothing, and the user is being asked
 * to approve what they can see (PRD section 6.1.4). The label is both what
 * they see and what their own click would land on, so it is the honest thing
 * to outline.
 */
export function highlightTarget(element: Element): Element {
  if (!isVisuallyHiddenControl(element)) return element;
  const labels = element instanceof HTMLInputElement && element.labels ? [...element.labels] : [];
  const wrapping = element.closest('label');
  if (wrapping) labels.push(wrapping);
  return labels.find((label) => isVisible(label)) ?? element;
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
