// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Settings } from '../src/sidepanel/components/Settings.js';
import { loadUseDebugger } from '../src/shared/settings.js';

/**
 * Turning the debugger on.
 *
 * This went through a wrong design first, and the wrong design is worth
 * recording: `debugger` was declared under `optional_permissions` and requested
 * at runtime. Chrome silently drops it there — "Permission 'debugger' cannot be
 * listed as optional" — and then throws on the request, so the switch could
 * never stay ticked and nothing in the panel could explain why.
 *
 * It is a required permission: held from install or not at all. So the switch is
 * only a preference, and there is no grant to negotiate.
 */

function stubChrome(stored: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...stored };
  const request = vi.fn();

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
        remove: vi.fn(async () => {}),
      },
    },
    permissions: { contains: vi.fn(async () => true), request },
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(), onDetach: { addListener: vi.fn() } },
  });

  return { store, request };
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
  it('never asks for a permission at runtime, because that always throws', async () => {
    // `permissions.request` rejects for anything the manifest does not list as
    // optional, and `debugger` cannot be listed as optional.
    const { request } = stubChrome({ 'heapbrowse.useDebugger': false });
    const box = await renderSettings();
    await waitFor(() => expect(box.checked).toBe(false));

    box.click();

    await waitFor(() => expect(box.checked).toBe(true));
    expect(request).not.toHaveBeenCalled();
  });

  it('is already on for a fresh install, before anyone touches it', async () => {
    stubChrome();
    const box = await renderSettings();
    await waitFor(() => expect(box.checked).toBe(true));
  });

  it('ticks and stays ticked', async () => {
    const { store } = stubChrome({ 'heapbrowse.useDebugger': false });
    const box = await renderSettings();
    box.click();

    await waitFor(() => expect(box.checked).toBe(true));
    expect(store['heapbrowse.useDebugger']).toBe(true);
  });

  it('can be turned back off', async () => {
    const { store } = stubChrome({ 'heapbrowse.useDebugger': true });
    const box = await renderSettings();
    await waitFor(() => expect(box.checked).toBe(true));

    box.click();

    await waitFor(() => expect(box.checked).toBe(false));
    expect(store['heapbrowse.useDebugger']).toBe(false);
  });

  it('reflects what was stored', async () => {
    stubChrome({ 'heapbrowse.useDebugger': false });
    const box = await renderSettings();
    await waitFor(() => expect(box.checked).toBe(false));
  });
});

describe('the default', () => {
  it('is on, so the better path is the one people are on', async () => {
    // Defaulting it off meant the good path was the one nobody used, while
    // every per-site failure came from the path that estimates what CDP knows.
    stubChrome();
    expect(await loadUseDebugger()).toBe(true);
  });

  it('stays off once someone has turned it off', async () => {
    stubChrome({ 'heapbrowse.useDebugger': false });
    expect(await loadUseDebugger()).toBe(false);
  });
});
