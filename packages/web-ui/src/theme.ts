/**
 * Light, dark, or whatever the system says — for every product on the page.
 *
 * Kept in the browser rather than the config file: it is how this screen
 * looks, not how the tool behaves, and Code, Chat, QA and Notes share one
 * origin under `heapcode web`, so one choice covers all of them. styles.css
 * already honours `[data-theme]` over `prefers-color-scheme`; nothing set it.
 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'heap.theme';

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* Storage refused (private window): still applies for this page. */
  }
  applyTheme(pref);
}

/** Call before the first render, so a dark choice never flashes light. */
export function applyTheme(pref: ThemePref = themePref()): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}
