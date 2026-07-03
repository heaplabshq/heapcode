export interface CleanOptions {
  /** Text before the cursor; used to detect and trim regenerated code. */
  prefix?: string;
  /** Text after the cursor; used to trim regenerated overlap. */
  suffix: string;
  /** 1 for single-line completions. */
  maxLines: number;
}

/**
 * Normalizes raw model output into an insertable completion.
 * Returns '' when the completion is useless: empty, repeating what's already
 * after the cursor, or regurgitating existing file content (chat-fallback
 * models love re-printing the file from the top).
 */
export function cleanCompletion(raw: string, opts: CleanOptions): string {
  let text = raw.replace(/\r\n/g, '\n');

  // Strip markdown fences — including unterminated ones (output truncated
  // by token/line limits before the closing fence).
  text = text.replace(/^\s*```[\w+.-]*[ \t]*\n?/, '');
  text = text.replace(/\n?```\s*$/, '');

  // Trim a head that repeats the tail of the prefix (model re-typed the
  // text leading up to the cursor). Minimum 2 chars — 1-char "overlaps"
  // are usually coincidence and would corrupt the completion.
  const prefixTail = (opts.prefix ?? '').slice(-400);
  if (prefixTail.trim()) {
    for (let k = Math.min(text.length, prefixTail.length); k >= 2; k--) {
      const head = text.slice(0, k);
      if (!head.trim()) continue;
      if (prefixTail.endsWith(head)) {
        text = text.slice(k);
        break;
      }
    }
  }

  // Reject wholesale regurgitation — but only when it's unambiguous: the
  // completion's first TWO non-empty lines appear consecutively in the file.
  // A single repeated line is often legitimate (`return (`, `</div>`, …).
  if (opts.prefix) {
    const completionLines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (completionLines.length >= 2) {
      const prefixLines = opts.prefix.split('\n').map((l) => l.trim());
      for (let i = 0; i < prefixLines.length - 1; i++) {
        if (
          prefixLines[i] === completionLines[0] &&
          prefixLines[i + 1] === completionLines[1] &&
          completionLines[0]!.length > 4
        ) {
          return '';
        }
      }
    }
  }

  // Enforce line limit.
  const lines = text.split('\n');
  if (lines.length > opts.maxLines) {
    text = lines.slice(0, opts.maxLines).join('\n');
  }
  text = text.replace(/\s+$/, '');
  if (!text.trim()) return '';

  // Trim tail that regenerates the beginning of the suffix.
  const suffixHead = opts.suffix.slice(0, 400);
  if (suffixHead.trim()) {
    for (let k = Math.min(text.length, suffixHead.length); k >= 1; k--) {
      const tail = text.slice(-k);
      if (!tail.trim()) continue;
      if (suffixHead.startsWith(tail)) {
        text = text.slice(0, -k).replace(/\s+$/, '');
        break;
      }
    }
  }
  if (!text.trim()) return '';

  // Completion that only repeats the next existing line is noise.
  const nextExistingLine = opts.suffix.split('\n').find((l) => l.trim());
  if (nextExistingLine && text.trim() === nextExistingLine.trim()) return '';

  return text;
}
