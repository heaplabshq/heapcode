/**
 * Turning a file that is not source code into text the index can hold.
 *
 * A seam, not an implementation. `core` names the contract and stays free of
 * every parser that satisfies it: `pdf-parse`, `mammoth` and their transitive
 * dependencies are tens of megabytes, and `@heaplabs/heapcode-cli` must not
 * grow by them because a different product on the same engine reads PDFs.
 * Hosts register what they can parse; a host that registers nothing indexes
 * exactly the files it always did.
 *
 * Why here rather than in the chat host: the *policy* is per-product, but the
 * place the decision has to be made is inside `indexOne`, between "is this
 * file worth reading" and "decode it as UTF-8". Reproducing the indexer to
 * change two lines of it would be the worse duplication.
 */

/** A file type the index can read once a host supplies the parser for it. */
export interface DocumentExtractor {
  /** For diagnostics — "which extractor claimed this file". */
  readonly name: string;
  /** Workspace-relative path → does this extractor handle it. */
  handles(rel: string): boolean;
  /**
   * Bytes → plain text, or undefined when this file cannot be read after all
   * (encrypted, malformed, an image-only scan with no text layer).
   *
   * Undefined is an ordinary answer and must not throw: one unreadable PDF in
   * a folder of five hundred is not a reason to fail the build.
   */
  extract(rel: string, bytes: Uint8Array): Promise<string | undefined>;
  /**
   * Byte ceiling for this type, overriding the indexer's own.
   *
   * A 900 KB PDF is ordinary; a 900 KB `.ts` file is generated. One number
   * cannot serve both, and the code default is the tighter of the two.
   */
  readonly maxBytes?: number;
}

/** The first extractor that claims this path, if any. */
export function extractorFor(
  extractors: readonly DocumentExtractor[] | undefined,
  rel: string,
): DocumentExtractor | undefined {
  return extractors?.find((e) => e.handles(rel));
}

/**
 * Normalize extracted text before it is chunked.
 *
 * Document parsers emit shapes a line-window chunker handles badly: form
 * feeds between PDF pages, runs of blank lines where a layout had whitespace,
 * and non-breaking spaces that then fail an exact keyword match against what
 * the person typed. Collapsing them here rather than in each extractor means
 * one behaviour to reason about across every format.
 */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n\n')
    .replace(/[   ]/g, ' ')
    // Three or more blank lines carry no more meaning than one, and each is a
    // line the chunker's windows have to spend.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}
