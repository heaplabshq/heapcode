// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { inspect } from '../src/inspect.js';
import { fingerprintOf } from '../src/fingerprint.js';
import { describeFingerprint, domAround, domCandidates, domOutline, domSearch, domSubtree } from '../src/domTools.js';

function tree(html: string) {
  document.body.innerHTML = html;
  return inspect(document);
}

const PAGE = `<main><h1>Account</h1><form id="f"><label for="e">Email</label><input id="e">
  <div class="actions"><button class="btn primary" data-testid="save">Save changes</button><button>Cancel</button></div></form></main>`;

describe('DOM tools', () => {
  it('outlines to a depth and cuts deeper parts', () => {
    const t = tree(PAGE);
    const out = domOutline(t, { depth: 2 });
    expect(out).toContain('<body>');
    expect(out).toContain('<form#f>');
    expect(out).toMatch(/… 3 child elements/);
    expect(out).not.toContain('Save changes');
  });

  it('searches text, names and attributes', () => {
    const t = tree(PAGE);
    expect(domSearch(t, 'save')).toMatch(/<button\.btn\.primary> button "Save changes" data-testid=save/);
    expect(domSearch(t, 'nope')).toBe('Nothing on the page contains "nope".');
  });

  it('opens one branch and shows where an element sits', () => {
    const t = tree(PAGE);
    const save = t.nodes.find((n) => n.attrs['data-testid'] === 'save')!;
    expect(domSubtree(t, t.nodes.find((n) => n.attrs.class === 'actions')!.id)).toContain('"Cancel"');
    const around = domAround(t, save.id);
    expect(around).toMatch(/Ancestors:[\s\S]*<form#f>[\s\S]*Siblings:\n→ \[\d+\] <button/);
  });

  it('ranks the elements most like a saved one, saying what matched', () => {
    const before = tree(PAGE);
    const saved = fingerprintOf(before, before.nodes.find((n) => n.attrs['data-testid'] === 'save')!.id);
    expect(describeFingerprint(saved)).toMatch(/^<button\.btn\.primary>, role button, named "Save changes", test id save/);
    const after = tree(PAGE.replace('data-testid="save">Save changes', '>Save'));
    const out = domCandidates(after, saved);
    expect(out.split('\n')[0]).toMatch(/^\d+%  \[\d+\] <button\.btn\.primary> button "Save"/);
  });
});
