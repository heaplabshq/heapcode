import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

/**
 * The MV3 manifest.
 *
 * Permissions are deliberately minimal for M0, which has no page access at all
 * — the panel talks to a provider and nothing else. `activeTab` and `scripting`
 * are declared now because the panel's plumbing is built against them, but
 * nothing requests a host until M1. `<all_urls>` is not here and should stay
 * out: PRD §7.6 notes that broad host permissions plus sending page content to
 * a third-party endpoint is what draws Chrome Web Store review scrutiny, so the
 * plan is `activeTab` plus per-site grants for as long as the UX survives it.
 *
 * `host_permissions` is empty and `optional_host_permissions` carries the web
 * instead. The provider endpoint is whatever the user configures — BYOK, not
 * knowable at build time — so it cannot be a static entry, and declaring a
 * whole-web wildcard up front would ask every user for all of it at install
 * time. The panel requests the single origin the user configured, when they
 * configure it (see shared/hostPermission.ts).
 *
 * That grant fixes CORS, which is a browser-side concern. It does not fix a
 * local Ollama: Ollama rejects a `chrome-extension://` origin server-side with
 * a 403 regardless of what Chrome allows, so `OLLAMA_ORIGINS` is still
 * required (PRD §7.2). Two different problems with two different fixes, which
 * is why the diagnostic reports them separately.
 */
/**
 * Pins the extension ID.
 *
 * Without it Chrome derives an unpacked extension's ID from the absolute path
 * it was loaded from, so the ID changes the moment the build output moves or
 * the extension is removed and re-added from somewhere else. That is invisible
 * until something outside the browser has been told the old ID — and here that
 * is exactly the case we ship for. A local Ollama has to list
 * `chrome-extension://<id>` in OLLAMA_ORIGINS (see shared/ollamaDiagnostic.ts),
 * and a silently-changed ID turns that back into the 403 the user already
 * fixed once, with nothing to say why.
 *
 * This is the PUBLIC half of an RSA keypair and is meant to be committed:
 * publishing it is what makes the ID reproducible for everyone building this
 * repo. The private half signs a .crx, which nothing here does — the Web Store
 * signs its own — so it is generated to packages/browser/.keys/ and gitignored
 * rather than shared.
 *
 * Derived ID: cbockgpkngiajhbhpidaolpneikomoeb
 *
 * REPLACE THIS WHEN THE EXTENSION IS FIRST UPLOADED TO THE CHROME WEB STORE.
 * The store issues its own keypair and its own ID, and ignores this field.
 * Chrome's documented flow is to upload the zip, read Package → "View public
 * key" in the dashboard, and paste that value here: that, and only that, makes
 * the ID a developer sees locally the same one users get. Leaving this key in
 * place after publishing is not dangerous, it just means dev and production
 * disagree about the ID again — the one thing this field exists to prevent.
 */
const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoZhAPBdGXQGPVhEODTQ9CoSi0TUbmj1SMlXmtuol99WgnmjrszJfGmGc+1topLufOJjiC3U7S5YApgbVj1giZmU+s9dvoDAchCisKxDaNdTQS2zEQESkw3y0RW4kzhj3WXSG+0T7+wQfyDgo0wV1ihzzk0Ms+B/piA1kojTK1B8J1767v3zc77LIvfMjZtpobV+qXl0oV4xVtm2x1lGSVUVcSLzzVYGgRc/b5UpkJldPPbmqEODeQtZtsn8WhzKclpCaKl1qhCRX3tDUfR7xO18lM6L1pKpaKb/DYBYZwNthl9tUp0Q+00iGTj1KzG3SbLmM+K7LRd0G1iIXIafZawIDAQAB';

export default defineManifest({
  manifest_version: 3,
  key: PUBLIC_KEY,
  name: 'heapbrowse',
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: '116', // chrome.sidePanel landed in 114; 116 for sidePanel.setOptions
  /*
   * The mark, at the four sizes Chrome asks for.
   *
   * `icons` is the extension itself -- the management page, the store listing,
   * the permission prompts; `action` is the toolbar button, which is drawn at
   * 16 and at 32 on a hidpi screen. Without either, Chrome draws a grey puzzle
   * piece, and a store submission is rejected for the missing 128.
   *
   * Rendered from `public/icons/icon.svg` by `scripts/icons.mjs`. The PNGs are
   * committed, so building needs no rasteriser.
   */
  icons: {
    16: 'icons/16.png',
    32: 'icons/32.png',
    48: 'icons/48.png',
    128: 'icons/128.png',
  },
  action: {
    default_title: 'Open heapbrowse',
    default_icon: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
  },
  /**
   * Opening the panel from the keyboard.
   *
   * A named command with its own handler, not `_execute_action`. The action
   * click opens the panel only because the worker set `openPanelOnActionClick`,
   * which Chrome applies to a real click on the toolbar button and not to a
   * command that merely fires the same event — so `_execute_action` bound the
   * key to nothing observable.
   *
   * `Alt+Shift+H` because `Command+Shift+H` is already Chrome's own Home
   * shortcut on macOS: Chrome silently declines to assign a key it has taken,
   * and the result is a shortcut that exists in the manifest, appears in
   * chrome://extensions/shortcuts as unset, and does nothing at all.
   */
  commands: {
    'open-panel': {
      suggested_key: { default: 'Alt+Shift+H', mac: 'Alt+Shift+H' },
      description: 'Open heapbrowse',
    },
  },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  // `tabs` is what makes `tab.url` readable. Without it Chrome returns tabs with
  // no URL unless the extension already holds a grant for that specific tab, so
  // the panel cannot tell the user which site they are on — and cannot offer a
  // per-site grant, because it does not know which site to ask for. It buys
  // visibility of the address only; reading page *content* still needs the
  // per-origin grant below.
  //
  // `debugger` is required rather than optional because Chrome refuses to have
  // it any other way: listing it under `optional_permissions` is silently
  // dropped ("Permission 'debugger' cannot be listed as optional"), and asking
  // for it at runtime then throws. It is granted at install or not at all.
  //
  // The cost is real and unavoidable: it appears on the install prompt, and
  // Chrome shows a "being debugged" banner whenever a run is attached. What it
  // buys is the browser's own accessibility tree, genuinely trusted input, and
  // file attachment — the three things a content script cannot do, and the
  // source of every per-site failure this product has had. Using it is still a
  // setting; holding the permission is not.
  //
  // `contextMenus` is free at the prompt: it produces no warning line, and it is
  // how a browser extension is normally reached — a right-click on the thing you
  // are already looking at. (`commands` is a manifest key, not a permission.
  // Listing it here was why Chrome reported an unknown permission on load.)
  //
  // `activeTab` is gone. It grants temporary access to the tab the user
  // invoked the extension on, and nothing here ever relied on it: every path
  // that reads or scripts a page checks `permissions.contains` for that origin
  // first, which activeTab does not satisfy. A declared permission with no
  // caller is a question to answer at review with no good answer.
  permissions: ['sidePanel', 'storage', 'scripting', 'tabs', 'debugger', 'contextMenus'],
  // `downloads` is the one line on the install prompt that could be removed,
  // and it is now: "Manage your downloads" was shown to every user at install
  // for a tool most of them will never invoke. Chrome allows this one to be
  // optional -- unlike `debugger` -- so it is asked for in Settings, by someone
  // who wants it, at the moment they say so.
  //
  // In Settings rather than at the moment the agent first needs it, because
  // `permissions.request` requires a user gesture and a tool call is not one.
  // A switch is a gesture; a model deciding to save a file is not.
  optional_permissions: ['downloads'],
  host_permissions: [],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
});
