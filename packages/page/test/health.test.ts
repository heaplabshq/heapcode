// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ActivityWatch, pageHealth } from '../src/health.js';

const page = (html: string): Document => {
  document.body.innerHTML = html;
  return document;
};

describe('pageHealth', () => {
  it('finds error screens and unformatted values, not validation messages or code', () => {
    const health = pageHealth(
      page(`<h1>Orders</h1><p>Total: <span id="t">NaN</span></p><div>TypeError: Cannot read properties of undefined (reading 'id')</div>
        <p class="hint">Email is required</p><code>undefined</code><p hidden>Internal Server Error</p><span>[object Object]</span>`),
    );
    expect(health.errorTexts).toEqual([
      '"NaN" shown on the page (in <span#t>)',
      "TypeError: Cannot read properties of undefined (reading 'id')",
      '"[object Object]" shown on the page (in <span>)',
    ]);
  });

  it('says nothing about a healthy page', () => {
    expect(pageHealth(page('<h1>Hello</h1><p>All good, 3 items.</p>'))).toEqual({ errorTexts: [], overflowX: 0 });
  });
});

describe('ActivityWatch', () => {
  it('counts DOM changes between start and stop', async () => {
    const doc = page('<p id="x">a</p>');
    const watch = new ActivityWatch();
    watch.start(doc);
    doc.getElementById('x')!.textContent = 'b';
    await new Promise((r) => setTimeout(r, 0));
    expect(watch.stop()).toBeGreaterThan(0);
    watch.start(doc);
    await new Promise((r) => setTimeout(r, 0));
    expect(watch.stop()).toBe(0);
  });
});
