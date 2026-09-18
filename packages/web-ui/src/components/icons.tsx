/**
 * The small stroke glyphs the message toolbars use.
 *
 * One `S` rather than three, because they sit next to each other under a
 * message and a stroke width that disagrees by a tenth is visible when they
 * do. The same set the panel's tabs are drawn in (Panel.tsx); the VS Code
 * webview keeps its own filled icons, which match the editor's language rather
 * than this one's.
 */
export const S = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Two sheets, one behind the other. */
export const ICON_COPY = (
  <svg {...S} aria-hidden>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const ICON_DONE = (
  <svg {...S} aria-hidden>
    <path d="m5 13 4 4L19 7" />
  </svg>
);

/** A struck-through sheet: it did not go anywhere. */
export const ICON_COPY_FAILED = (
  <svg {...S} aria-hidden>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    <path d="m11 19 8-8" />
  </svg>
);

/** A pencil over a line: change what was written. */
export const ICON_EDIT = (
  <svg {...S} aria-hidden>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

/** An arrow curving back on itself: put the files back as they were. */
export const ICON_RESTORE = (
  <svg {...S} aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
