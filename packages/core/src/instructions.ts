/**
 * Path-scoped instruction files: markdown with an optional front-matter
 * `applyTo` glob (or comma-separated globs), applied only to files that match.
 * Mirrors GitHub Copilot's `*.instructions.md` convention. A file with no
 * front matter (or no `applyTo` key) applies everywhere, like a global
 * instructions file.
 */

export interface InstructionFile {
  applyTo: string[];
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseInstructionFile(content: string): InstructionFile {
  const match = FRONT_MATTER.exec(content);
  if (!match) return { applyTo: ['**'], body: content.trim() };

  const body = content.slice(match[0].length).trim();
  const applyToLine = /^applyTo:\s*(.+)$/m.exec(match[1]!);
  if (!applyToLine) return { applyTo: ['**'], body };

  const applyTo = applyToLine[1]!
    .split(',')
    .map((g) => g.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return { applyTo: applyTo.length > 0 ? applyTo : ['**'], body };
}

/** Translates a glob (`**`, `*`, `?`) into an anchored RegExp over `/`-separated paths. */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  const normalized = glob.replace(/\\/g, '/');
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        pattern += '.*';
        i++;
        if (normalized[i + 1] === '/') i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (c === '?') {
      pattern += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c!)) {
      pattern += `\\${c}`;
    } else {
      pattern += c;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchGlob(pattern: string, filePath: string): boolean {
  return globToRegExp(pattern).test(filePath.replace(/\\/g, '/'));
}

export function matchesAnyGlob(patterns: string[], filePath: string): boolean {
  return patterns.some((p) => matchGlob(p, filePath));
}
