import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { markupTags } from './markup.js';

/**
 * The editor in Heap Code's own colours: every value is one of the shell's
 * CSS variables (web-ui styles.css), so light, dark and the theme switch all
 * follow without a second palette.
 */
const base = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--note-font-size, 16px)',
    color: 'var(--text)',
    background: 'var(--bg)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--sans)', lineHeight: '1.65', padding: '28px 0 40vh' },
  '.cm-content': {
    maxWidth: 'var(--note-width, 720px)',
    margin: '0 auto',
    padding: '0 32px',
    caretColor: 'var(--accent)',
    // Lets a wide code block or table scroll inside the page, not widen it.
    minWidth: '0',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    background: 'color-mix(in srgb, var(--accent) 22%, transparent) !important',
  },
  '.cm-h': { fontWeight: '700', lineHeight: '1.3', position: 'relative' },
  // `###` as a small label in the margin, as Bear does; takes no room in the line.
  '.cm-hlabel': {
    position: 'absolute',
    right: '100%',
    marginRight: '8px',
    bottom: '0.3em',
    fontSize: '11px',
    fontWeight: '600',
    lineHeight: '1',
    color: 'var(--text-dim)',
    opacity: '0.7',
    fontFamily: 'var(--sans)',
    whiteSpace: 'nowrap',
  },
  '.cm-h1': { fontSize: '1.75em', paddingTop: '0.4em' },
  '.cm-h2': { fontSize: '1.4em', paddingTop: '0.5em' },
  '.cm-h3': { fontSize: '1.2em', paddingTop: '0.4em' },
  '.cm-h4, .cm-h5, .cm-h6': { fontSize: '1.05em', paddingTop: '0.3em' },
  '.cm-quote': {
    borderLeft: '3px solid var(--border-strong)',
    paddingLeft: '14px !important',
    color: 'var(--text-dim)',
  },
  '.cm-codeblock': {
    fontFamily: 'var(--mono)',
    fontSize: '0.88em',
    background: 'var(--code-bg)',
    padding: '0 12px !important',
  },
  '.cm-tag': {
    color: 'var(--accent)',
    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    borderRadius: '4px',
    padding: '0 3px',
    cursor: 'pointer',
  },
  '.cm-wikilink, .cm-link': {
    color: 'var(--accent)',
    cursor: 'pointer',
    textDecoration: 'underline',
    textDecorationColor: 'color-mix(in srgb, var(--accent) 40%, transparent)',
    textUnderlineOffset: '3px',
  },
  '.cm-task': {
    display: 'inline-block',
    width: '1em',
    height: '1em',
    verticalAlign: '-0.15em',
    marginRight: '0.4em',
    border: '1.5px solid var(--border-strong)',
    borderRadius: '4px',
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  '.cm-task-on': {
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m4 8.5 2.5 2.5L12 5.5' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
  },
  '.cm-task-done': {
    color: 'var(--text-dim)',
    textDecoration: 'line-through',
    textDecorationColor: 'var(--border-strong)',
  },
  '.cm-bullet': { color: 'var(--text-dim)', padding: '0 0.2em' },
  '.cm-rule': {
    display: 'inline-block',
    width: '100%',
    height: '1px',
    background: 'var(--border-strong)',
    verticalAlign: 'middle',
  },
  // Rendered blocks (blocks.ts): code without fences, tables as tables.
  '.cm-code': {
    margin: '4px 0',
    borderRadius: '6px',
    background: 'var(--code-bg)',
    cursor: 'text',
  },
  '.cm-code pre': {
    margin: '0',
    padding: '10px 14px',
    fontFamily: 'var(--mono)',
    fontSize: '0.88em',
    lineHeight: '1.5',
    whiteSpace: 'pre',
    overflowX: 'auto',
    tabSize: '4',
  },
  '.cm-code-head': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px 0 14px',
    minHeight: '22px',
    fontSize: '11px',
    lineHeight: '1.2',
    fontFamily: 'var(--sans)',
    color: 'var(--text-dim)',
  },
  '.cm-code-head + pre': { paddingTop: '2px' },
  '.cm-code-copy': {
    font: 'inherit',
    color: 'inherit',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: '5px',
    padding: '2px 7px',
    cursor: 'pointer',
    opacity: '0',
    transition: 'opacity 0.12s',
  },
  '.cm-code:hover .cm-code-copy, .cm-code-copy:focus-visible': { opacity: '1' },
  '.cm-code-copy:hover': { borderColor: 'var(--border)', color: 'var(--text)' },
  // Over the text, not under it: a code line's background hid the selection.
  '.cm-selectionLayer': { zIndex: '1 !important' },
  '.cm-tablesrc': { fontFamily: 'var(--mono)', fontSize: '0.88em' },
  '.cm-table': { margin: '6px 0', overflowX: 'auto', cursor: 'text' },
  '.cm-table table': { borderCollapse: 'collapse', fontSize: '0.94em', lineHeight: '1.45' },
  '.cm-table th, .cm-table td': {
    border: '1px solid var(--border)',
    padding: '5px 10px',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  '.cm-table th': { fontWeight: '600', background: 'var(--bg-sunken)' },
  '.cm-table code': {
    fontFamily: 'var(--mono)',
    fontSize: '0.9em',
    background: 'var(--code-bg)',
    borderRadius: '3px',
    padding: '0 3px',
  },
  '.cm-tooltip.cm-ai-chip': { border: 'none', background: 'transparent' },
  '.cm-ai-chip button': {
    font: 'inherit',
    fontSize: '12px',
    padding: '3px 9px',
    borderRadius: '999px',
    border: '1px solid var(--border)',
    background: 'var(--bg-raised)',
    color: 'var(--text)',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgb(0 0 0 / 0.12)',
    whiteSpace: 'pre',
  },
  '.cm-ai-chip button:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' },
  '.cm-image': { padding: '8px 0' },
  '.cm-image img': { maxWidth: '100%', maxHeight: '480px', borderRadius: '6px', display: 'block' },
  '.cm-image-broken': { display: 'none' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--bg-raised)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.15)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--accent)',
    color: 'var(--accent-text)',
  },
  '.cm-panels': {
    background: 'var(--bg-sunken)',
    color: 'var(--text)',
    borderColor: 'var(--border)',
  },
  '.cm-searchMatch': { background: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
});

/** Markdown and the code inside it; also colours rendered code blocks (blocks.ts). */
export const noteHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: markupTags.underline, textDecoration: 'underline' },
  {
    tag: markupTags.highlight,
    background: 'color-mix(in srgb, #f5d000 45%, transparent)',
    borderRadius: '2px',
  },
  { tag: [t.processingInstruction, markupTags.mark], color: 'var(--text-dim)' },
  {
    tag: t.monospace,
    fontFamily: 'var(--mono)',
    fontSize: '0.9em',
    background: 'var(--code-bg)',
    borderRadius: '3px',
  },
  { tag: t.url, color: 'var(--text-dim)' },
  { tag: t.quote, color: 'var(--text-dim)' },
  // Code inside fenced blocks.
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: '#a626a4' },
  { tag: [t.string, t.special(t.string)], color: '#50a14f' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#c18401' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--text-dim)',
    fontStyle: 'italic',
  },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#4078f2' },
  { tag: [t.typeName, t.className], color: '#c18401' },
]);

export function heapnotesTheme(): Extension {
  return [base, syntaxHighlighting(noteHighlight)];
}
