/** The note list's width: its floor, its ceiling, and where a double-click puts it. */
export const LIST_MIN = 200;
export const LIST_MAX = 560;
export const LIST_DEFAULT = 300;

/** The editor's floor — the list may not grow into it. */
const EDITOR_MIN = 340;

/**
 * A dragged width, held between the list's floor and whichever is nearer: its
 * ceiling, or the room left once the editor has its floor. A window too narrow
 * for both gives the list its floor and lets the editor shrink.
 */
export function clampListWidth(width: number, mainWidth: number): number {
  const room = mainWidth - EDITOR_MIN;
  const ceiling = Math.min(LIST_MAX, Math.max(LIST_MIN, room));
  return Math.round(Math.min(ceiling, Math.max(LIST_MIN, width)));
}
