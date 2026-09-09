/**
 * The trust layer: what an answer is actually standing on.
 *
 * Ported in substance from heapchat's `src/util/text.js` and its `VERIFY_SYS`
 * prompt — the ideas survive the move, the code does not, because the original
 * was thirteen lines welded into a 2,779-line route handler with no tests.
 *
 * Two independent mechanisms, deliberately kept apart:
 *
 * - **Provenance** is mechanical and costs nothing: every distinctive number
 *   in an answer is looked up in the evidence that was actually retrieved. It
 *   cannot be wrong about whether a number appears somewhere, which is exactly
 *   why it is worth having next to a model's own claim that it read something.
 * - **Verification** is a second model call and can be wrong in both
 *   directions, so it never suppresses an answer — it annotates one.
 *
 * Neither refuses. A question the folder cannot answer still gets a general
 * answer, unbadged; that was deliberate in heapchat and is deliberate here.
 * Refusing to say what a 1099 is because it is not in your documents makes a
 * worse assistant, not a safer one.
 */

/** One thing the run read, as the grounding layer sees it. */
export interface Evidence {
  /** The file (or URL) this came from, as the person would name it. */
  source: string;
  text: string;
}

/** A number in the answer, traced back to where it appears in the evidence. */
export interface ProvenanceEntry {
  /** The number as written in the answer — "47,200", not 47200. */
  value: string;
  source: string;
  /** Readable context around it in the source. */
  snippet: string;
}

export type Verdict = 'supported' | 'partial' | 'unsupported';

export interface Grounding {
  /** Sources the answer actually leans on. Empty means a general-knowledge answer. */
  sources: string[];
  provenance: ProvenanceEntry[];
  /** Absent when no verification pass ran (no model, or nothing to check). */
  verdict?: Verdict;
  /** Claims the verification pass could not find support for. At most a few. */
  issues?: string[];
}

/**
 * Split a search or semantic-search result into one evidence row per hit.
 *
 * Attribution is the whole product here. A block covering four files, carried
 * as one row, makes every number in it appear to come from all four — which in
 * a feature whose only job is saying where a figure came from is worse than
 * saying nothing. Per-hit rows give each snippet the one file it belongs to.
 *
 * Handles both shapes the tools emit: `semantic_search` writes
 * `--- path:from-to (score …) ---` before each chunk, `search` writes
 * `path:line:` and joins hits with a `--` line.
 */
export function splitHits(content: string): Evidence[] {
  const out: Evidence[] = [];
  // Split before each header, keeping the header with the text that follows.
  const segments = content.split(/\n(?=(?:--- )?[\w./\-@ ]+?\.[A-Za-z0-9]+:\d+)/);
  for (const segment of segments) {
    const header = segment.match(/^(?:--- )?([\w./\-@ ]+?\.[A-Za-z0-9]+):\d+/);
    const source = header?.[1]?.trim();
    if (!source || !segment.trim()) continue;
    out.push({ source, text: segment });
  }
  return out;
}

/** Numbers below this many digits are too ordinary to trace — "3 days", "2 people". */
const MIN_DIGITS = 3;
const MAX_TRACED = 12;
const SNIPPET_PAD = 60;

/**
 * A readable excerpt around `digits` in `text`.
 *
 * The digits are matched with optional separators between them, so an answer
 * saying "47,200" still finds "47200" in the source and vice versa. This is
 * the whole reason the check is on digits rather than on the literal string.
 */
export function snippetFor(text: string, digits: string): string | undefined {
  let pattern: RegExp;
  try {
    // `.` belongs in the separator class alongside `,` and whitespace, and
    // heapchat's original omitted it. The cost was that decimals never traced:
    // an answer saying "£318.40" produced the digits 31840, which could not
    // match "318.40" in the source because of the point between 8 and 4 — so
    // the one number the answer was actually about was the one number with no
    // provenance, while 2026 and 2027 traced fine.
    pattern = new RegExp(digits.split('').join('[,.\\s]?'));
  } catch {
    return undefined;
  }
  const match = pattern.exec(text);
  if (!match) return undefined;
  const from = Math.max(0, match.index - SNIPPET_PAD);
  const to = Math.min(text.length, match.index + match[0].length + SNIPPET_PAD);
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
}

