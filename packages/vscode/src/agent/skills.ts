import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  discoverSkills as discoverSkillsIn,
  listSkillsFormatted as listSkillsFormattedIn,
  loadSkill as loadSkillIn,
  type SkillRoots,
} from '@heapcode/core';
import { uriFileTree } from '../workspaceFs.js';

/**
 * Skill discovery (@heapcode/core) on workspace.fs: the workspace's own
 * .claude/skills/ plus the user's ~/.claude/skills/. Everything but locating
 * those two directories is shared with the CLI.
 *
 * `dir` is re-expanded to a Uri here because callers (bundle.ts) walk it;
 * core deals only in names relative to a skills root, so that it never has
 * to assume a skill lives on a local filesystem.
 */
export interface SkillInfo {
  name: string;
  description: string;
  dir: vscode.Uri;
  source: 'project' | 'personal';
}

function projectSkillsUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  return root && vscode.Uri.joinPath(root, '.claude', 'skills');
}

function personalSkillsUri(): vscode.Uri {
  return vscode.Uri.file(path.join(os.homedir(), '.claude', 'skills'));
}

function roots(): SkillRoots {
  const project = projectSkillsUri();
  return {
    project: project && uriFileTree(project),
    personal: uriFileTree(personalSkillsUri()),
  };
}

export async function discoverSkills(): Promise<SkillInfo[]> {
  const project = projectSkillsUri();
  const personal = personalSkillsUri();
  const skills = await discoverSkillsIn(roots());
  return skills.map((s) => ({
    ...s,
    dir: vscode.Uri.joinPath(s.source === 'project' ? project! : personal, s.dir),
  }));
}

export function listSkillsFormatted(): Promise<string> {
  return listSkillsFormattedIn(roots());
}

export function loadSkill(name: string, resource?: string): Promise<string> {
  return loadSkillIn(roots(), name, resource);
}
