import { useCallback, useEffect, useState } from 'react';
import type React from 'react';

/**
 * The side panel's width, dragged to size and remembered.
 *
 * Shared rather than copied because the two products are one shell with a
 * switcher between them: a panel that resizes in Heap Code and not in Heap
 * Chat reads as the chat side being unfinished, which is exactly the seam the
 * shared `Sidebar`, `Composer` and stylesheet exist to remove. What the panel
 * *contains* differs — diffs and checkpoints on one side, documents and
 * sources on the other — but how it is sized does not.
 *
 * Each product keeps its own remembered width under its own `storageKey`. How
 * wide a diff wants to be is not how wide a document wants to be, and the
 * panels are rarely open at the same moment anyway.
 */

/** Never narrower than this, or the panel cannot show what it is for. */
const MIN_WIDTH = 320;
/** Never wider than this, and never leaving the transcript less than this. */
const MAX_WIDTH = 900;
const MIN_TRANSCRIPT = 480;

/** The widest the panel may be right now, given the window. */
function ceiling(): number {
  return Math.min(MAX_WIDTH, window.innerWidth - MIN_TRANSCRIPT);
}

export interface PanelWidth {
  /** Undefined until dragged — the stylesheet's own width then applies. */
  width: number | undefined;
  /** Hand to a splitter's `onPointerDown`. */
  startDrag: (e: React.PointerEvent<HTMLElement>) => void;
}

export function usePanelWidth(storageKey: string): PanelWidth {
  const [width, setWidth] = useState<number | undefined>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved > 0 ? saved : undefined;
  });

  useEffect(() => {
    if (width) localStorage.setItem(storageKey, String(width));
  }, [width, storageKey]);

  // Shrinking the window must not let a wide panel push the transcript below
  // its floor — re-clamp against the same ceiling the drag uses.
  useEffect(() => {
    if (!width) return;
    const onResize = (): void => {
      const max = ceiling();
      setWidth((w) => (w && w > max ? Math.max(max, MIN_WIDTH) : w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [width]);

  /**
   * Drag the panel's left edge. Pointer capture on the splitter keeps the drag
   * alive over an iframe — a preview or an artifact — which would otherwise
   * swallow the moves the moment the cursor crossed into it.
   */
  const startDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = e.currentTarget.parentElement?.querySelector('.panel')?.clientWidth ?? 0;
    // Kill text selection for the length of the drag — without this, sweeping
    // left over the transcript selects it.
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent): void => {
      setWidth(Math.round(Math.min(Math.max(startWidth + (startX - ev.clientX), MIN_WIDTH), ceiling())));
    };
    // pointerup and pointercancel both end the gesture; without the cancel
    // branch a lost pointer (tab switch, gesture stolen by the OS) would leave
    // the move listener attached for good.
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, []);

  return { width, startDrag };
}
