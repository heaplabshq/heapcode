import { useCallback, useRef, useState } from 'react';
import { attentionCleared, attentionNeeded } from './attention.js';

/** What the agent has asked the user to do, in the agent's own words. */
export interface HandOver {
  what: string;
}

/**
 * The user's turn at their own keyboard.
 *
 * The same blocking shape as a confirmation, and a different question. A
 * confirmation asks "may I", and its safe answer is no. This says "I cannot do
 * this part — you can", and there is no answer at all until the person has
 * actually gone and done it.
 *
 * Which is why there is no timeout and no default. A run that is waiting on a
 * login has nothing useful to do, and guessing that the user is finished would
 * send the agent off to read a page still sitting behind the wall.
 */
export function useHandOver() {
  const [pending, setPending] = useState<HandOver>();
  const resolver = useRef<((done: boolean) => void) | undefined>(undefined);

  const request = useCallback((next: HandOver): Promise<boolean> => {
    setPending(next);
    // Visible from another window: this stops the run completely, and a wall
    // nobody is looking at is a run that appears to have hung.
    attentionNeeded('question');
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = useCallback((done: boolean) => {
    setPending(undefined);
    attentionCleared();
    resolver.current?.(done);
    resolver.current = undefined;
  }, []);

  /** Abandon a hand-over whose run has gone away, so nothing is left hanging. */
  const cancel = useCallback(() => {
    if (!resolver.current) return;
    setPending(undefined);
    attentionCleared();
    resolver.current(false);
    resolver.current = undefined;
  }, []);

  return { pending, request, answer, cancel };
}
