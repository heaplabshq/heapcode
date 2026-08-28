import type { Turn } from '../sidepanel/useChat.js';

/**
 * What survives the panel being closed.
 *
 * The panel is an ordinary document, and closing it destroys the run with it —
 * that is the cost of keeping the agent loop out of the service worker, which
 * Chrome would otherwise kill mid-run (PRD section 7.1). Nothing here changes
 * that: an in-flight model call cannot be resumed, and pretending otherwise
 * would be worse than losing it.
 *
 * What it does change is that the *work* is no longer lost. Reopening the panel
 * used to show an empty conversation, so a run that had read six pages and
 * asked two questions had to start from nothing — including its answers to
 * those questions. Now the transcript comes back, and a run that was still
 * going when the panel closed says so rather than looking as though it finished.
 *
 * `chrome.storage.session` rather than `local`: this is a conversation, not a
 * setting. It should survive a panel reload and an accidental close, and it
 * should be gone when Chrome is, without the user having to clear anything.
 */

const KEY = 'heapbrowse.session';

/** Roughly the storage.session quota, kept well clear of it. */
const MAX_BYTES = 4_000_000;

export interface StoredSession {
  turns: Turn[];
  tokens: number;
  /** When it was written, so a stale conversation can be recognised as one. */
  at: number;
}

/**
 * Strip what must not be stored, then what is merely too big.
 *
 * Screenshots are the reason. A `view` step holds a few hundred kilobytes of
 * data URL, a run produces several, and writing those to session storage would
 * blow the quota inside one task — silently, because a failed write is not an
 * error the user would ever see. They are also the least worth keeping: a
 * picture of a page from ten minutes ago tells the user nothing they cannot get
 * by looking at the tab.
 */
function shrink(turns: Turn[]): Turn[] {
  const stripped = turns.map((turn) => ({
    ...turn,
    // A run that was still going when the panel closed did not finish; it was
    // interrupted, and the transcript should say so rather than showing a
    // spinner that will never stop.
    streaming: false,
    error: turn.streaming ? (turn.error ?? 'Interrupted — the panel was closed while this was running.') : turn.error,
    // Views go; datasets stay. A screenshot is hundreds of kilobytes of data
    // URL and tells a returning user nothing they cannot get by looking at the
    // tab. The rows are the work, and losing them on a panel close is exactly
    // what this is for.
    steps: turn.steps
      ?.filter((step) => step.kind !== 'view')
      // A block still marked live would come back with a "Thinking…" header on
      // a run that stopped when the panel closed.
      .map((step) => (step.kind === 'thinking' ? { ...step, streaming: false } : step)),
  }));

  // Oldest turns go first if it is still too large. The recent ones are what a
  // returning user is looking at, and a truncated history is better than none.
  let kept = stripped;
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_BYTES) {
    kept = kept.slice(2);
  }
  return kept;
}

export async function saveSession(turns: Turn[], tokens: number): Promise<void> {
  try {
    if (turns.length === 0) {
      await chrome.storage.session.remove(KEY);
      return;
    }
    const payload: StoredSession = { turns: shrink(turns), tokens, at: Date.now() };
    await chrome.storage.session.set({ [KEY]: payload });
  } catch {
    // A conversation that could not be checkpointed is not a reason to
    // interrupt the one the user is having.
  }
}

export async function loadSession(): Promise<StoredSession | undefined> {
  try {
    const stored = await chrome.storage.session.get(KEY);
    const session = stored[KEY] as StoredSession | undefined;
    if (!session || !Array.isArray(session.turns) || session.turns.length === 0) return undefined;
    return session;
  } catch {
    return undefined;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await chrome.storage.session.remove(KEY);
  } catch {
    // Nothing to do; the next write replaces it anyway.
  }
}
