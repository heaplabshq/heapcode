// Signing the window back in to its own server.
//
// The page holds a cookie, never the token; only this process has the launch
// URL that trades one for the other. So when the server stops accepting the
// cookie, the way back is to load that URL again. Two ways in: the page asks
// (its socket could not reconnect and the server said "not signed in"), or the
// window lands on a refusal itself — ⌘R on a signed-out page, which runs no
// script that could ask.

/** At most one sign-in this often, so a URL that keeps failing cannot loop. */
const MIN_GAP_MS = 10_000;

/**
 * @param {{
 *   launchUrl: () => string | null,
 *   load: (url: string) => void,
 *   now?: () => number,
 *   minGapMs?: number,
 * }} deps
 */
function createSignIn({ launchUrl, load, now = () => Date.now(), minGapMs = MIN_GAP_MS }) {
  let last = -Infinity;

  /** Load the launch URL, unless one was loaded moments ago. True if it did. */
  function signIn() {
    const url = launchUrl();
    if (!url) return false;
    const t = now();
    if (t - last < minGapMs) return false;
    last = t;
    load(url);
    return true;
  }

  /**
   * For the window's 'did-navigate': a refusal from our own server is a lost
   * sign-in. 401 is "no valid cookie"; 429 is the same, after enough tries to
   * be blocked — the server still lets the launch token through.
   * @param {string} url  where the window landed
   * @param {number} status  the HTTP status it got
   */
  function onNavigate(url, status) {
    if (status !== 401 && status !== 429) return false;
    const launch = launchUrl();
    if (!launch) return false;
    let same = false;
    try { same = new URL(url).origin === new URL(launch).origin; } catch { return false; }
    return same ? signIn() : false;
  }

  return { signIn, onNavigate };
}

module.exports = { createSignIn, MIN_GAP_MS };
