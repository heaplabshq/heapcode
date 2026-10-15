import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AgentEvent } from '@heapcode/core';
import { reduce, type Transcript } from './transcript.js';

/**
 * A transcript fed by a stream of agent events, applied in batches.
 *
 * A fast model sends hundreds of chunks a second. Applied one by one, each
 * re-rendered the page — and in a long conversation, with a long reply, that
 * kept the main thread busy enough that typing in the composer lagged by
 * seconds. Here events queue and are applied together, at most once per
 * frame (~16ms): the same transcript, a fraction of the renders.
 *
 * Every other change goes through the returned `setTranscript`, which applies
 * whatever is still queued first — so a run's end (settling it, adding its
 * notice) can never land before the last chunks of that run.
 */
export function useTranscript(
  initial: Transcript,
  /** The page's own item counter, when it also reduces events itself (a replay), so ids never collide. */
  sharedSeq?: MutableRefObject<number>,
): {
  transcript: Transcript;
  setTranscript: Dispatch<SetStateAction<Transcript>>;
  applyEvent(event: AgentEvent): void;
} {
  const [transcript, setRaw] = useState(initial);
  const queued = useRef<AgentEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const ownSeq = useRef(0);
  const seq = sharedSeq ?? ownSeq;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const events = queued.current;
    if (events.length === 0) return;
    queued.current = [];
    setRaw((t) => events.reduce((acc, event) => reduce(acc, event, seq.current++), t));
  }, []);

  const setTranscript = useCallback<Dispatch<SetStateAction<Transcript>>>(
    (next) => {
      flush();
      setRaw(next);
    },
    [flush],
  );

  const applyEvent = useCallback(
    (event: AgentEvent) => {
      queued.current.push(event);
      // A timer rather than requestAnimationFrame: rAF stops in a hidden tab,
      // and a run in the background must still be there when you come back.
      if (timer.current === undefined) timer.current = setTimeout(flush, FRAME_MS);
    },
    [flush],
  );

  useEffect(() => () => clearTimeout(timer.current), []);
  return { transcript, setTranscript, applyEvent };
}

const FRAME_MS = 16;
