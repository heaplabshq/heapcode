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
export default defineManifest({
  manifest_version: 3,
  name: 'heapbrowse',
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: '116', // chrome.sidePanel landed in 114; 116 for sidePanel.setOptions
  action: { default_title: 'Open heapbrowse' },
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
  permissions: ['sidePanel', 'storage', 'activeTab', 'scripting', 'tabs', 'debugger'],
  host_permissions: [],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
});
