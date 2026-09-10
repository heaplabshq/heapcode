import { describe, expect, it } from 'vitest';
import { extractorFor, normalizeExtractedText, type DocumentExtractor } from '../src/rag/extractors.js';

const pdf: DocumentExtractor = {
  name: 'pdf',
  handles: (rel) => rel.endsWith('.pdf'),
  extract: async () => 'pdf text',
};
const text: DocumentExtractor = {
  name: 'text',
  handles: (rel) => rel.endsWith('.txt'),
  extract: async () => 'plain text',
};

describe('extractorFor', () => {
  it('finds the extractor that claims a path', () => {
    expect(extractorFor([pdf, text], 'a.pdf')?.name).toBe('pdf');
    expect(extractorFor([pdf, text], 'a.txt')?.name).toBe('text');
  });

  it('answers nothing for a file nobody claims', () => {
    expect(extractorFor([pdf, text], 'index.ts')).toBeUndefined();
  });

  it('answers nothing when no extractors were registered', () => {
    // Every host except Heap Chat is in this case, and its indexing behaviour
    // must be exactly what it was before the seam existed.
    expect(extractorFor(undefined, 'a.pdf')).toBeUndefined();
    expect(extractorFor([], 'a.pdf')).toBeUndefined();
  });

  it('takes the first claim, so registration order is the tiebreak', () => {
    const greedy: DocumentExtractor = { name: 'greedy', handles: () => true, extract: async () => '' };
    expect(extractorFor([greedy, pdf], 'a.pdf')?.name).toBe('greedy');
  });
});

describe('normalizeExtractedText', () => {
  it('turns a page break into a paragraph break', () => {
    // PDF parsers separate pages with a form feed, which a line-window
    // chunker would otherwise spend a whole line on.
    expect(normalizeExtractedText('page one\fpage two')).toBe('page one\n\npage two');
  });

  it('collapses runs of blank lines left by a document layout', () => {
    expect(normalizeExtractedText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('normalises Windows and classic Mac line endings', () => {
    expect(normalizeExtractedText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('replaces non-breaking spaces, which otherwise break an exact search', () => {
    // A person types a normal space; a PDF carries U+00A0. Without this the
    // keyword half of hybrid search silently misses the line.
    expect(normalizeExtractedText('Total due')).toBe('Total due');
  });

  it('strips trailing whitespace and surrounding blank space', () => {
    expect(normalizeExtractedText('\n\n  line   \n\n')).toBe('line');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The deposit is 1,450.\n\nNotice is two months.';
    expect(normalizeExtractedText(prose)).toBe(prose);
  });
});
