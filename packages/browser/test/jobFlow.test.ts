// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractSnapshot } from '../src/content/extract.js';
import { HandleRegistry } from '../src/content/registry.js';
import { classifyClick } from '../src/agent/destructive.js';

/**
 * The LinkedIn job-application flow, end to end through extraction.
 *
 * Reported from real use: every button in the flow was being confirmed, and the
 * Apply button carried a red "this cannot be undone". Both were wrong, and both
 * came from matching too loosely -- a form submit treated as a commitment, and a
 * generated class name treated as a checkout.
 */

function classifyButton(html: string, selector = 'button') {
  document.body.innerHTML = html;
  const snapshot = extractSnapshot(document, new HandleRegistry());
  const element = document.querySelector(selector)!;
  const name = element.textContent?.trim() ?? '';
  const control = snapshot.controls.find((c) => c.name === name);
  expect(control, `no control extracted for ${name}`).toBeDefined();
  return classifyClick(control!);
}

describe('a job search page', () => {
  it('treats Apply as routine — it opens the form, it does not send it', () => {
    const result = classifyButton(`
      <main>
        <div class="jobs-search__job-details">
          <div class="jobs-apply-button--top-card artdeco-card">
            <button class="jobs-apply-button artdeco-button">LinkedIn Apply</button>
          </div>
        </div>
      </main>`);
    expect(result.permission).toBe('write');
  });

  it('treats the wizard steps as routine', () => {
    for (const label of ['Next', 'Continue', 'Review']) {
      const result = classifyButton(
        `<main><form action="/jobs/apply"><button type="submit">${label}</button></form></main>`,
      );
      expect(result.permission, label).toBe('write');
    }
  });

  it('still stops at the button that actually sends the application', () => {
    const result = classifyButton(
      '<main><form action="/jobs/apply"><button type="submit">Submit application</button></form></main>',
    );
    expect(result.permission).toBe('destructive');
  });

  it('still stops inside a real payment area', () => {
    const result = classifyButton(`
      <main>
        <section class="checkout-panel">
          <form action="/checkout/confirm"><button type="submit">Continue</button></form>
        </section>
      </main>`);
    expect(result.permission).toBe('destructive');
    expect(result.reason).toMatch(/checkout/);
  });
});
