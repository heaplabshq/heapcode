import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { clampListWidth, LIST_DEFAULT, LIST_MAX, LIST_MIN } from './layout.js';

/**
 * The note list's right edge. Dragging it resizes the list; the width is held
 * between the list's floor and the room the editor needs, so the open note
 * never loses its column. Double-click resets, arrow keys move it 16px.
 */
export function ListSplitter({
  width,
  getMainWidth,
  onResize,
}: {
  width: number;
  /**
   * The room the list and editor share, read when the drag happens — not at
   * render, where the pane has not been measured yet and a window resize
   * since would leave the ceiling stale.
   */
  getMainWidth(): number;
  onResize(width: number): void;
}): JSX.Element {
  const drag = useRef<{ x: number; width: number }>();

  const resize = (next: number) => onResize(clampListWidth(next, getMainWidth()));

  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
    document.body.classList.add('notes-resizing');
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) resize(d.width + (e.clientX - d.x));
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = undefined;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove('notes-resizing');
  };

  return (
    <div
      className="notes-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the note list"
      aria-valuenow={width}
      aria-valuemin={LIST_MIN}
      aria-valuemax={LIST_MAX}
      tabIndex={0}
      title="Drag to resize the note list — double-click to reset"
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => resize(LIST_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        resize(width + (e.key === 'ArrowLeft' ? -16 : 16));
      }}
    />
  );
}
