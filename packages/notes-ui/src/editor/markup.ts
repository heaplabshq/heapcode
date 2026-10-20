import { Tag, tags as t } from '@lezer/highlight';
import type { InlineContext, MarkdownConfig } from '@lezer/markdown';
import { findTags } from '@heapcode/notes-host/parse';

/**
 * Bear's additions to CommonMark, as Lezer Markdown
 * extensions so the editor's syntax tree has them: `==highlight==`,
 * `~underline~`, `#tags` (all three forms) and `[[wiki links]]`.
 *
 * The tag rule is notes-host's own `findTags` — the editor and the index must
 * never disagree about what is a tag.
 */
export const markupTags = {
  highlight: Tag.define(),
  underline: Tag.define(),
  tag: Tag.define(),
  wikiLink: Tag.define(),
  mark: Tag.define(t.processingInstruction),
};

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
const UnderlineDelim = { resolve: 'Underline', mark: 'UnderlineMark' };

const EQ = 61;
const TILDE = 126;
const HASH = 35;
const BRACKET = 91;
const BANG = 33;

function space(s: string): boolean {
  return s === '' || /\s/.test(s);
}

export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: markupTags.highlight },
    { name: 'HighlightMark', style: markupTags.mark },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== EQ || cx.char(pos + 1) !== EQ || cx.char(pos + 2) === EQ) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !space(after), !space(before));
      },
      after: 'Emphasis',
    },
  ],
};

/** A single `~`. `~~strike~~` stays GFM's: a tilde next to a tilde is never this. */
export const Underline: MarkdownConfig = {
  defineNodes: [
    { name: 'Underline', style: markupTags.underline },
    { name: 'UnderlineMark', style: markupTags.mark },
  ],
  parseInline: [
    {
      name: 'Underline',
      parse(cx, next, pos) {
        if (next !== TILDE || cx.char(pos + 1) === TILDE || cx.char(pos - 1) === TILDE) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 1, pos + 2);
        return cx.addDelimiter(UnderlineDelim, pos, pos + 1, !space(after), !space(before));
      },
      after: 'Emphasis',
    },
  ],
};

export const Hashtag: MarkdownConfig = {
  defineNodes: [{ name: 'Hashtag', style: markupTags.tag }],
  parseInline: [
    {
      name: 'Hashtag',
      parse(cx: InlineContext, next, pos) {
        if (next !== HASH) return -1;
        const prev = pos > cx.offset ? cx.slice(pos - 1, pos) : ' ';
        if (!space(prev)) return -1;
        const rest = cx.slice(pos, cx.end);
        const line = rest.split('\n', 1)[0]!;
        const tag = findTags(` ${line}`).find((f) => f.start === 1);
        if (!tag) return -1;
        return cx.addElement(cx.elt('Hashtag', pos, pos + tag.end - 1));
      },
      before: 'Emphasis',
    },
  ],
};

export const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: markupTags.wikiLink },
    { name: 'WikiLinkMark', style: markupTags.mark },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      parse(cx, next, pos) {
        const embed = next === BANG && cx.char(pos + 1) === BRACKET && cx.char(pos + 2) === BRACKET;
        if (!embed && !(next === BRACKET && cx.char(pos + 1) === BRACKET)) return -1;
        const open = embed ? pos + 1 : pos;
        const rest = cx.slice(open + 2, cx.end);
        const m = /^[^[\]\n]+?\]\]/.exec(rest);
        if (!m) return -1;
        const end = open + 2 + m[0].length;
        return cx.addElement(
          cx.elt('WikiLink', pos, end, [
            cx.elt('WikiLinkMark', pos, open + 2),
            cx.elt('WikiLinkMark', end - 2, end),
          ]),
        );
      },
      before: 'Link',
    },
  ],
};

/** Bear turns these off; so does Heapnotes, so `Title\n===` is a paragraph and indenting is never code. */
export const BearBlocks: MarkdownConfig = { remove: ['SetextHeading', 'IndentedCode'] };

export const heapnotesMarkdown: MarkdownConfig[] = [
  WikiLink,
  Hashtag,
  Highlight,
  Underline,
  BearBlocks,
];

/** The `[[target]]` a WikiLink node's text names: before any `#heading` or `|alias`. */
export function wikiTarget(text: string): string {
  const inner = text
    .replace(/^!?\[\[/, '')
    .replace(/\]\]$/, '')
    .replace(/\\\|/g, '|');
  return inner.split('|')[0]!.split('#')[0]!.trim();
}
