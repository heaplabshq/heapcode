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

/** A line as `read_file` emits it: 1-indexed number, a TAB, then the source. */
const NUMBERED_LINE = /^\d+\t/;

/**
 * Strips `read_file`'s line-number gutter, but only from a block where *every*
 * non-blank line carries one.
 *
 * `read_file` returns `12\tconst x = 1;` — and then `edit_file` refused any
 * search text that still had those prefixes, because the matcher compares
 * lines trimmed and `12\tconst x = 1;` never equals `const x = 1;`. The tool
 * was handing the model a format it would not itself accept, and the failure
 * came back as "the search text was not found", which reads like the code has
 * moved rather than like a transcription rule was broken.
 *
 * The all-or-nothing guard is what makes this safe: a genuine source line
 * beginning with digits and a tab is rare, and a whole *block* of them that
 * also happen to run consecutively from any starting number is not something
 * that occurs by accident.
 */
export function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  const numbered = lines.filter((l) => l.trim());
  if (numbered.length === 0 || !numbered.every((l) => NUMBERED_LINE.test(l))) return text;
  return lines.map((l) => l.replace(NUMBERED_LINE, '')).join('\n');
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
  const cleaned = stripLineNumbers(needle);
  const trimmedNeedle = cleaned.trim();
  if (!trimmedNeedle) return undefined;

  // The needle exactly as written comes first, and only then the trimmed form.
  //
  // Trimming first looked harmless and quietly doubled indentation: searching
  // for `  return x;` matched at the `r`, not at the start of the line, so a
  // replacement carrying its own two spaces landed four spaces in. Probing the
  // untrimmed needle first anchors the match at the line start whenever the
  // model quoted the indentation correctly — which is the common case, and the
  // one where the result silently looked almost right.
  for (const candidate of cleaned === trimmedNeedle ? [trimmedNeedle] : [cleaned, trimmedNeedle]) {
    const exactIndex = haystack.indexOf(candidate);
    if (exactIndex === -1) continue;
    let occurrences = 1;
    let from = exactIndex + 1;
    while (true) {
      const next = haystack.indexOf(candidate, from);
      if (next === -1) break;
      occurrences++;
      from = next + 1;
    }
    return {
      start: exactIndex,
      end: exactIndex + candidate.length,
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
  // The replacement gets the same gutter treatment as the search text. A model
  // that copied line numbers into one has very likely copied them into the
  // other, and stripping only the search side would take a loud "not found"
  // and turn it into a silent write of `12\tconst x = 1;` into the source.
  return content.slice(0, match.start) + stripLineNumbers(replace) + content.slice(match.end);
}
