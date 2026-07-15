import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseSkillFile } from '@heapcode/core';

const MAX_SKILL_CHARS = 20_000;

export interface SkillInfo {
  name: string;
  description: string;
  dir: vscode.Uri;
  source: 'project' | 'personal';
}

async function scanSkillsDir(dirUri: vscode.Uri, source: SkillInfo['source']): Promise<SkillInfo[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    const skillDir = vscode.Uri.joinPath(dirUri, name);
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(skillDir, 'SKILL.md'));
      const parsed = parseSkillFile(new TextDecoder().decode(bytes));
      if (!parsed.name || !parsed.description) continue;
      skills.push({ name: parsed.name, description: parsed.description, dir: skillDir, source });
    } catch {
      // no SKILL.md in this directory — not a skill
    }
  }
  return skills;
}

/**
 * All discovered Skills: .claude/skills/ (project) and ~/.claude/skills/ (personal) —
 * the same directories Claude Code itself reads, so Skills are shared with zero setup.
 * Project skills win name collisions with personal ones.
 */
export async function discoverSkills(): Promise<SkillInfo[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const personalDir = vscode.Uri.file(path.join(os.homedir(), '.claude', 'skills'));
  const [personal, project] = await Promise.all([
    scanSkillsDir(personalDir, 'personal'),
    root ? scanSkillsDir(vscode.Uri.joinPath(root, '.claude', 'skills'), 'project') : Promise.resolve([]),
  ]);
  const byName = new Map<string, SkillInfo>();
  for (const s of personal) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s);
  return [...byName.values()];
}

export async function listSkillsFormatted(): Promise<string> {
  const skills = await discoverSkills();
  if (skills.length === 0) {
    return (
      'No skills found. Add one at .claude/skills/<name>/SKILL.md (project) or ' +
      '~/.claude/skills/<name>/SKILL.md (personal) — the same convention Claude Code uses.'
    );
  }
  return skills.map((s) => `- ${s.name} (${s.source}): ${s.description}`).join('\n');
}

/** Loads a Skill's SKILL.md body, or one of its bundled resource files by relative path. */
export async function loadSkill(name: string, resource?: string): Promise<string> {
  const skill = (await discoverSkills()).find((s) => s.name === name);
  if (!skill) {
    throw new Error(`Skill "${name}" not found. Call list_skills to see available skills.`);
  }

  if (!resource) {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(skill.dir, 'SKILL.md'));
    return parseSkillFile(new TextDecoder().decode(bytes)).body.slice(0, MAX_SKILL_CHARS);
  }

  // Jailed to the skill's own directory — a Skill can't reference files outside itself.
  const skillDirPath = skill.dir.fsPath;
  const resolved = path.resolve(skillDirPath, resource);
  if (resolved !== skillDirPath && !resolved.startsWith(skillDirPath + path.sep)) {
    throw new Error(`Resource path escapes the skill's own directory: ${resource}`);
  }
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
  return new TextDecoder().decode(bytes).slice(0, MAX_SKILL_CHARS);
}
