/**
 * The disclosure arrow, shared by the tag tree and the note list's subtag
 * headings. A drawn chevron rather than ▸/▾: at 10px the glyphs read as
 * punctuation, not as something you can click.
 */
export function IconChevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      className={open ? 'chevron chevron-open' : 'chevron'}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}
