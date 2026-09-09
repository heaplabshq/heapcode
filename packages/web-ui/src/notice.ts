import { useCallback, useEffect, useState } from 'react';

/**
 * How long a notice stays before it clears itself.
 *
 * Long enough to read a sentence twice, short enough that it is gone by the
 * time you have finished reading the reply underneath it.
 */
export const NOTICE_MS = 6_000;

/**
 * The one-line confirmation strip above the transcript, which clears itself.
 *
 * Every notice this app raises says something just *happened* — "Stopped.",
 * "Index rebuilt.", "Saved to …", "Now working in pin-folder." — and none of
 * them describes a standing condition. They used to sit there until clicked,
 * so switching folder left a sentence about an action you had finished
 * minutes ago pinned above the conversation, stacked under whatever else had
 * collected up there.
 *
 * The timer lives with the state rather than in a caller's effect so the two
 * cannot drift apart, and so this is testable without standing up the whole
 * app.
 *
 * `seq` is what makes raising the SAME text twice restart the clock. Keying
 * the effect on the string alone meant a repeated notice — "Rebuilding the
 * index…" twice, say — did not re-run it, and the second one inherited
 * whatever was left of the first one's six seconds.
 *
 * The LAN warning is deliberately NOT one of these: it describes what this
 * page is, not something that happened, and a security notice you can wait out
 * is one you can miss.
 */
export function useTransientNotice(ms: number = NOTICE_MS): [string | undefined, (text?: string) => void] {
  const [notice, setNotice] = useState<{ text?: string; seq: number }>({ seq: 0 });

  useEffect(() => {
    if (notice.text === undefined) return;
    const timer = setTimeout(() => setNotice((n) => ({ seq: n.seq })), ms);
    return () => clearTimeout(timer);
  }, [notice, ms]);

  // Same shape as the `useState` setter it replaces, so every existing
  // `setNotice('…')` and `setNotice(undefined)` call site is unchanged.
  const show = useCallback((text?: string) => setNotice((n) => ({ text, seq: n.seq + 1 })), []);

  return [notice.text, show];
}
