// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Settings } from '../src/sidepanel/components/Settings.js';
import { loadUseDebugger } from '../src/shared/settings.js';

/**
 * Turning the debugger on.
 *
 * The bug this guards: `chrome.permissions.request` is only honoured while the
 * gesture that led to it is still in scope, and *any* prior await ends it.
 * Checking whether the permission was already held before asking — the obvious
 * way to avoid a redundant prompt — meant the prompt never appeared at all. The
 * request resolved false, the checkbox sprang back to unticked, and nothing on
 * screen said why. It typechecks perfectly.
 */

interface Options {
  granted?: boolean;
  allowOnRequest?: boolean;
  stored?: Record<string, unknown>;
}

function stubChrome({ granted = false, allowOnRequest = true, stored = {} }: Options = {}) {
  const calls: string[] = [];
  const store: Record<string, unknown> = { ...stored };

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
        remove: vi.fn(async () => {}),
      },
    },
    permissions: {
      contains: vi.fn(async (query: chrome.permissions.Permissions) => {
        if (query.permissions?.includes('debugger')) {
          calls.push('contains');
          return granted;
        }
        return true;
      }),
      request: vi.fn(async (query: chrome.permissions.Permissions) => {
        if (query.permissions?.includes('debugger')) {
          calls.push('request');
          return allowOnRequest;
        }
        return true;
      }),
    },
  });

  return { calls, store };
}

const profile = { name: 'default', preset: 'ollama' as const, baseUrl: 'http://x/v1', model: 'm' };

function renderSettings() {
  render(<Settings profile={profile} origin="chrome-extension://abc" onSaved={() => {}} />);
  return screen.findByRole('checkbox', { name: /Chrome.s debugger/i }) as Promise<HTMLInputElement>;
}

afterEach(() => {
  // Not automatic here: RTL only registers its own cleanup when vitest runs with
  // globals, and this repo does not.
  cleanup();
  vi.unstubAllGlobals();
});

describe('the debugger switch', () => {
  it('asks for the permission with nothing awaited first', async () => {
    // The ordering *is* the fix. A `contains` check before `request` is exactly
    // what broke it, so its absence before the request is the thing to assert.
    const { calls } = stubChrome({ granted: false });
    const box = await renderSettings();

    // The mount-time check is fine and expected; what matters is what happens
    // between the click and the request, because that is where the gesture dies.
    calls.length = 0;
    box.click();

    await waitFor(() => expect(calls).toContain('request'));
    expect(calls).toEqual(['request']);
  });

  it('ticks and stays ticked once Chrome allows it', async () => {
    const { store } = stubChrome({ granted: false, allowOnRequest: true });
    const box = await renderSettings();
    box.click();

    await waitFor(() => expect(box.checked).toBe(true));
    expect(store['heapbrowse.useDebugger']).toBe(true);
  });

  it('says so when Chrome declines, instead of silently springing back', async () => {
    stubChrome({ granted: false, allowOnRequest: false });
    const box = await renderSettings();
    box.click();

    expect(await screen.findByText(/Chrome declined the permission/i)).toBeTruthy();
    expect(box.checked).toBe(false);
  });

  it('shows off when the setting is on but the permission is not held', async () => {
    // The honest state on a fresh install: the setting defaults on, and an
    // optional permission cannot be granted at install time. A switch reading
    // "on" while nothing had changed would be worse than one reading "off".
    stubChrome({ granted: false, stored: { 'heapbrowse.useDebugger': true } });
    const box = await renderSettings();
    await waitFor(() => expect(box.checked).toBe(false));
    expect(await screen.findByText(/has not granted this yet/i)).toBeTruthy();
  });

  it('shows on when the setting is on and the permission is held', async () => {
    stubChrome({ granted: true, stored: { 'heapbrowse.useDebugger': true } });
    const box = await renderSettings();
    await waitFor(() => expect(box.checked).toBe(true));
  });
});

describe('the default', () => {
  it('is on, so the better path is the one people are on', async () => {
    // Defaulting it off meant the good path was the one nobody used, while
    // every per-site failure came from the path that estimates what CDP knows.
    stubChrome({ stored: {} });
    expect(await loadUseDebugger()).toBe(true);
  });

  it('stays off once someone has turned it off', async () => {
    stubChrome({ stored: { 'heapbrowse.useDebugger': false } });
    expect(await loadUseDebugger()).toBe(false);
  });
});
