/**
 * Agent Skills: SKILL.md files with `name`/`description` YAML frontmatter plus a
 * markdown body, discovered from .claude/skills/ (project) and ~/.claude/skills/
 * (personal) — the exact convention Claude Code itself uses, so a Skill written
 * for either tool works in both with no changes.
 */

export interface ParsedSkill {
  name?: string;
  description?: string;
  /** SKILL.md content with the frontmatter stripped. */
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseSkillFile(content: string): ParsedSkill {
  const match = FRONT_MATTER.exec(content);
  if (!match) return { body: content.trim() };
  const front = match[1]!;
  const body = content.slice(match[0].length).trim();
  const name = /^name:\s*(.+)$/m.exec(front)?.[1];
  const description = /^description:\s*(.+)$/m.exec(front)?.[1];
  return {
    name: name ? unquote(name) : undefined,
    description: description ? unquote(description) : undefined,
    body,
  };
}
