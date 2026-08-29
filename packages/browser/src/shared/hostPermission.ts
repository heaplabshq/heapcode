/**
 * Permission to talk to the endpoint the user configured.
 *
 * BYOK means the endpoint is not knowable at build time, so it cannot be a
 * static `host_permissions` entry. The alternative — declaring a whole-web
 * wildcard up front — asks every user for access to all of it before they have
 * typed anything, which is both a worse install prompt and exactly the kind of
 * broad grant PRD §7.6 says to avoid because of Chrome Web Store review.
 *
 * So the manifest declares these as *optional* and the panel requests the one
 * origin the user actually configured, at the moment they configure it. The
 * grant is per-origin and revocable from Chrome's own UI.
 *
 * This is not belt-and-braces: without the grant, a cross-origin request from
 * the panel is subject to CORS, and most provider endpoints do not send
 * `Access-Control-Allow-Origin` for an extension origin. `ollama.com` sends no
 * CORS headers at all, so Ollama Cloud simply cannot work without this.
 * (OpenAI does send them, which is why it is the one that would have appeared
 * to work and hidden the problem.)
 */

/**
 * The match pattern covering `baseUrl` — scheme, host, port, all paths.
 *
 * Chrome match patterns have no notion of a path prefix that would let us ask
 * for less than the whole origin, so the origin is the minimum grantable unit.
 */
export function originPatternFor(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return undefined;
  }
}

export async function hasHostPermission(baseUrl: string): Promise<boolean> {
  const origins = originPatternFor(baseUrl);
  if (!origins) return false;
  return chrome.permissions.contains({ origins: [origins] });
}

/**
 * Ask for the grant. Must be called from a user gesture — Chrome silently
 * refuses otherwise, which is why this is wired to the Save and Test buttons
 * rather than to a settings-panel effect.
 */
export async function requestHostPermission(baseUrl: string): Promise<boolean> {
  const origins = originPatternFor(baseUrl);
  if (!origins) return false;
  return chrome.permissions.request({ origins: [origins] });
}
