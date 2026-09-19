// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractSnapshot } from '../src/content/extract.js';
import { HandleRegistry } from '../src/content/registry.js';
import { performClick } from '../src/content/actions.js';
import { highlightTarget } from '../src/content/visibility.js';

/**
 * The checkbox a person can work and heapbrowse could not see.
 *
 * Every case here is the same idiom: the real input made invisible, something
 * styled drawn in its place, a label wiring the two together. It is how GitHub,
 * and most design systems, build a checkbox -- and dropping it left the model
 * with a row containing everything except the thing that toggles. On GitHub's
 * label picker what survived was the row's link, so the only control on offer
 * navigated away from the dialog.
 *
 * jsdom reports every rect as zero, which `isVisible` treats as unknown rather
 * than as hidden, so the geometric half of the idiom is stubbed where it is the
 * thing under test. The declarative half (`opacity`, `hidden`, `aria-hidden`)
 * needs no stubbing.
 */

function snapshot(html: string) {
  document.body.innerHTML = html;
  return extractSnapshot(document, new HandleRegistry());
}

function sized(selector: string, width: number, height: number) {
  const element = document.querySelector(selector) as HTMLElement;
  element.getBoundingClientRect = () =>
    ({ width, height, top: 40, left: 10, right: 10 + width, bottom: 40 + height }) as DOMRect;
  return element;
}

const PICKER = `
  <div role="dialog">
    <label>
      <input type="checkbox" style="opacity:0" name="bug">
      <span>bug</span>
      <a href="/issues?q=label%3Abug">Something isn't working</a>
    </label>
  </div>`;

describe('a checkbox drawn by a styled label', () => {
  it('is offered, so the model has something to toggle', () => {
    const page = snapshot(PICKER);
    const checkbox = page.controls.find((control) => control.role === 'checkbox');
    expect(checkbox).toBeTruthy();
    expect(checkbox!.checked).toBe(false);
  });

  it('carries the label text, which is the only name it has', () => {
    const page = snapshot(PICKER);
    expect(page.controls.find((c) => c.role === 'checkbox')!.name).toContain('bug');
  });

  it('is offered when it is hidden by size rather than by opacity', () => {
    snapshot('<label><input type="checkbox" id="c"><span>16GB</span></label>');
    sized('#c', 1, 1);
    const page = extractSnapshot(document, new HandleRegistry());
    expect(page.controls.some((control) => control.role === 'checkbox')).toBe(true);
  });

  it('toggles when clicked, rather than being refused for having no size', () => {
    snapshot('<label><input type="checkbox" id="c"><span>16GB</span></label>');
    const input = sized('#c', 0, 0) as HTMLInputElement;
    const result = performClick(input);
    expect(result.ok).toBe(true);
    expect(input.checked).toBe(true);
  });

  it('covers radios and file inputs, which are built the same way', () => {
    const page = snapshot(`
      <label><input type="radio" name="size" style="opacity:0"><span>Large</span></label>
      <label><input type="file" style="opacity:0"><span>Upload your CV</span></label>`);
    expect(page.controls.some((c) => c.role === 'radio')).toBe(true);
    expect(page.controls.some((c) => c.name.includes('Upload'))).toBe(true);
  });
});

describe('a control that is genuinely not there', () => {
  it('stays out when it is display:none', () => {
    const page = snapshot('<label style="display:none"><input type="checkbox" style="display:none"><span>bug</span></label>');
    expect(page.controls.some((control) => control.role === 'checkbox')).toBe(false);
  });

  it('stays out when a parent is aria-hidden or inert', () => {
    const aria = snapshot('<div aria-hidden="true"><label><input type="checkbox" style="opacity:0"><span>bug</span></label></div>');
    expect(aria.controls.some((control) => control.role === 'checkbox')).toBe(false);
    const inert = snapshot('<div inert><label><input type="checkbox" style="opacity:0"><span>bug</span></label></div>');
    expect(inert.controls.some((control) => control.role === 'checkbox')).toBe(false);
  });

  /**
   * The line the rule draws: invisible *and* unreachable is furniture. Without
   * a label there is nothing on screen wired to it, so offering it would be
   * offering a control nobody -- model or person -- can operate.
   */
  it('stays out when nothing visible is wired to it', () => {
    const page = snapshot('<input type="checkbox" style="opacity:0" aria-label="tracking pixel">');
    expect(page.controls.some((control) => control.role === 'checkbox')).toBe(false);
  });

  it('stays out when its label is itself hidden', () => {
    const page = snapshot(
      '<label style="display:none"><input type="checkbox" style="opacity:0"><span>bug</span></label>',
    );
    expect(page.controls.some((control) => control.role === 'checkbox')).toBe(false);
  });
});

describe('what the confirmation ring goes around', () => {
  /**
   * The user approves what they can see. Ringing the input itself would ring
   * nothing at all, which is the one thing a confirmation must never do.
   */
  it('is the label, when the control itself is invisible', () => {
    snapshot(PICKER);
    const input = document.querySelector('input[type=checkbox]')!;
    expect(highlightTarget(input).tagName).toBe('LABEL');
  });

  it('is the control itself for everything else', () => {
    snapshot('<button>Add to cart</button>');
    const button = document.querySelector('button')!;
    expect(highlightTarget(button)).toBe(button);
  });
});
