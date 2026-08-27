import { useCallback, useRef, useState } from 'react';
import type { ConfirmAnswer, ConfirmRequest } from '../agent/run.js';

/**
 * A confirmation the run waits on.
 *
 * The agent loop is an async call in this same document, so a promise that
 * resolves when the user clicks is all the blocking that is needed -- there is
 * no timeout and no default answer. An unanswered question stops the run, which
 * is the correct outcome: nothing should happen to the page because the user
 * walked away.
 */
export function useConfirm() {
  const [pending, setPending] = useState<ConfirmRequest>();
  const resolver = useRef<((answer: ConfirmAnswer) => void) | undefined>(undefined);

  const request = useCallback((next: ConfirmRequest): Promise<ConfirmAnswer> => {
    setPending(next);
    return new Promise<ConfirmAnswer>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = useCallback((value: ConfirmAnswer) => {
    setPending(undefined);
    resolver.current?.(value);
    resolver.current = undefined;
  }, []);

  /** Abandon a question whose run has gone away, so nothing is left hanging. */
  const cancel = useCallback(() => {
    if (!resolver.current) return;
    setPending(undefined);
    resolver.current('deny');
    resolver.current = undefined;
  }, []);

  return { pending, request, answer, cancel };
}
