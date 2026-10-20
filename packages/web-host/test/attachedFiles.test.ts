import { describe, expect, it } from 'vitest';
import type { DocumentExtractor } from '@heapcode/core';
import { splitAttachedFiles, titleFromMessage, withAttachedFiles } from '../src/attachedFiles.js';
import { MAX_ATTACHED_FILE_CHARS, readAttachedFile } from '../src/readAttachedFile.js';

const b64 = (s: string | Uint8Array): string => Buffer.from(s).toString('base64');

describe('documents carried in a message', () => {
  it('round-trips the typed text and every file', () => {
    const files = [
      { name: 'lease.pdf', text: 'Clause 4: rent is due monthly.' },
      { name: 'say "hi".txt', text: 'line one\nline two\n' },
    ];
    const message = withAttachedFiles('  what does clause 4 say?  ', files);
    expect(message.startsWith('what does clause 4 say?\n\n<attached-file name="lease.pdf">')).toBe(true);
    expect(splitAttachedFiles(message)).toEqual({ text: 'what does clause 4 say?', files });
  });

  it('keeps a document that quotes the closing tag in one piece', () => {
    const files = [{ name: 'a.md', text: 'before </attached-file> after' }];
    expect(splitAttachedFiles(withAttachedFiles('q', files)).files).toEqual(files);
  });

  it('leaves an ordinary message alone', () => {
    expect(withAttachedFiles('hello', [])).toBe('hello');
    expect(splitAttachedFiles('hello')).toEqual({ text: 'hello', files: [] });
  });

  it('titles a conversation by what was typed, or by the file when nothing was', () => {
    expect(titleFromMessage(withAttachedFiles('summarize the lease', [{ name: 'lease.pdf', text: 'x' }]))).toBe(
      'summarize the lease',
    );
    expect(titleFromMessage(withAttachedFiles('', [{ name: 'lease.pdf', text: 'x' }]))).toBe('lease.pdf');
  });
});

describe('reading an attached file', () => {
  const pdf: DocumentExtractor = {
    name: 'pdf',
    handles: (rel) => rel.endsWith('.pdf'),
    extract: async (_rel, bytes) => (bytes.length > 2 ? 'the pdf text' : ''),
  };

  it('reads code, Markdown and other UTF-8 text without a list of extensions', async () => {
    const r = await readAttachedFile('app.config.ts', b64('export const x = 1;\n'));
    expect(r).toEqual({ name: 'app.config.ts', text: 'export const x = 1;\n', truncated: false });
  });

  it('reads a document through its extractor', async () => {
    expect((await readAttachedFile('lease.pdf', b64('%PDF-1'), [pdf])).text).toBe('the pdf text');
  });

  it('says a PDF with no text layer is probably a scan', async () => {
    await expect(readAttachedFile('scan.pdf', b64('%P'), [pdf])).rejects.toThrow(/may be a scan/);
  });

  it('says where PDFs can be read when this host has no reader for them', async () => {
    await expect(readAttachedFile('lease.pdf', b64('%PDF-1'))).rejects.toThrow(/Heap Chat/);
  });

  it('refuses binary files, naming what it can read', async () => {
    await expect(readAttachedFile('budget.xlsx', b64('PK'))).rejects.toThrow(/PDFs, Word documents, or text and code/);
    await expect(readAttachedFile('blob', b64(new Uint8Array([1, 0, 2, 0])))).rejects.toThrow(/isn't a text file/);
  });

  it('cuts a very long file and says so in the text', async () => {
    const r = await readAttachedFile('big.log', b64('a'.repeat(MAX_ATTACHED_FILE_CHARS + 50)));
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/cut here: the file continues for another 50 characters/);
  });
});
