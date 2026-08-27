import { useCallback, useRef, useState } from 'react';

/**
 * A question from the agent that the run waits on.
 *
 * Same shape as the permission confirmation, and for the same reason: the loop
 * is an async call in this document, so a promise resolved by a click is all the
 * blocking needed. Kept separate from the confirmation because the two mean
 * different things -- one asks for consent to act, the other asks for a fact --
 * and collapsing them would let a "which address?" answer look like approval.
 */
export interface AgentQuestion {
  question: string;
  options?: string[];
  /** The model says this gates an action, so it must never resolve on its own. */
  blocksAction: boolean;
}

export function useAsk() {
  const [pending, setPending] = useState<AgentQuestion>();
  const resolver = useRef<((answer: string | undefined) => void) | undefined>(undefined);

  const ask = useCallback((question: AgentQuestion): Promise<string | undefined> => {
    setPending(question);
    return new Promise<string | undefined>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = useCallback((value: string | undefined) => {
    setPending(undefined);
    resolver.current?.(value);
    resolver.current = undefined;
  }, []);

  const cancel = useCallback(() => {
    if (!resolver.current) return;
    setPending(undefined);
    resolver.current(undefined);
    resolver.current = undefined;
  }, []);

  return { pending, ask, answer, cancel };
}
