// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';

describe('wiki links in replies', () => {
  it('render as catchable links only when asked for', () => {
    const html = renderMarkdown('See [[Launch plan]] and [[Team offsite|the offsite]].', { wikiLinks: true });
    expect(html).toContain('<a href="#" class="wikilink" data-wikilink="Launch plan">Launch plan</a>');
    expect(html).toContain('data-wikilink="Team offsite">the offsite</a>');
    expect(renderMarkdown('See [[Launch plan]].')).not.toContain('data-wikilink');
  });

  it('escape what the model put inside the brackets', () => {
    const box = document.createElement('div');
    box.innerHTML = renderMarkdown('[[<img src=x onerror=alert(1)>]]', { wikiLinks: true });
    // Text and an attribute value, never an element.
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('a')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