/**
 * Map distinctive numbers in an answer back to the evidence row containing
 * them.
 *
 * A number with no match is simply not listed. That absence is the useful
 * signal — it means the model wrote a figure that is not in anything it read.
 */
export function buildProvenance(answer: string, evidence: readonly Evidence[]): ProvenanceEntry[] {
  const out: ProvenanceEntry[] = [];
  const seen = new Set<string>();
  const numbers = answer.matchAll(/\d[\d,]*(?:\.\d+)?/g);
  for (const match of numbers) {
    if (out.length >= MAX_TRACED) break;
    const raw = match[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length < MIN_DIGITS || seen.has(digits)) continue;
    for (const item of evidence) {
      const snippet = snippetFor(item.text, digits);
      if (snippet) {
        out.push({ value: raw, source: item.source, snippet });
        seen.add(digits);
        break;
      }
    }
  }
  return out;
}

/**
 * The fact-checker's instructions.
 *
 * Kept close to heapchat's wording because it was tuned against the same
 * corpus this repo now runs (`eval/golden.json`). The two clauses that matter
 * most are "ignore general knowledge" — without it every unbadged answer comes
 * back "unsupported" — and the instruction that `used` lists only the sources
 * actually relied on, which is what stops the badge naming all seven files
 * every time.
 */
export const VERIFY_SYSTEM_PROMPT =
  'You are a strict fact-checker. The EVIDENCE is a set of excerpts, each tagged with its source name in ' +
  '[brackets]. Compare the ANSWER against the EVIDENCE. Judge ONLY the answer\'s factual claims about that ' +
  'data — ignore general knowledge, opinions, and conversational filler. Reply with ONLY compact JSON, no ' +
  'prose: {"verdict":"supported"|"partial"|"unsupported","issues":["<short claim not supported by the ' +
  'evidence>"],"used":["<exact source name(s) whose excerpt actually supports the answer>"]}. Use ' +
  '"supported" if every data claim checks out, "partial" if some do and some do not, "unsupported" if the ' +
  'main claim is not in the evidence. In "used", list ONLY the sources the answer actually relies on — ' +
  'usually one — not every source shown. At most 3 short issues.';

/** Evidence rendered for the fact-checker, bounded so one large file cannot fill the window. */
export function formatEvidence(evidence: readonly Evidence[], perSourceChars = 700): string {
  return evidence
    .map((e) => `[${e.source}]\n${e.text.slice(0, perSourceChars)}`)
    .join('\n\n');
}

/** Parse the checker's reply. Anything unrecognised is "no opinion", never a failure. */
export function parseVerification(raw: string): { verdict?: Verdict; issues?: string[]; used?: string[] } {
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) return {};
  try {
    const parsed = JSON.parse(json[0]) as { verdict?: string; issues?: unknown; used?: unknown };
    const verdict =
      parsed.verdict === 'supported' || parsed.verdict === 'partial' || parsed.verdict === 'unsupported'
        ? parsed.verdict
        : undefined;
    return {
      verdict,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === 'string').slice(0, 3) : undefined,
      used: Array.isArray(parsed.used) ? parsed.used.filter((u): u is string => typeof u === 'string') : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Whether this answer is making claims about the files at all.
 *
 * "What is the capital of France?" retrieves nothing and should carry no
 * badge — not because it is untrustworthy but because there is nothing in the
 * folder to trust it against. Badging it would make the badge meaningless,
 * which is the failure mode that matters: a badge that is always on says
 * nothing when it is on.
 */
export function isGroundedAnswer(evidence: readonly Evidence[], provenance: readonly ProvenanceEntry[]): boolean {
  return evidence.length > 0 && (provenance.length > 0 || evidence.some((e) => e.text.trim().length > 0));
}
