import { describe, expect, it } from 'vitest';
import {
  chatExtractors,
  docxExtractor,
  imageMediaType,
  isImage,
  pdfExtractor,
  textExtractor,
} from '../src/extractors.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('which files each extractor claims', () => {
  it('claims the plain-text types the code index does not', () => {
    for (const path of ['a.txt', 'exports.csv', 'data.tsv', 'server.log', 'subs.srt']) {
      expect(textExtractor.handles(path), path).toBe(true);
    }
  });

  it('leaves source files to the code index', () => {
    for (const path of ['index.ts', 'README.md', 'config.json']) {
      expect(chatExtractors.some((e) => e.handles(path)), path).toBe(false);
    }
  });

  it('does not claim .doc, which mammoth cannot read', () => {
    // Claiming the extension would index the old binary format as garbage,
    // which is worse than not indexing it: garbage is searchable.
    expect(docxExtractor.handles('letter.doc')).toBe(false);
    expect(docxExtractor.handles('letter.docx')).toBe(true);
  });

  it('is case-insensitive, because file systems are not consistent about it', () => {
    expect(pdfExtractor.handles('Scan.PDF')).toBe(true);
    expect(isImage('Photo.JPG')).toBe(true);
  });

  it('has no two extractors claiming the same file', () => {
    for (const path of ['a.txt', 'a.pdf', 'a.docx', 'a.csv']) {
      expect(chatExtractors.filter((e) => e.handles(path)), path).toHaveLength(1);
    }
  });
});

describe('text extraction', () => {
  it('returns the text of a text file', async () => {
    expect(await textExtractor.extract('a.csv', bytes('month,total\n2026-01,214.50'))).toContain('214.50');
  });

  it('refuses a .txt that is actually binary', async () => {
    expect(await textExtractor.extract('a.txt', bytes('before\0after'))).toBeUndefined();
  });
});

describe('failure is an answer, not an exception', () => {
  it('returns undefined for a PDF that is not a PDF', async () => {
    // One unreadable file in a folder of five hundred must not fail the build.
    await expect(pdfExtractor.extract('broken.pdf', bytes('not a pdf'))).resolves.toBeUndefined();
  });

  it('returns undefined for an empty PDF', async () => {
    await expect(pdfExtractor.extract('empty.pdf', new Uint8Array())).resolves.toBeUndefined();
  });

  it('returns undefined for a .docx that is not a zip', async () => {
    await expect(docxExtractor.extract('broken.docx', bytes('PK not really'))).resolves.toBeUndefined();
  });
});

describe('size ceilings', () => {
  it('lets documents be larger than the code index allows', () => {
    // A 900 KB PDF is ordinary; a 900 KB .ts file is generated. One number
    // cannot serve both.
    expect(pdfExtractor.maxBytes!).toBeGreaterThan(200_000);
    expect(docxExtractor.maxBytes!).toBeGreaterThan(200_000);
  });
});

describe('image media types', () => {
  it('names a type for every image extension it claims', () => {
    for (const path of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif']) {
      expect(isImage(path), path).toBe(true);
      expect(imageMediaType(path), path).toBeDefined();
    }
  });

  it('names none for anything else, so nothing is sent to a vision model by accident', () => {
    expect(imageMediaType('a.pdf')).toBeUndefined();
    expect(imageMediaType('a.heic')).toBeUndefined();
  });
});
