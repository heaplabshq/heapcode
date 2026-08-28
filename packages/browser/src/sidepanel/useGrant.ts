import { useCallback, useRef, useState } from 'react';
import type { GrantNeeded } from './page.js';
import { attentionCleared, attentionNeeded } from './attention.js';

/**
 * A site permission the run waits on.
 *
 * The same shape as `useConfirm`, and for the same reason: the agent loop is an
 * async call in this document, so a promise that resolves when the user answers
 * is all the blocking there is to do. It matters more here than it looks. The
 * first version told the panel and let the run carry on, which meant the agent
 * spent its remaining steps explaining it was stuck while the answer sat unread
 * on screen -- and by the time anyone pressed Allow the run had finished and
 * written a conclusion around the page it never read.
 *
 * Answering resolves the step that was blocked, which then retries with the
 * permission it needed.
 */
export function useGrant() {
  const [pending, setPending] = useState<GrantNeeded>();
  const resolver = useRef<((allowed: boolean) => void) | undefined>(undefined);

  const request = useCallback((needed: GrantNeeded): Promise<boolean> => {
    setPending(needed);
    // The run is stopped until someone answers. Say so on the toolbar, so it is
    // visible from another window rather than only in this panel.
    attentionNeeded('confirm');
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = useCallback((allowed: boolean) => {
    setPending(undefined);
    attentionCleared();
    resolver.current?.(allowed);
    resolver.current = undefined;
  }, []);

  /** Abandon an ask whose run has gone away, so nothing is left hanging. */
  const cancel = useCallback(() => {
    if (!resolver.current) return;
    setPending(undefined);
    attentionCleared();
    resolver.current(false);
    resolver.current = undefined;
  }, []);

  return { pending, request, answer, cancel };
}
