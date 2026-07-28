import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkills as discoverSkillsIn,
  listSkillsFormatted as listSkillsFormattedIn,
  loadSkill as loadSkillIn,
  nodeFileTree,
  type SkillInfo,
  type SkillRoots,
} from '@heapcode/core';

export type { SkillInfo };

/**
 * Skill discovery (@heapcode/core) on Node's filesystem: the workspace's
 * .claude/skills/ plus the user's ~/.claude/skills/. Everything but locating
 * those two directories is shared with the extension.
 */
function roots(root: string): SkillRoots {
  return {
    project: nodeFileTree(join(root, '.claude', 'skills')),
    personal: nodeFileTree(join(homedir(), '.claude', 'skills')),
  };
}

export function discoverSkills(root: string): Promise<SkillInfo[]> {
  return discoverSkillsIn(roots(root));
}

export function listSkillsFormatted(root: string): Promise<string> {
  return listSkillsFormattedIn(roots(root));
}

export function loadSkill(root: string, name: string, resource?: string): Promise<string> {
  return loadSkillIn(roots(root), name, resource);
}
