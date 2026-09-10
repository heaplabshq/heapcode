/**
 * Model output cannot push the page sideways.
 *
 * Reported from a real session: a model working through arithmetic wrote
 * "13,051+62,093+43,687+…" — 150 characters with no whitespace in them — and
 * `white-space: pre-wrap` had nothing to break on, so the thinking block ran
 * off the right of the viewport and took the page's horizontal scroll with
 * it. The same held for assistant messages and user bubbles, in both
 * products, because the stylesheet is shared.
 *
 * Asserted against the stylesheet text rather than a rendered layout: the
 * test environment has no layout engine, so there is nothing to measure. What
 * can be checked is that the declaration is there and that code blocks were
 * not swept up in it — they must keep scrolling rather than break mid-token.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

/** The declarations inside the block for `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for "${selector}"`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('long unbroken output', () => {
  it('can break inside every container that holds model output', () => {
    // One rule covers both, and covers both products with them.
    expect(rule('.msg-body, .bubble')).toContain('overflow-wrap: anywhere');
    expect(rule('.reasoning-body')).toContain('overflow-wrap: anywhere');
  });

  it('leaves code blocks and tables scrolling instead', () => {
    // `white-space: pre` offers no wrap opportunity for overflow-wrap to act
    // on, so these keep their own horizontal scroll — breaking a line of code
    // at an arbitrary column would be worse than scrolling it.
    expect(rule('.msg-body pre')).toContain('overflow-x: auto');
    expect(rule('.msg-body pre')).not.toContain('overflow-wrap');
    expect(rule('.msg-body table')).toContain('overflow-x: auto');
  });

  it('pins the thinking block’s font, which the two products disagreed on', () => {
    // Heap Code renders it in a <pre> and Heap Chat in a <div>, so leaving the
    // font to the element gave the same block monospace on one side of the
    // switcher and sans on the other.
    expect(rule('.reasoning-body')).toContain('font-family: var(--mono)');
  });
});
