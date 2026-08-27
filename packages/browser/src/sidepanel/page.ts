import { wrapUntrusted } from '@heapcode/core/agent';
import { formatSnapshot, type PageSnapshot } from '../shared/snapshot.js';
import { originPatternFor } from '../shared/hostPermission.js';
import type { ContentRequest, ContentResponse } from '../content/index.js';

/**
 * Reaching the page the user is looking at.
 *
 * Three things have to line up: permission for that origin, the content script
 * being present in that tab, and the tab being one a content script can run in
 * at all. Each fails differently and each has a different fix, so they are
 * reported apart rather than as one "couldn't read the page".
 */

export type PageFailure = { ok: false; reason: string };

/** Pages Chrome will not let any extension script, whatever it has been granted. */
function unscriptable(url: string): string | undefined {
  if (/^(chrome|edge|about|devtools|view-source):/i.test(url)) {
    return 'Chrome does not allow extensions to read its own pages. Open an ordinary web page and try again.';
  }
  if (
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://chrome.google.com/webstore')
  ) {
    return 'Chrome blocks extensions on the Web Store. Open an ordinary web page and try again.';
  }
  return undefined;
}

/**
 * The tab this panel is looking at.
 *
 * `currentWindow`, not `lastFocusedWindow`: a side panel belongs to one browser
 * window, and with several windows open `lastFocusedWindow` can resolve to a
 * different one than the panel is docked in.
 */
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export type PageTarget = { ok: true; tabId: number; url: string } | PageFailure;

/**
 * Resolve the active tab and make sure our content script is in it.
 *
 * Injecting into an already-injected tab is safe -- the script guards against
 * registering twice -- and is cheaper than tracking which tabs are live across
 * navigations, which the script cannot survive anyway.
 */
export async function ensurePage(): Promise<PageTarget> {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, reason: 'No active tab to read.' };

  // A tab with no URL is not an absent tab -- it is one Chrome will not describe
  // to us. Saying "no active tab" here sent the user looking for the wrong
  // problem entirely.
  if (!tab.url) {
    return {
      ok: false,
      reason:
        'Chrome is not letting heapbrowse see this tab address. Reload the page, or click the heapbrowse toolbar icon on this tab, then try again.',
    };
  }

  const blocked = unscriptable(tab.url);
  if (blocked) return { ok: false, reason: blocked };

  const pattern = originPatternFor(tab.url);
  if (!pattern) return { ok: false, reason: `Cannot read ${tab.url} -- only http and https pages.` };

  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return {
      ok: false,
      reason: `heapbrowse has not been granted access to ${new URL(tab.url).host}. Use "Allow this site" to grant it.`,
    };
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (error) {
    return {
      ok: false,
      reason: `Could not inject into the page: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, tabId: tab.id, url: tab.url };
}

/** One request to the content script, with a disconnect reported as what it means. */
export async function sendToPage(tabId: number, request: ContentRequest): Promise<ContentResponse> {
  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch {
    // The usual cause is the document being replaced mid-call, which takes the
    // listener with it (PRD section 7.5).
    return { ok: false, error: 'The page did not respond. It may have navigated while being read.' };
  }
}

/** Take a snapshot of the active page, or say why not. */
export async function snapshotActivePage(): Promise<{ ok: true; snapshot: PageSnapshot } | PageFailure> {
  const target = await ensurePage();
  if (!target.ok) return target;

  const response = await sendToPage(target.tabId, { type: 'snapshot' });
  if (!response.ok) return { ok: false, reason: response.error };
  if (response.kind !== 'snapshot') return { ok: false, reason: 'Unexpected reply from the page.' };
  return { ok: true, snapshot: response.snapshot };
}

export type PageResult = { ok: true; snapshot: PageSnapshot; text: string } | PageFailure;

/**
 * Snapshot the active tab, budgeted and wrapped as untrusted data.
 *
 * `intent` is the user's own message. It ranks the controls, which is what
 * keeps the thing they are pointing at from being truncated away on a page with
 * hundreds of them.
 */
export async function readActivePage(intent?: string, budgetChars?: number): Promise<PageResult> {
  const result = await snapshotActivePage();
  if (!result.ok) return result;

  const rendered = formatSnapshot(result.snapshot, { intent, budgetChars });
  // Guardrail 4: every snapshot reaches the model as data, never as
  // instructions. The page is hostile by default -- it is arbitrary text arriving
  // while the agent holds the user's logged-in session (PRD section 6.1).
  return { ok: true, snapshot: result.snapshot, text: wrapUntrusted(rendered) };
}

/** Ask for access to the active tab origin. Must run inside a user gesture. */
export async function grantActiveSite(): Promise<boolean> {
  const tab = await activeTab();
  if (!tab?.url) return false;
  const pattern = originPatternFor(tab.url);
  if (!pattern) return false;
  return chrome.permissions.request({ origins: [pattern] });
}

export interface ActiveSite {
  host: string;
  /** Whether page content may be read, as opposed to merely knowing the host. */
  granted: boolean;
}

/**
 * Which site the panel is pointed at and whether it may be read.
 *
 * One helper rather than a query in each caller: the tab lookup has two easy
 * ways to be subtly wrong (the wrong window, and a URL Chrome declines to
 * report), and both were live in two places at once.
 */
export async function activeSite(): Promise<ActiveSite | undefined> {
  const tab = await activeTab();
  if (!tab?.url) return undefined;

  let host: string;
  try {
    host = new URL(tab.url).host;
  } catch {
    return undefined;
  }
  if (!host) return undefined;

  const pattern = originPatternFor(tab.url);
  const granted = pattern ? await chrome.permissions.contains({ origins: [pattern] }) : false;
  return { host, granted };
}
