/**
 * Telling the user the run is waiting on them.
 *
 * A run that hits a confirmation stops dead until it is answered, and the panel
 * is a side panel: if the user has moved to another window, or another Chrome
 * profile, or away from the machine, there is nothing on screen to say so. Runs
 * were being found ten minutes later sitting on a question nobody knew about,
 * which reads as the agent having hung.
 *
 * A badge on the toolbar icon, not a system notification. The `notifications`
 * permission adds a line to the install prompt for something the toolbar can
 * already do, and M7's permission-minimisation pass is not a thing to spend a
 * permission against. The badge is visible in every window, survives the panel
 * being scrolled or covered, and costs nothing.
 *
 * Every call is best-effort. A badge that could not be set is not a reason to
 * interrupt what the user is actually doing.
 */

/** Amber: attention, not error. Chrome renders the text at about four glyphs. */
const COLOUR = '#d97706';

export type Waiting = 'confirm' | 'question';

export function attentionNeeded(kind: Waiting): void {
  try {
    void chrome.action.setBadgeText({ text: kind === 'confirm' ? 'OK?' : '?' });
    void chrome.action.setBadgeBackgroundColor({ color: COLOUR });
    void chrome.action.setTitle({
      title:
        kind === 'confirm'
          ? 'heapbrowse is waiting for you to approve an action'
          : 'heapbrowse has a question for you',
    });
  } catch {
    // `chrome.action` is unavailable in some contexts (a test renderer, chiefly).
  }
}

export function attentionCleared(): void {
  try {
    void chrome.action.setBadgeText({ text: '' });
    void chrome.action.setTitle({ title: 'Open heapbrowse' });
  } catch {
    // As above.
  }
}
