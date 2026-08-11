import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills, listSkillsFormatted, loadSkill, nodeFileTree, type SkillRoots } from '../src/index.js';

/**
 * Discovery and the resource jail, on a real temp filesystem via nodeFileTree.
 *
 * Neither host had a test for any of this before the two copies merged here,
 * and the jail in particular was implemented differently on each side (the
 * CLI compared against a '/'-suffixed prefix, the extension against
 * path.sep), so it is now checked directly.
 */
let dir: string;
let roots: SkillRoots;

async function writeSkill(root: 'project' | 'personal', name: string, frontmatter: string, body = 'Body.'): Promise<string> {
  const skillDir = join(dir, root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf8');
  return skillDir;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heapcode-skills-'));
  roots = { project: nodeFileTree(join(dir, 'project')), personal: nodeFileTree(join(dir, 'personal')) };
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe('discoverSkills', () => {
  it('finds skills in both roots and tags where each came from', async () => {
    await writeSkill('project', 'deploy', 'name: deploy\ndescription: Ships it.');
    await writeSkill('personal', 'notes', 'name: notes\ndescription: Takes notes.');

    const skills = await discoverSkills(roots);
    expect(skills.map((s) => [s.name, s.source]).sort()).toEqual([
      ['deploy', 'project'],
      ['notes', 'personal'],
    ]);
  });

  it('a project skill wins a name collision with a personal one', async () => {
    await writeSkill('personal', 'review', 'name: review\ndescription: Personal version.');
    await writeSkill('project', 'review', 'name: review\ndescription: Project version.');

    const skills = await discoverSkills(roots);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.source).toBe('project');
    expect(skills[0]!.description).toBe('Project version.');
  });

  it('skips directories with no SKILL.md, and skills missing name or description', async () => {
    await mkdir(join(dir, 'project', 'empty'), { recursive: true });
    await writeSkill('project', 'nameless', 'description: No name.');
    await writeSkill('project', 'mute', 'name: mute');
    await writeSkill('project', 'good', 'name: good\ndescription: Fine.');

    expect((await discoverSkills(roots)).map((s) => s.name)).toEqual(['good']);
  });

  it('a missing skills root is empty, not an error', async () => {
    expect(await discoverSkills({ project: nodeFileTree(join(dir, 'nope')) })).toEqual([]);
    expect(await listSkillsFormatted({})).toMatch(/No skills found/);
  });
});

describe('loadSkill', () => {
  it('returns the SKILL.md body with its frontmatter stripped', async () => {
    await writeSkill('project', 'deploy', 'name: deploy\ndescription: Ships it.', 'Step one.');
    expect(await loadSkill(roots, 'deploy')).toBe('Step one.');
  });

  it('an unknown skill names the tool that lists the real ones', async () => {
    await expect(loadSkill(roots, 'nope')).rejects.toThrow(/list_skills/);
  });

  it('loads a bundled resource file from inside the skill directory', async () => {
    const skillDir = await writeSkill('project', 'deploy', 'name: deploy\ndescription: Ships it.');
    await mkdir(join(skillDir, 'ref'), { recursive: true });
    await writeFile(join(skillDir, 'ref', 'checklist.md'), 'Check this.', 'utf8');

    expect(await loadSkill(roots, 'deploy', 'ref/checklist.md')).toBe('Check this.');
    expect(await loadSkill(roots, 'deploy', './ref/checklist.md')).toBe('Check this.');
    // A '..' that stays inside the skill is fine — it's escaping that isn't.
    expect(await loadSkill(roots, 'deploy', 'ref/../ref/checklist.md')).toBe('Check this.');
  });

  it('refuses to read outside the skill directory', async () => {
    await writeSkill('project', 'deploy', 'name: deploy\ndescription: Ships it.');
    await writeSkill('project', 'secret', 'name: secret\ndescription: Not yours.');
    await writeFile(join(dir, 'project', 'outside.md'), 'nope', 'utf8');

    for (const resource of [
      '../outside.md',
      '../secret/SKILL.md',
      '../../../etc/passwd',
      'ref/../../outside.md',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '..\\outside.md',
    ]) {
      await expect(loadSkill(roots, 'deploy', resource), resource).rejects.toThrow(/escapes the skill/);
    }
  });

  it('a resource that resolves to the skill directory itself is refused too', async () => {
    await writeSkill('project', 'deploy', 'name: deploy\ndescription: Ships it.');
    await expect(loadSkill(roots, 'deploy', 'ref/..')).rejects.toThrow(/escapes the skill/);
  });

  it('a missing resource is a clear error, not an empty string', async () => {
    await writeSkill('project', 'deploy', 'name: deploy\ndescription: Ships it.');
    await expect(loadSkill(roots, 'deploy', 'ref/absent.md')).rejects.toThrow(/no resource/);
  });
});
