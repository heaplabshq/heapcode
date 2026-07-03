export interface CleanOptions {
  /** Text after the cursor; used to trim regenerated overlap. */
  suffix: string;
  /** 1 for single-line completions. */
  maxLines: number;
}

/**
 * Normalizes raw model output into an insertable completion.
 * Returns '' when the completion is useless (empty, or just repeats
 * what's already after the cursor).
 */
export function cleanCompletion(raw: string, opts: CleanOptions): string {
  let text = raw.replace(/\r\n/g, '\n');

  // Chat models sometimes fence the answer despite instructions.
  const fenced = /^\s*```[\w+.-]*[ \t]*\n([\s\S]*?)```\s*$/.exec(text);
  if (fenced) text = fenced[1]!;

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
