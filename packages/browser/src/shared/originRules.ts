/**
 * Keep a self-hosted model server from refusing us for being an extension.
 *
 * Ollama answers only the origins in `OLLAMA_ORIGINS`, and every request this
 * extension sends that carries an Origin says `chrome-extension://<id>`, which
 * is on nobody's default list. A GET goes out without one once the host is
 * granted, so the model list loads and "Test connection" used to pass; a chat
 * is a POST, which always carries it, so the first message then failed with a
 * 403. The fix we used to hand out was an environment variable on the machine
 * running Ollama — something most people installing a browser extension will
 * never find, and on macOS `launchctl setenv` is forgotten at the next reboot,
 * so it quietly broke again for the ones who did.
 *
 * So the extension removes its own Origin header, on its own requests, to the
 * endpoints the user configured — a `declarativeNetRequest` rule per endpoint.
 * Page Assist does the same for the same reason; its docs record what goes
 * wrong when the rule is broader than that: rewriting the header for every
 * request to `localhost` broke unrelated sites that talk to local services
 * (Intel's driver assistant, Box Tools). Hence the two conditions every rule
 * here carries, and neither is optional:
 *
 * - `initiatorDomains: [our id]` — only requests this extension starts. A web
 *   page calling the same address keeps its Origin, so Ollama's protection
 *   against drive-by sites stays exactly as strong as it was.
 * - the endpoint's exact origin — scheme, host and port — not a host wildcard.
 *
 * `declarativeNetRequestWithHostAccess` rather than `declarativeNetRequest`:
 * it adds no line to the install prompt, and a rule only takes effect on a host
 * the user has already granted, which for an endpoint they always have.
 *
 * `OLLAMA_ORIGINS` stays in the error text as the fallback for anywhere this
 * cannot apply; the connection check sends a chat-shaped request, so it tells
 * the user when that is.
 */

import type { StoredProfile } from './settings.js';

/**
 * Where the profile list is stored. Owned here rather than in settings.ts so
 * the service worker can watch it without importing settings — and with it
 * core's provider presets — into a worker that is otherwise a thin router.
 */
export const PROFILES_STORAGE_KEY = 'heapbrowse.profiles';

/**
 * Our block of dynamic rule ids. Dynamic rules outlive the worker and the
 * browser, so each sync replaces this whole block rather than appending to it.
 */
const FIRST_RULE_ID = 1000;
const LAST_RULE_ID = 1999;

/** The origin (`scheme://host:port`) a base URL points at, if it is http(s). */
function originOf(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** One rule per distinct endpoint origin, scoped to this extension's own requests. */
export function buildOriginRules(baseUrls: readonly string[], extensionId: string): chrome.declarativeNetRequest.Rule[] {
  const origins = [...new Set(baseUrls.map(originOf).filter((o): o is string => Boolean(o)))];
  return origins.slice(0, LAST_RULE_ID - FIRST_RULE_ID + 1).map((origin, i) => ({
    id: FIRST_RULE_ID + i,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{ header: 'origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }],
    },
    condition: {
      // `|` anchors at the start and the trailing `/` ends the host, so
      // `http://10.0.0.5:11434` cannot also match `http://10.0.0.5:114340`.
      urlFilter: `|${origin}/`,
      initiatorDomains: [extensionId],
      resourceTypes: ['xmlhttprequest', 'other'] as chrome.declarativeNetRequest.ResourceType[],
    },
  }));
}

/**
 * Make the installed rules match the configured profiles.
 *
 * Idempotent and cheap, so it is called whenever there is any chance the
 * profiles changed, rather than tracking exactly when they did.
 */
export async function syncOriginRules(profiles: readonly StoredProfile[], extensionId: string = chrome.runtime.id): Promise<void> {
  const installed = await chrome.declarativeNetRequest.getDynamicRules();
  const ours = installed.map((r) => r.id).filter((id) => id >= FIRST_RULE_ID && id <= LAST_RULE_ID);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ours,
    addRules: buildOriginRules(
      profiles.map((p) => p.baseUrl),
      extensionId,
    ),
  });
}

/**
 * Wire the rules to storage, from the service worker.
 *
 * Synced once at every worker start — the cheap way to be right after an
 * install, an update, or a change made while the worker was asleep — and again
 * whenever the profile list is written, from whichever page wrote it.
 */
export function watchOriginRules(): void {
  const sync = (profiles: unknown) =>
    syncOriginRules(Array.isArray(profiles) ? (profiles as StoredProfile[]) : []).catch((error: unknown) => {
      console.error('heapbrowse: could not update endpoint header rules', error);
    });
  void chrome.storage.local.get(PROFILES_STORAGE_KEY).then((stored) => sync(stored[PROFILES_STORAGE_KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && PROFILES_STORAGE_KEY in changes) void sync(changes[PROFILES_STORAGE_KEY]!.newValue);
  });
}
