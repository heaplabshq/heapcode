// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_PROMPT_KEY } from '../src/shared/messages.js';

/**
 * Right-click → "Ask heapbrowse …", with the panel closed.
 *
 * Reported from real use: the menu item appeared to do nothing at all. The
 * cause was an ordering mistake with a silent failure mode, which is the worst
 * combination — `chrome.sidePanel.open` may only be called while the user
 * gesture that triggered the listener is still in scope, and *any* `await` ends
 * that scope. The call sat inside the `.then()` of the session-storage write,
 * so Chrome refused it every time, and a bare `.catch(() => {})` threw the
 * refusal away. With the panel already open nothing looked wrong, because the
 * port broadcast carried the prompt; with it closed — the one case the menu
 * exists for — the click vanished.
 *
 * So the property under test is not "open gets called" but "open gets called
 * before anything is awaited". That is what these assertions pin.
 */

type Listener = (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void;

/** Resolution is deferred so "did this run before the await settled?" is askable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let menuListener: Listener | undefined;
let sessionSet: ReturnType<typeof deferred<void>>;
let openCalls: unknown[];
let setCalls: Record<string, unknown>[];

beforeEach(async () => {
  vi.resetModules();
  menuListener = undefined;
  sessionSet = deferred<void>();
  openCalls = [];
  setCalls = [];

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'heapbrowse-test',
      onInstalled: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    },
    contextMenus: {
      removeAll: vi.fn(),
      create: vi.fn(),
      onClicked: { addListener: vi.fn((fn: Listener) => (menuListener = fn)) },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
      open: vi.fn((options: unknown) => {
        openCalls.push(options);
        return Promise.resolve();
      }),
    },
    // The worker also keeps the endpoint header rules in step with the saved
    // profiles (shared/originRules.ts); nothing here exercises that.
    declarativeNetRequest: {
      getDynamicRules: vi.fn().mockResolvedValue([]),
      updateDynamicRules: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: { get: vi.fn().mockResolvedValue({}) },
      onChanged: { addListener: vi.fn() },
      session: {
        set: vi.fn((values: Record<string, unknown>) => {
          setCalls.push(values);
          return sessionSet.promise;
        }),
      },
    },
    tabs: { onUpdated: { addListener: vi.fn() }, onActivated: { addListener: vi.fn() } },
    windows: { getCurrent: vi.fn().mockResolvedValue({ id: 9 }) },
  });

  await import('../src/background/index.js');
  expect(menuListener, 'the worker did not register a context-menu listener').toBeDefined();
});

afterEach(() => vi.unstubAllGlobals());

const pageClick = { menuItemId: 'heapbrowse-page' } as chrome.contextMenus.OnClickData;
const tab = { id: 7, windowId: 3 } as chrome.tabs.Tab;

describe('right-click with the panel closed', () => {
  it('opens the side panel synchronously, while the gesture is still valid', () => {
    menuListener!(pageClick, tab);

    // Not `await`ed: the assertion is that this already happened, in the same
    // turn as the click. The storage write has deliberately not settled.
    expect(openCalls).toEqual([{ tabId: 7 }]);
  });

  it('does not wait for the session write before opening', async () => {
    menuListener!(pageClick, tab);
    const openedBeforeWriteSettled = openCalls.length === 1;

    sessionSet.resolve();
    await Promise.resolve();

    expect(
      openedBeforeWriteSettled,
      'open() ran only after the storage write resolved — the user gesture is gone by then',
    ).toBe(true);
  });

  it('still leaves the prompt where a newly opened panel will find it', async () => {
    menuListener!(pageClick, tab);
    sessionSet.resolve();
    await Promise.resolve();

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]![PENDING_PROMPT_KEY]).toBe('What is this page, and what can I do on it?');
  });

  it('carries the selection, quoted, for the selection item', () => {
    menuListener!(
      { menuItemId: 'heapbrowse-selection', selectionText: '  the second law  ' } as chrome.contextMenus.OnClickData,
      tab,
    );
    expect(setCalls[0]![PENDING_PROMPT_KEY]).toBe('Explain this, from the page I am on: "the second law"');
  });

  it('carries the address for the link item', () => {
    menuListener!(
      { menuItemId: 'heapbrowse-link', linkUrl: 'https://example.com/spec' } as chrome.contextMenus.OnClickData,
      tab,
    );
    expect(setCalls[0]![PENDING_PROMPT_KEY]).toBe(
      'What is at this link, and is it worth opening? https://example.com/spec',
    );
  });

  it('does nothing at all for a menu item it does not know', () => {
    menuListener!({ menuItemId: 'someone-elses-menu' } as chrome.contextMenus.OnClickData, tab);
    expect(openCalls).toEqual([]);
    expect(setCalls).toEqual([]);
  });

  it('writes the prompt even when Chrome gave it no tab to open against', () => {
    // No tab means no panel to open, but the prompt must still be waiting for
    // whenever one is opened by hand.
    menuListener!(pageClick, undefined);
    expect(openCalls).toEqual([]);
    expect(setCalls).toHaveLength(1);
  });

  it('survives a panel that refuses to open, rather than losing the prompt', async () => {
    (chrome.sidePanel.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('already open'));
    menuListener!(pageClick, tab);
    sessionSet.resolve();
    await Promise.resolve();

    expect(setCalls).toHaveLength(1);
  });
});
