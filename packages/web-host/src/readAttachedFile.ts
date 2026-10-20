import { extname } from 'node:path';
import type { DocumentExtractor } from '@heapcode/core';

/** A document can be large; a 12 MB PDF is ordinary, and it only becomes text here. */
export const MAX_ATTACHED_FILE_BYTES = 12 * 1024 * 1024;
/**
 * The text kept from one file. Roughly 50k tokens: enough for a long contract
 * or a day of logs, short of filling a small model's whole window with one
 * attachment. Past it the text is cut and the model is told so.
 */
export const MAX_ATTACHED_FILE_CHARS = 200_000;

/** Formats that are not text and that nothing here reads, named so the refusal is specific. */
const UNREADABLE = new Set([
  '.doc', '.xls', '.xlsx', '.ppt', '.pptx', '.key', '.numbers', '.pages', '.odt', '.ods', '.odp', '.rtf',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.dmg', '.exe', '.bin', '.so', '.dylib', '.dll', '.class', '.jar',
  '.mp3', '.mp4', '.mov', '.wav', '.m4a', '.avi', '.mkv', '.heic', '.psd', '.sqlite', '.db',
]);

export interface ReadAttachedFileResult {
  name: string;
  text: string;
  /** The text was longer than MAX_ATTACHED_FILE_CHARS and was cut there. */
  truncated: boolean;
}

/**
 * A file attached in the composer, read to plain text — or an Error whose
 * message is fit to show the person.
 *
 * Documents go through the same extractors Heap Chat indexes a folder with
 * (PDF, Word, CSV…); anything else is accepted when it is UTF-8 text, which
 * covers source code, Markdown, JSON, logs and configs without a list of
 * extensions to keep current.
 */
export async function readAttachedFile(
  name: string,
  base64: string,
  extractors: readonly DocumentExtractor[] = [],
): Promise<ReadAttachedFileResult> {
  const label = name || 'That file';
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_ATTACHED_FILE_BYTES) {
    throw new Error(`${label} is too large to attach (max ${MAX_ATTACHED_FILE_BYTES / 1024 / 1024} MB).`);
  }
  const ext = extname(name).toLowerCase();
  const extractor = extractors.find((e) => e.handles(name));

  let text: string | undefined;
  if (extractor) {
    text = await extractor.extract(name, new Uint8Array(bytes));
    if (!text?.trim()) {
      throw new Error(
        ext === '.pdf'
          ? `Couldn't find any text in ${label}. It may be a scan, or password-protected.`
          : `Couldn't read any text from ${label}.`,
      );
    }
  } else if (ext === '.pdf' || ext === '.docx') {
    throw new Error(`Reading ${ext.slice(1).toUpperCase()} files isn't available here — attach it in Heap Chat.`);
  } else if (UNREADABLE.has(ext)) {
    throw new Error(`Can't read ${label}. Attach PDFs, Word documents, or text and code files.`);
  } else {
    text = asText(bytes);
    if (text === undefined) throw new Error(`Can't read ${label} — it isn't a text file.`);
  }

  const truncated = text.length > MAX_ATTACHED_FILE_CHARS;
  return {
    name,
    text: truncated
      ? `${text.slice(0, MAX_ATTACHED_FILE_CHARS)}\n\n[… cut here: the file continues for another ${(text.length - MAX_ATTACHED_FILE_CHARS).toLocaleString('en-US')} characters]`
      : text,
    truncated,
  };
}

/** UTF-8 text, or undefined for anything binary. */
function asText(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
