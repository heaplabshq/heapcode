import type { FileTree } from '../fs.js';
import { parseSkillFile } from '../skills.js';

const MAX_SKILL_CHARS = 20_000;

export interface SkillInfo {
  name: string;
  description: string;
  /** Directory name under the skills root it was found in — not a path. */
  dir: string;
  source: 'project' | 'personal';
}

/**
 * The two roots Skills are discovered from, each as a tree rooted at that
 * host's `.claude/skills` directory: `project` is the workspace's own
 * (absent when there is no workspace), `personal` is the user's
 * `~/.claude/skills`.
 */
export interface SkillRoots {
  project?: FileTree;
  personal?: FileTree;
}

async function scanSkillsDir(tree: FileTree | undefined, source: SkillInfo['source']): Promise<SkillInfo[]> {
  if (!tree) return [];
  const skills: SkillInfo[] = [];
  for (const entry of await tree.readDirectory('')) {
    if (!entry.isDirectory) continue;
    const content = await tree.readFile(`${entry.name}/SKILL.md`);
    if (content === undefined) continue;
    const parsed = parseSkillFile(content);
    if (!parsed.name || !parsed.description) continue;
    skills.push({ name: parsed.name, description: parsed.description, dir: entry.name, source });
  }
  return skills;
}

/**
 * All discovered Skills: .claude/skills/ (project) and ~/.claude/skills/
 * (personal) — the same directories Claude Code itself reads, so Skills are
 * shared with zero setup. Project skills win name collisions with personal
 * ones.
 */
export async function discoverSkills(roots: SkillRoots): Promise<SkillInfo[]> {
  const [personal, project] = await Promise.all([
    scanSkillsDir(roots.personal, 'personal'),
    scanSkillsDir(roots.project, 'project'),
  ]);
  const byName = new Map<string, SkillInfo>();
  for (const s of personal) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s);
  return [...byName.values()];
}

export async function listSkillsFormatted(roots: SkillRoots): Promise<string> {
  const skills = await discoverSkills(roots);
  if (skills.length === 0) {
    return (
      'No skills found. Add one at .claude/skills/<name>/SKILL.md (project) or ' +
      '~/.claude/skills/<name>/SKILL.md (personal).'
    );
  }
  return skills.map((s) => `- ${s.name} (${s.source}): ${s.description}`).join('\n');
}

/** Loads a Skill's SKILL.md body, or one of its bundled resource files by relative path. */
export async function loadSkill(roots: SkillRoots, name: string, resource?: string): Promise<string> {
  const skill = (await discoverSkills(roots)).find((s) => s.name === name);
  if (!skill) {
    throw new Error(`Skill "${name}" not found. Call list_skills to see available skills.`);
  }
  const tree = skill.source === 'project' ? roots.project! : roots.personal!;

  if (!resource) {
    const content = await tree.readFile(`${skill.dir}/SKILL.md`);
    if (content === undefined) throw new Error(`Skill "${name}" has no readable SKILL.md.`);
    return parseSkillFile(content).body.slice(0, MAX_SKILL_CHARS);
  }

  // Jailed to the skill's own directory — a Skill can't reference files
  // outside itself. Resolved as a pure path string rather than on disk, so
  // the check means the same thing on every host and every path separator.
  const within = resolveWithin(skill.dir, resource);
  if (!within) throw new Error(`Resource path escapes the skill's own directory: ${resource}`);
  const content = await tree.readFile(within);
  if (content === undefined) throw new Error(`Skill "${name}" has no resource "${resource}".`);
  return content.slice(0, MAX_SKILL_CHARS);
}

/**
 * `dir/resource` with `.`/`..` segments collapsed, or undefined if the result
 * climbs out of `dir` (or `resource` was absolute to begin with).
 */
function resolveWithin(dir: string, resource: string): string | undefined {
  if (resource.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(resource)) return undefined;
  const segments = [dir, ...resource.split(/[\\/]/)];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  // Must still be inside the skill's own directory, not the directory itself.
  return out.length > 1 && out[0] === dir ? out.join('/') : undefined;
}
