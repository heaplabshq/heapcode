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

/** A page with a folded corner: a document attached to a message. */
export const ICON_FILE = (
  <svg {...S} className="file-chip-icon" aria-hidden>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

/** An arrow curving back on itself: put the files back as they were. */
export const ICON_RESTORE = (
  <svg {...S} aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

/** A globe: somewhere on the web — the Browser view, in all three products. */
export const ICON_BROWSER = (
  // 15, the panel-tab size, rather than the message-toolbar 14.
  <svg {...S} width={15} height={15}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
  </svg>
);

/** A disclosure arrow, pointing right when closed. Rotated by CSS when open. */
export const ICON_CHEVRON = (
  <svg {...S} width={12} height={12} strokeWidth={2} aria-hidden>
    <path d="m9 5 7 7-7 7" />
  </svg>
);

/** A window with an arrow out of it: open in a separate window. */
export const ICON_POP_OUT = (
  <svg {...S} width={15} height={15}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8 8" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </svg>
);
