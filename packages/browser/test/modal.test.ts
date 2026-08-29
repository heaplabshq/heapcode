// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractSnapshot, extractText } from '../src/content/extract.js';
import { HandleRegistry } from '../src/content/registry.js';
import { openModal } from '../src/content/modal.js';

function load(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function snapshot(html: string) {
  return extractSnapshot(load(html), new HandleRegistry());
}

/**
 * A page with a dialog open is, for the agent, only the dialog.
 *
 * Everything behind a modal is inert -- the browser blocks clicks on it, and a
 * site with its own overlay blocks them with the overlay. Offering those
 * controls anyway hands the model a menu of things that cannot be clicked,
 * indistinguishable from the ones that can. Observed on LinkedIn: the agent
 * fought the filter panel, clicked past it, and reported that the panel "seems
 * to have closed" -- which a click on the backdrop would indeed do.
 */

const PAGE_AND_DIALOG = `
  <main>
    <button>Background search</button>
    <a href="/jobs">Background link</a>
  </main>
  <div role="dialog" aria-modal="true">
    <h2>All filters</h2>
    <button>Experience level</button>
    <button>Show results</button>
  </div>`;

describe('when a dialog is open', () => {
  it('offers only the controls inside it', () => {
    const page = snapshot(PAGE_AND_DIALOG);
    const names = page.controls.map((c) => c.name);
    expect(names).toContain('Experience level');
    expect(names).toContain('Show results');
    expect(names).not.toContain('Background search');
    expect(names).not.toContain('Background link');
  });

  it('says so, so the model knows why the page looks different', () => {
    expect(snapshot(PAGE_AND_DIALOG).title).toMatch(/dialog open/);
  });

  it('takes its text from the dialog, not the page behind it', () => {
    const doc = load(PAGE_AND_DIALOG);
    const modal = openModal(doc)!;
    const text = extractText(doc, modal);
    expect(text).toContain('All filters');
    expect(text).not.toContain('Background');
  });

  it('numbers handles from 1 within the dialog', () => {
    // The budget matters here too: a snapshot spending its allowance on the
    // page underneath has little left for the controls that can be used.
    expect(snapshot(PAGE_AND_DIALOG).controls[0]?.handle).toBe(1);
  });
});

describe('what counts as an open dialog', () => {
  it('recognises the usual markup', () => {
    for (const html of [
      '<div role="dialog" aria-modal="true"><button>x</button></div>',
      '<div aria-modal="true"><button>x</button></div>',
      '<dialog open><button>x</button></dialog>',
    ]) {
      expect(openModal(load(html)), html).toBeDefined();
    }
  });

  it('ignores closed or hidden dialog markup left in the DOM', () => {
    // Sites routinely leave every modal in the document and toggle it.
    for (const html of [
      '<div role="dialog" aria-modal="true" aria-hidden="true"><button>x</button></div>',
      '<div role="dialog" aria-modal="true" style="display:none"><button>x</button></div>',
      '<dialog><button>x</button></dialog>',
      '<div role="dialog"><button>x</button></div>',
    ]) {
      expect(openModal(load(html)), html).toBeUndefined();
    }
  });

  it('picks the innermost when a dialog opens from a dialog', () => {
    const doc = load(`
      <div role="dialog" aria-modal="true" id="outer">
        <div role="dialog" aria-modal="true" id="inner"><button>Confirm</button></div>
      </div>`);
    expect(openModal(doc)?.id).toBe('inner');
  });

  it('leaves an ordinary page alone', () => {
    const page = snapshot('<main><button>Search</button></main>');
    expect(page.controls.map((c) => c.name)).toEqual(['Search']);
    expect(page.title).not.toMatch(/dialog/);
  });
});
