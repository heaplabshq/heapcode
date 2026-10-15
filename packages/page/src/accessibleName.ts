/**
 * What to call a control.
 *
 * An unnamed control is close to useless to the model — it cannot ask for
 * "[7]" meaningfully if [7] renders as `button ""`. This follows the order a
 * screen reader broadly uses, because that order was chosen for exactly this
 * problem: which of the several strings attached to an element is the one a
 * human would use to refer to it.
 *
 * Not a full AccName implementation. The spec's algorithm is large and much of
 * it concerns cases (nested labels, `aria-owns` reparenting) that matter for
 * assistive tech correctness but rarely change which control the model picks.
 * PRD §4.3 already decided a DOM walk over the real accessibility tree for v1;
 * this is the same trade at a smaller scale, and where it falls short the
 * answer is `context` from the surrounding heading, not more of the spec.
 */

const MAX_NAME = 120;

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** Text of the elements `aria-labelledby` points at, in the order given. */
function labelledBy(element: Element): string {
  const ids = element.getAttribute('aria-labelledby');
  if (!ids) return '';
  const doc = element.ownerDocument;
  return clean(
    ids
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
}

/** The `<label>` associated with a form control, by `for=` or by wrapping. */
function labelFor(element: Element): string {
  const id = element.getAttribute('id');
  if (id) {
    // CSS.escape keeps ids containing quotes or brackets from breaking the
    // selector — those are legal in HTML and common in generated markup.
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
    const explicit = element.ownerDocument.querySelector(`label[for="${escaped}"]`);
    if (explicit?.textContent) return clean(explicit.textContent);
  }
  const wrapping = element.closest('label');
  if (wrapping?.textContent) return clean(wrapping.textContent);
  return '';
}

export function accessibleName(element: Element): string {
  const aria = clean(element.getAttribute('aria-label'));
  if (aria) return aria;

  const referenced = labelledBy(element);
  if (referenced) return referenced;

  const label = labelFor(element);
  if (label) return label;

  // An image button's alt text is its name; so is a submit input's value.
  if (element instanceof HTMLInputElement) {
    if (element.type === 'submit' || element.type === 'button' || element.type === 'reset') {
      const value = clean(element.value);
      if (value) return value;
    }
  }

  const text = clean(element.textContent);
  if (text) return text;

  const alt = clean(element.querySelector('img[alt]')?.getAttribute('alt'));
  if (alt) return alt;

  for (const attribute of ['placeholder', 'title', 'name', 'value']) {
    const found = clean(element.getAttribute(attribute));
    if (found) return found;
  }

  return '';
}

/**
 * The nearest thing that explains an ambiguous control.
 *
 * Twenty buttons all named "Add to cart" are indistinguishable to the model,
 * and picking the wrong one is a real purchase. The row or card a control sits
 * in usually carries the distinguishing text, so it is worth the walk up.
 */
export function nearestContext(element: Element): string | undefined {
  const row = element.closest('tr, li, article, [role="row"], [role="listitem"]');
  if (row) {
    const text = clean(row.textContent);
    if (text) return text.slice(0, 80);
  }

  let node: Element | null = element;
  while (node) {
    let sibling: Element | null = node.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) {
        const heading = clean(sibling.textContent);
        if (heading) return heading;
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return undefined;
}
