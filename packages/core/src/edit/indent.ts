/** Smallest leading whitespace across non-empty lines. */
export function minIndent(text: string): string {
  let min: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)![0];
    if (min === undefined || indent.length < min.length) min = indent;
    if (min === '') break;
  }
  return min ?? '';
}

/**
 * Shifts `proposed` so its base indentation matches `referenceIndent`.
 * Models often return replacement code flush-left even when the original
 * selection sat inside a class or function body.
 */
export function reindent(proposed: string, referenceIndent: string): string {
  const current = minIndent(proposed);
  if (current === referenceIndent) return proposed;
  return proposed
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const stripped = line.startsWith(current) ? line.slice(current.length) : line;
      return referenceIndent + stripped;
    })
    .join('\n');
}
