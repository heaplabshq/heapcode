import { createHash } from 'node:crypto';
import { NoteError } from './errors.js';
import type { Heading, ParsedNote } from './parse.js';

/**
 * Pointing at part of a note by its headings, the way bearcli does,
 * so an agent can read or rewrite one section
 * instead of the whole note.
 *
 * An address is one heading per line, outermost first — `# Setup\n## Install`
 * — where each line after the first must sit inside the one before. The `#`s
 * are optional (without them any level matches) and the first line matches at
 * any depth, so `## Install` alone works when it's unique. `preamble` is the
 * lead text: after the title line, before the first heading.
 */
export interface Section {
  /** The address that reaches exactly this section. */
  address: string;
  level: number;
  heading: string;
  /** From the heading line's start… */
  start: number;
  /** …to just before the next heading of the same or a higher level. */
  end: number;
}

export const PREAMBLE = 'preamble';

/** Every section with the address that names it uniquely, in document order. */
export function outline(text: string, parsed: ParsedNote): Section[] {
  const sections = rangesFor(text, parsed.headings);
  return sections.map((s, i) => {
    const path: Heading[] = [];
    for (let j = 0; j <= i; j++) {
      const h = parsed.headings[j]!;
      if (sections[j]!.end >= s.end && sections[j]!.start <= s.start) path.push(h);
    }
    const address = path.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n');
    const twins = sections.filter((o, k) => k < i && sameAddress(sections, parsed.headings, k, address)).length;
    return { ...s, address: twins > 0 ? `${address}\n[${twins + 1}]` : address };
  });
}

function sameAddress(sections: Omit<Section, 'address'>[], headings: Heading[], k: number, address: string): boolean {
  const s = sections[k]!;
  const path = headings.filter((_, j) => j <= k && sections[j]!.end >= s.end && sections[j]!.start <= s.start);
  return path.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n') === address;
}

function rangesFor(text: string, headings: Heading[]): Omit<Section, 'address'>[] {
  return headings.map((h, i) => {
    let end = text.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) {
        end = headings[j]!.start;
        break;
      }
    }
    return { level: h.level, heading: h.text, start: h.start, end };
  });
}

/**
 * Resolve an address to one range. A trailing `[N]` line (or `index`) picks
 * the Nth match when headings repeat; otherwise more than one match is an
 * error that lists them, never a guess.
 */
export function findSection(text: string, parsed: ParsedNote, address: string, index?: number): { start: number; end: number; address: string } {
  const trimmed = address.trim();
  if (trimmed.toLowerCase() === PREAMBLE) return preamble(text, parsed);

  const parts = trimmed.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  const nth = parts.length > 0 ? /^\[(\d+)\]$/.exec(parts[parts.length - 1]!) : null;
  if (nth) parts.pop();
  const pick = index ?? (nth ? Number(nth[1]) : undefined);
  if (parts.length === 0) throw new NoteError('invalid_argument', 'A section address needs at least one heading, e.g. "## Setup".');

  const ranges = rangesFor(text, parsed.headings);
  let candidates = ranges.filter((r) => matches(r, parts[0]!));
  for (const part of parts.slice(1)) {
    candidates = ranges.filter((r) => matches(r, part) && candidates.some((c) => c.start < r.start && r.end <= c.end));
  }
  if (candidates.length > 1) {
    // An address copied from outline_note names one full path; prefer the
    // sections whose whole path is exactly it over deeper look-alikes.
    const wanted = parts.join('\n').toLowerCase();
    const exact = outline(text, parsed).filter((s) => s.address.replace(/\n\[\d+\]$/, '').toLowerCase() === wanted);
    if (exact.length > 0) candidates = candidates.filter((c) => exact.some((e) => e.start === c.start));
  }
  if (candidates.length === 0) throw new NoteError('not_found', `No section matches ${JSON.stringify(trimmed)}. Use outline_note to see this note's sections.`);
  if (pick !== undefined) {
    const chosen = candidates[pick - 1];
    if (!chosen) throw new NoteError('not_found', `Only ${candidates.length} sections match ${JSON.stringify(parts.join('\n'))}; asked for number ${pick}.`);
    return { start: chosen.start, end: chosen.end, address: trimmed };
  }
  if (candidates.length > 1) {
    throw new NoteError('ambiguous', `${candidates.length} sections match ${JSON.stringify(trimmed)}. Add the parent heading, or a last line of [1]…[${candidates.length}].`);
  }
  return { start: candidates[0]!.start, end: candidates[0]!.end, address: trimmed };
}

function matches(range: Omit<Section, 'address'>, part: string): boolean {
  const m = /^(#{1,6})\s+(.*)$/.exec(part);
  const level = m ? m[1]!.length : undefined;
  const text = (m ? m[2]! : part).trim().toLowerCase();
  return (level === undefined || range.level === level) && range.heading.toLowerCase() === text;
}

function preamble(text: string, parsed: ParsedNote): { start: number; end: number; address: string } {
  // Bear's notes open with their title line; the lead text is what follows it.
  const start = parsed.titleEnd;
  const next = parsed.headings.find((h) => h.start >= start);
  return { start, end: next ? next.start : text.length, address: PREAMBLE };
}

/** The receipt a read hands out and a write checks against (§8.4). */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
