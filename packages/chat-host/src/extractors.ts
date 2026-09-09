import { extname } from 'node:path';
import type { DocumentExtractor } from '@heapcode/core';

/**
 * What Heap Chat can read beyond source code.
 *
 * The parsers are loaded with `await import(...)` inside a try/catch and
 * declared as **optional** dependencies, external to the CLI bundle. Someone
 * installing `@heaplabs/heapcode-cli` for the coding agent should not download
 * a PDF parser and a DOCX reader to get it — the same reasoning that already
 * keeps `fsevents` and `bufferutil` out of that bundle. When a parser is
 * absent the file type is simply not indexed, and `describeMissingParsers`
 * says which ones and how to get them, rather than the folder quietly
 * appearing to contain nothing.
 */

/** Extensions that are already plain text but that `CODE_EXTENSIONS` does not claim. */
const TEXT_EXTENSIONS = new Set(['.txt', '.text', '.csv', '.tsv', '.log', '.vtt', '.srt', '.tex']);

/** Documents are legitimately larger than source files; a 4 MB PDF is ordinary. */
const DOCUMENT_MAX_BYTES = 12 * 1024 * 1024;
const TEXT_MAX_BYTES = 4 * 1024 * 1024;

function ext(rel: string): string {
  return extname(rel).toLowerCase();
}

/**
 * Plain text the code index would otherwise skip.
 *
 * Needs no parser — it exists to widen *selection*, not to decode anything.
 * `.csv` in particular is the one people notice: a folder of exports looks
 * empty to a code-extension filter.
 */
export const textExtractor: DocumentExtractor = {
  name: 'text',
  maxBytes: TEXT_MAX_BYTES,
  handles: (rel) => TEXT_EXTENSIONS.has(ext(rel)),
  async extract(_rel, bytes) {
    const text = new TextDecoder().decode(bytes);
    // A `.txt` that is actually binary is a mislabelled file, not text.
    return text.includes('\0') ? undefined : text;
  },
};

export const pdfExtractor: DocumentExtractor = {
  name: 'pdf',
  maxBytes: DOCUMENT_MAX_BYTES,
  handles: (rel) => ext(rel) === '.pdf',
  async extract(_rel, bytes) {
    const mod = await loadPdfParse();
    if (!mod) return undefined;
    let parser: { getText(): Promise<{ text?: string }>; destroy(): Promise<void> } | undefined;
    try {
      parser = new mod.PDFParse({ data: bytes });
      const { text } = await parser.getText();
      // A scan with no text layer returns nothing. That is a real answer about
      // the file, not an error — OCR is out of scope, and pretending an empty
      // string is content would put a searchable-but-empty entry in the index.
      return text;
    } catch {
      // Encrypted, truncated, or not really a PDF. One bad file in a folder of
      // five hundred must not fail the build.
      return undefined;
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  },
};

export const docxExtractor: DocumentExtractor = {
  name: 'docx',
  maxBytes: DOCUMENT_MAX_BYTES,
  // `.doc` (the pre-2007 binary format) is deliberately absent: mammoth reads
  // only OOXML, and claiming the extension would index the file as garbage.
  handles: (rel) => ext(rel) === '.docx',
  async extract(_rel, bytes) {
    const mod = await loadMammoth();
    if (!mod) return undefined;
    try {
      const { value } = await mod.extractRawText({ buffer: Buffer.from(bytes) });
      return value;
    } catch {
      return undefined;
    }
  },
};

interface PdfParseModule {
  PDFParse: new (opts: { data: Uint8Array }) => {
    getText(): Promise<{ text?: string }>;
    destroy(): Promise<void>;
  };
}
interface MammothModule {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
}

/** Resolved once and cached, including the failure — probing per file is pointless. */
let pdfModule: PdfParseModule | null | undefined;
let mammothModule: MammothModule | null | undefined;

async function loadPdfParse(): Promise<PdfParseModule | null> {
  if (pdfModule !== undefined) return pdfModule;
  try {
    pdfModule = (await import('pdf-parse')) as unknown as PdfParseModule;
  } catch {
    pdfModule = null;
  }
  return pdfModule;
}

async function loadMammoth(): Promise<MammothModule | null> {
  if (mammothModule !== undefined) return mammothModule;
  try {
    const mod = (await import('mammoth')) as unknown as { default?: MammothModule } & MammothModule;
    mammothModule = mod.default ?? mod;
  } catch {
    mammothModule = null;
  }
  return mammothModule;
}

/** Every extractor Heap Chat registers. Order matters only for overlapping claims; none overlap. */
export const chatExtractors: readonly DocumentExtractor[] = [textExtractor, pdfExtractor, docxExtractor];

/**
 * Which optional parsers are missing, for the page to say so.
 *
 * Worth surfacing rather than swallowing: "there is nothing about the deposit
 * in this folder" and "the PDF holding it was never indexed because a parser
 * is not installed" look identical to the person asking, and only one of them
 * is true.
 */
export async function describeMissingParsers(): Promise<string[]> {
  const missing: string[] = [];
  if (!(await loadPdfParse())) missing.push('pdf-parse (PDFs)');
  if (!(await loadMammoth())) missing.push('mammoth (Word .docx)');
  return missing;
}
