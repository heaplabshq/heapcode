import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSkillFile } from '@heapcode/core';

const MAX_SKILL_CHARS = 20_000;

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  source: 'project' | 'personal';
}

async function scanSkillsDir(dir: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    try {
      const content = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
      const parsed = parseSkillFile(content);
      if (!parsed.name || !parsed.description) continue;
      skills.push({ name: parsed.name, description: parsed.description, dir: skillDir, source });
    } catch {
      // no SKILL.md in this directory — not a skill
    }
  }
  return skills;
}

/**
 * Node-native port of packages/vscode/src/agent/skills.ts — same
 * .claude/skills/ (project) + ~/.claude/skills/ (personal) convention
 * Claude Code itself uses, via fs/promises. Project skills win name
 * collisions with personal ones.
 */
export async function discoverSkills(root: string): Promise<SkillInfo[]> {
  const personalDir = join(homedir(), '.claude', 'skills');
  const [personal, project] = await Promise.all([
    scanSkillsDir(personalDir, 'personal'),
    scanSkillsDir(join(root, '.claude', 'skills'), 'project'),
  ]);
  const byName = new Map<string, SkillInfo>();
  for (const s of personal) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s);
  return [...byName.values()];
}

export async function listSkillsFormatted(root: string): Promise<string> {
  const skills = await discoverSkills(root);
  if (skills.length === 0) {
    return (
      'No skills found. Add one at .claude/skills/<name>/SKILL.md (project) or ' +
      '~/.claude/skills/<name>/SKILL.md (personal) — the same convention Claude Code uses.'
    );
  }
  return skills.map((s) => `- ${s.name} (${s.source}): ${s.description}`).join('\n');
}

/** Loads a Skill's SKILL.md body, or one of its bundled resource files by relative path. */
export async function loadSkill(root: string, name: string, resource?: string): Promise<string> {
  const skill = (await discoverSkills(root)).find((s) => s.name === name);
  if (!skill) {
    throw new Error(`Skill "${name}" not found. Call list_skills to see available skills.`);
  }

  if (!resource) {
    const content = await readFile(join(skill.dir, 'SKILL.md'), 'utf8');
    return parseSkillFile(content).body.slice(0, MAX_SKILL_CHARS);
  }

  // Jailed to the skill's own directory — a Skill can't reference files outside itself.
  const resolved = resolve(skill.dir, resource);
  if (resolved !== skill.dir && !resolved.startsWith(skill.dir + '/')) {
    throw new Error(`Resource path escapes the skill's own directory: ${resource}`);
  }
  const content = await readFile(resolved, 'utf8');
  return content.slice(0, MAX_SKILL_CHARS);
}
