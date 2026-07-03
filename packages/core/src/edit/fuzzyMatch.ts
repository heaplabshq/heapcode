export interface FuzzyMatch {
  /** Character offsets into the haystack. */
  start: number;
  end: number;
  exact: boolean;
}

/**
 * Locates `needle` inside `haystack`: exact match first, then a
 * whitespace-tolerant line-by-line match (each line compared trimmed).
 * LLMs routinely mangle indentation when quoting code — the fuzzy pass is
 * what makes "apply this edit" reliable in practice.
 */
export function findBestMatch(haystack: string, needle: string): FuzzyMatch | undefined {
  const trimmedNeedle = needle.trim();
  if (!trimmedNeedle) return undefined;

  const exactIndex = haystack.indexOf(trimmedNeedle);
  if (exactIndex !== -1) {
    return { start: exactIndex, end: exactIndex + trimmedNeedle.length, exact: true };
  }

  const hayLines = haystack.split('\n');
  const needleLines = trimmedNeedle.split('\n').map((l) => l.trim());
  const n = needleLines.length;

  // Char offset of each haystack line start.
  const offsets: number[] = [];
  let acc = 0;
  for (const line of hayLines) {
    offsets.push(acc);
    acc += line.length + 1;
  }

  for (let i = 0; i + n <= hayLines.length; i++) {
    let matches = true;
    for (let j = 0; j < n; j++) {
      if (hayLines[i + j]!.trim() !== needleLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const start = offsets[i]!;
      const end = offsets[i + n - 1]! + hayLines[i + n - 1]!.length;
      return { start, end, exact: false };
    }
  }
  return undefined;
}

/**
 * Replaces the best match of `search` in `content` with `replace`.
 * Returns undefined when no acceptable match exists — callers must surface
 * that rather than guessing.
 */
export function applySearchReplace(
  content: string,
  search: string,
  replace: string,
): string | undefined {
  const match = findBestMatch(content, search);
  if (!match) return undefined;
  return content.slice(0, match.start) + replace + content.slice(match.end);
}
