export interface MatchSpan {
  start: number;
  end: number;
}

export interface FuzzyMatch {
  /** Character offsets into the haystack (of the chosen occurrence). */
  start: number;
  end: number;
  exact: boolean;
  /** True when the needle matches more than one place in the haystack — the caller should refuse to guess. */
  ambiguous: boolean;
  /** How many places the needle matched, when ambiguous. */
  occurrences?: number;
  /** Every place the needle matched, in file order. What `replace_all` rewrites. */
  spans: readonly MatchSpan[];
  /** 1-based line number of each span — so an "ambiguous" error can say *where*. */
  lines: readonly number[];
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

/** Visual width of a line's leading whitespace, tabs counted as 4 columns. */
function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

/**
 * The needle's lines with blank leading/trailing ones dropped but each line's
 * own indentation left intact — the same set of lines `cleaned.trim()` yields,
 * except that trimming would also eat the first line's indent, which is
 * precisely the signal `indentDistance` needs.
 */
function blockLines(text: string): string[] {
  const lines = text.split('\n');
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && !lines[first]!.trim()) first++;
  while (last >= first && !lines[last]!.trim()) last--;
  return lines.slice(first, last + 1);
}

/** How far a candidate's indentation sits from the needle's, summed over lines. */
function indentDistance(hayLines: string[], at: number, needleBlock: string[]): number {
  let total = 0;
  for (let j = 0; j < needleBlock.length; j++) {
    const line = needleBlock[j]!;
    if (!line.trim()) continue; // a blank line carries no indentation signal
    total += Math.abs(indentWidth(hayLines[at + j]!) - indentWidth(line));
  }
  return total;
}

/** Index of the strictly smallest score, or -1 when the best score is tied. */
function uniqueMinIndex(scores: number[]): number {
  let best = 0;
  let tied = false;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i]! < scores[best]!) {
      best = i;
      tied = false;
    } else if (scores[i]! === scores[best]!) {
      tied = true;
    }
  }
  return tied ? -1 : best;
}

/**
 * The needle exactly as written comes first, and only then the trimmed form.
 *
 * Trimming first looked harmless and quietly doubled indentation: searching
 * for `  return x;` matched at the `r`, not at the start of the line, so a
 * replacement carrying its own two spaces landed four spaces in. Probing the
 * untrimmed needle first anchors the match at the line start whenever the
 * model quoted the indentation correctly — which is the common case, and the
 * one where the result silently looked almost right.
 */
function exactCandidates(cleaned: string): string[] {
  const trimmed = cleaned.trim();
  return cleaned === trimmed ? [trimmed] : [cleaned, trimmed];
}

/** Every literal occurrence of `candidate`, in file order. */
function exactSpans(haystack: string, candidate: string): MatchSpan[] {
  const spans: MatchSpan[] = [];
  let from = 0;
  while (true) {
    const at = haystack.indexOf(candidate, from);
    if (at === -1) break;
    spans.push({ start: at, end: at + candidate.length });
    from = at + 1;
  }
  return spans;
}

