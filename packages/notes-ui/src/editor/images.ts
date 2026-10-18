/**
 * An image's size, kept in the Markdown the way Obsidian keeps it: `|300`
 * at the end of the alt text — `![photo|300](photo.png)`, `![[photo.png|300]]`.
 * Apps that don't know it show the image at its own size, and the alt text
 * reads as before apart from the number.
 */

export interface ImageMarkup {
  /** Offsets in the line. */
  start: number;
  end: number;
  width?: number;
}

const MARKDOWN = /!\[((?:[^\]\\]|\\.)*)\]\(([^)]*)\)/g;
const WIKI = /!\[\[([^\]]+)\]\]/g;
const SIZE = /\|\s*(\d{1,4})(?:x\d{1,4})?\s*$/;

/** Every image in a line of text, left to right — the order the editor draws them. */
export function imagesInLine(text: string): ImageMarkup[] {
  const out: ImageMarkup[] = [];
  for (const re of [MARKDOWN, WIKI]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const width = widthOf(m[0]);
      out.push({ start: m.index, end: m.index + m[0].length, ...(width ? { width } : {}) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The width an image's markup asks for, if any. */
export function widthOf(markup: string): number | undefined {
  const inner = markup.startsWith('![[')
    ? markup.slice(3, -2)
    : (/^!\[((?:[^\]\\]|\\.)*)\]/.exec(markup)?.[1] ?? '');
  const m = SIZE.exec(inner);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 ? n : undefined;
}

/** The same image at `width` pixels wide, or at its natural size when undefined. */
export function withWidth(markup: string, width: number | undefined): string {
  const size = width ? `|${Math.round(width)}` : '';
  if (markup.startsWith('![[')) {
    const inner = markup.slice(3, -2).replace(SIZE, '');
    return `![[${inner}${size}]]`;
  }
  const m = /^!\[((?:[^\]\\]|\\.)*)\](\(.*\))$/s.exec(markup);
  if (!m) return markup;
  return `![${m[1]!.replace(SIZE, '')}${size}]${m[2]}`;
}
