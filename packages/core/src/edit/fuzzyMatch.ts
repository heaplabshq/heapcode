export interface FuzzyMatch {
  /** Character offsets into the haystack (of the first occurrence found). */
  start: number;
  end: number;
  exact: boolean;
  /** True when the needle matches more than one place in the haystack — the caller should refuse to guess. */
  ambiguous: boolean;
  /** How many places the needle matched, when ambiguous. */
  occurrences?: number;
}

/**
 * Locates `needle` inside `haystack`: exact match first, then a
 * whitespace-tolerant line-by-line match (each line compared trimmed).
 * LLMs routinely mangle indentation when quoting code — the fuzzy pass is
 * what makes "apply this edit" reliable in practice.
 *
 * A needle that matches more than one location (e.g. a generic closing
 * brace shared by several blocks) is reported as `ambiguous` rather than
 * silently resolved to the first hit — applying an edit at the wrong one
 * of several identical-looking spots is a real corruption risk, not a
 * theoretical one.
 */
export function findBestMatch(haystack: string, needle: string): FuzzyMatch | undefined {
  const trimmedNeedle = needle.trim();
  if (!trimmedNeedle) return undefined;

  const exactIndex = haystack.indexOf(trimmedNeedle);
  if (exactIndex !== -1) {
    let occurrences = 1;
    let from = exactIndex + 1;
    while (true) {
      const next = haystack.indexOf(trimmedNeedle, from);
      if (next === -1) break;
      occurrences++;
      from = next + 1;
    }
    return {
      start: exactIndex,
      end: exactIndex + trimmedNeedle.length,
      exact: true,
      ambiguous: occurrences > 1,
      occurrences: occurrences > 1 ? occurrences : undefined,
    };
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

  let found: { start: number; end: number } | undefined;
  let occurrences = 0;
  for (let i = 0; i + n <= hayLines.length; i++) {
    let matches = true;
    for (let j = 0; j < n; j++) {
      if (hayLines[i + j]!.trim() !== needleLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      occurrences++;
      if (!found) {
        found = { start: offsets[i]!, end: offsets[i + n - 1]! + hayLines[i + n - 1]!.length };
      }
    }
  }
  if (!found) return undefined;
  return {
    ...found,
    exact: false,
    ambiguous: occurrences > 1,
    occurrences: occurrences > 1 ? occurrences : undefined,
  };
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
  if (!match || match.ambiguous) return undefined;
  return content.slice(0, match.start) + replace + content.slice(match.end);
}
