/**
 * The agent's browser_* tools: what is offered to whom, and the local-only
 * rule that keeps a shell-running agent off the open web.
 */
import { describe, expect, it } from 'vitest';
import {
  browserTools,
  classifyBrowserAction,
  describeBrowserAction,
  isLocalPage,
  normalizeLocalUrl,
} from '../src/browserTools.js';

describe('which browser tools a run is offered', () => {
  it('offers none to a plain browser tab, which has no pane to lend', () => {
    expect(browserTools({ clientHasBrowser: false, vision: true })).toEqual([]);
  });

  it('offers screenshots only to a model that can see them', () => {
    const names = (vision: boolean): string[] => browserTools({ clientHasBrowser: true, vision }).map((t) => t.name);
    expect(names(false)).not.toContain('browser_screenshot');
    expect(names(true)).toContain('browser_screenshot');
  });

  it('marks every result as untrusted, since a page is not the user speaking', () => {
    for (const tool of browserTools({ clientHasBrowser: true, vision: true })) {
      expect(tool.untrustedOutput).toBe(true);
    }
  });

  it('lets the agent look freely, but asks before it acts', () => {
    const perm = Object.fromEntries(
      browserTools({ clientHasBrowser: true, vision: true }).map((t) => [t.name, t.permission]),
    );
    expect(perm).toMatchObject({
      browser_open: 'read',
      browser_snapshot: 'read',
      browser_console: 'read',
      browser_screenshot: 'read',
      browser_click: 'execute',
      browser_type: 'execute',
      browser_select: 'execute',
      browser_press: 'execute',
    });
  });
});

describe('the local-only rule', () => {
  it('allows loopback and names reserved for local development', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://127.0.0.1:8000/docs',
      'http://[::1]:3000',
      'https://app.localhost/',
      'http://shop.test/cart',
    ]) {
      expect(isLocalPage(url), url).toBe(true);
    }
  });

  it('refuses the open web, and names that only look local', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost.evil.com/',
      'http://127.0.0.1.nip.io/',
      'http://192.168.1.10:3000/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(isLocalPage(url), url).toBe(false);
    }
  });

  it("refuses heapcode's own page, which holds the socket that runs commands", () => {
    expect(isLocalPage('http://127.0.0.1:7411/', 'http://127.0.0.1:7411')).toBe(false);
  });

  it('accepts a bare address the way people type one', () => {
    expect(normalizeLocalUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeLocalUrl('0.0.0.0:8000/x')).toBe('http://localhost:8000/x');
    expect(normalizeLocalUrl('https://example.com')).toBe('https://example.com');
  });
});

describe('permission cards for page actions', () => {
  const call = (name: string, args: Record<string, unknown>) => ({ id: '1', name, args });

  it('raises a click on something that commits to destructive', () => {
    for (const target of [
      'button "Delete project"',
      'button "Pay now"',
      'button "Submit order"',
      'link "Unsubscribe"',
      // A verb commits whatever noun follows it.
      'button "Delete order history"',
    ]) {
      expect(classifyBrowserAction(call('browser_click', { ref: '3' }), target), target).toBe('destructive');
    }
  });

  it('leaves ordinary clicks, and words that merely contain those, as execute', () => {
    for (const target of [
      'button "Save draft"',
      'button "Apply filters"',
      'link "Payment history"',
      'link "Order details"',
      'tab "Orders"',
      undefined,
    ]) {
      expect(classifyBrowserAction(call('browser_click', { ref: '3' }), target), String(target)).toBe('execute');
    }
  });

  it('does not make every Enter red — a search box is not a commit', () => {
    expect(classifyBrowserAction(call('browser_type', { ref: '2', text: 'shoes', submit: true }), 'textbox "Search"')).toBe(
      'execute',
    );
    expect(classifyBrowserAction(call('browser_press', { key: 'Enter' }), undefined)).toBe('execute');
  });

  it('names the element and the page in the card', () => {
    expect(describeBrowserAction(call('browser_click', { ref: '3' }), 'button "Save"', 'http://localhost:5173/settings')).toBe(
      'Click button "Save" on localhost:5173/settings',
    );
    expect(
      describeBrowserAction(call('browser_type', { ref: '2', text: 'a@b.c', submit: true }), 'textbox "Email"', undefined),
    ).toBe('Type "a@b.c" into textbox "Email" and press Enter');
  });

  it('drops the bare trailing slash of a site root', () => {
    expect(describeBrowserAction(call('browser_click', { ref: '1' }), 'button "Save"', 'http://localhost:8767/')).toBe(
      'Click button "Save" on localhost:8767',
    );
  });

  it('says so when the element was not in the last snapshot, rather than guessing', () => {
    expect(describeBrowserAction(call('browser_click', { ref: '99' }), undefined, undefined)).toBe(
      'Click element [99] (not in the last snapshot)',
    );
  });
});