function toMatch(haystack: string, spans: MatchSpan[], best: number, exact: boolean, ambiguous: boolean): FuzzyMatch {
  // One pass over the haystack turns offsets into line numbers, rather than
  // slicing the file once per span.
  const lines: number[] = [];
  let line = 1;
  let cursor = 0;
  for (const span of spans) {
    for (; cursor < span.start; cursor++) if (haystack[cursor] === '\n') line++;
    lines.push(line);
  }
  return {
    start: spans[best]!.start,
    end: spans[best]!.end,
    exact,
    ambiguous,
    occurrences: ambiguous ? spans.length : undefined,
    spans,
    lines,
  };
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
 *
 * The fuzzy pass compares lines trimmed, which throws away the one thing that
 * distinguishes the same statement at two nesting depths — so it used to call
 * a perfectly specific needle ambiguous the moment the exact pass missed for
 * an unrelated reason (one space off, tabs vs spaces, CRLF, a trailing space
 * in the file), and then told the model to be more specific, which it could
 * not be. Candidates are therefore ranked by how closely their indentation
 * tracks the needle's; a single closest candidate wins outright. A genuine tie
 * — the same code at the same depth in two places — is still ambiguous.
 */
export function findBestMatch(haystack: string, needle: string): FuzzyMatch | undefined {
  const cleaned = stripLineNumbers(needle);
  if (!cleaned.trim()) return undefined;

  let exactlyAmbiguous: FuzzyMatch | undefined;
  for (const candidate of exactCandidates(cleaned)) {
    const spans = exactSpans(haystack, candidate);
    if (spans.length === 0) continue;
    if (spans.length === 1) return toMatch(haystack, spans, 0, true, false);
    // Several hits. Note that even the untrimmed needle matches as a plain
    // substring, so `   x;` happily lands inside `    x;` one column in — the
    // hit is not anchored to the line start and its indentation is only
    // partly meaningful. So hold this result and let the line-based pass below
    // try to rank the candidates by indentation before we refuse outright.
    exactlyAmbiguous = toMatch(haystack, spans, 0, true, true);
    break;
  }

  const hayLines = haystack.split('\n');
  const needleBlock = blockLines(cleaned);
  const needleLines = needleBlock.map((l) => l.trim());
  const n = needleLines.length;

  // Char offset of each haystack line start.
  const offsets: number[] = [];
  let acc = 0;
  for (const line of hayLines) {
    offsets.push(acc);
    acc += line.length + 1;
  }

  const spans: MatchSpan[] = [];
  const scores: number[] = [];
  for (let i = 0; i + n <= hayLines.length; i++) {
    let matches = true;
    for (let j = 0; j < n; j++) {
      if (hayLines[i + j]!.trim() !== needleLines[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    spans.push({ start: offsets[i]!, end: offsets[i + n - 1]! + hayLines[i + n - 1]!.length });
    scores.push(indentDistance(hayLines, i, needleBlock));
  }
  // Nothing matched whole-line — e.g. the needle is a mid-line fragment. Any
  // held exact-but-ambiguous result is still the truthful answer.
  if (spans.length === 0) return exactlyAmbiguous;
  if (spans.length === 1) return toMatch(haystack, spans, 0, false, false);

  const best = uniqueMinIndex(scores);
  if (best === -1) return exactlyAmbiguous ?? toMatch(haystack, spans, 0, false, true);
  return toMatch(haystack, spans, best, false, false);
}

/**
 * Reads the `replace_all` flag off a tool call's raw arguments.
 *
 * Accepts the string `"true"` as well as the boolean: smaller models routinely
 * stringify every argument value, and silently reading that as false would
 * turn an explicit "change all of them" into the ambiguity refusal it was
 * meant to answer.
 */
export function wantsReplaceAll(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Renders the "matches N places" refusal, including where those places are.
 *
 * Without the line numbers the model is retrying blind: it is told the search
 * text is ambiguous but not which of the candidates it hit, so "add more
 * surrounding lines" is guesswork. Shared by edit_file and multi_edit across
 * both hosts so the four call sites cannot drift apart.
 */
export function describeAmbiguity(match: FuzzyMatch, path: string, prefix = 'The "search" text'): string {
  const shown = match.lines.slice(0, 10).join(', ');
  const more = match.lines.length > 10 ? `, … (${match.lines.length - 10} more)` : '';
  return (
    `${prefix} matches ${match.occurrences} different places in ${path} — refusing to guess which one. ` +
    `Matches start at line${match.lines.length === 1 ? '' : 's'} ${shown}${more}. ` +
    'Include more surrounding lines so the search text is unique to the intended location, ' +
    'or pass "replace_all": true to change every one of them.'
  );
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

/**
 * Replaces *every* match of `search` — the escape hatch for the case no amount
 * of surrounding context can fix, because the sites really are identical (five
 * copies of the same handler in one component). Without it, an ambiguity
 * refusal there is unanswerable and the model just retries until it gives up.
 *
 * Returns undefined when nothing matched, so the caller can tell "no match"
 * apart from "replaced nothing".
 */
export function applySearchReplaceAll(
  content: string,
  search: string,
  replace: string,
): { text: string; count: number } | undefined {
  const cleaned = stripLineNumbers(search);
  if (!cleaned.trim()) return undefined;
  const replacement = stripLineNumbers(replace);

  const spliceAll = (spans: readonly MatchSpan[]): { text: string; count: number } => {
    let text = '';
    let cursor = 0;
    let count = 0;
    for (const span of spans) {
      if (span.start < cursor) continue; // self-overlapping needle — keep the earlier hit
      text += content.slice(cursor, span.start) + replacement;
      cursor = span.end;
      count++;
    }
    return { text: text + content.slice(cursor), count };
  };

  // Literal occurrences win outright. findBestMatch would rank them by
  // indentation and hand back whole-line spans, which is right when picking
  // *one* site but wrong here: replacing whole lines would restate every site
  // at the replacement's own indentation, flattening the very nesting that
  // makes the sites different. Replacing the literal text leaves each site's
  // indentation exactly as it was.
  for (const candidate of exactCandidates(cleaned)) {
    const spans = exactSpans(content, candidate);
    if (spans.length > 0) return spliceAll(spans);
  }

  const match = findBestMatch(content, search);
  return match ? spliceAll(match.spans) : undefined;
}
