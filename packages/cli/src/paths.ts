import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve a workspace root to the exact string a shell's own $PWD (and
 * therefore every symlink-transparent OS path comparison) will report for
 * it — e.g. macOS's /var is a symlink to /private/var, so os.tmpdir() and a
 * spawned child's $PWD disagree on the "same" directory's string form.
 * Call this ONCE per workspace root and pass the result to every class that
 * needs it (WorkspaceToolExecutor, SessionCheckpoint, ShadowGit) — they
 * compare paths against each other and against real OS/shell output, so
 * they all need to agree on the same canonical string or those comparisons
 * silently stop matching. Falls back to the raw path if realpath fails
 * (e.g. the directory doesn't exist yet) rather than throwing.
 */
export function canonicalize(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Personal, cross-project config: provider profiles, active profile, settings.
 * Overridable via HEAPCODE_HOME — lets tests run hermetically against a temp
 * dir instead of the real ~/.heapcode, and lets users relocate config.
 */
export function globalDir(): string {
  return process.env.HEAPCODE_HOME || join(homedir(), '.heapcode');
}

/** Project-scoped: conversation history, checkpoints, memory — matches the
 * existing `.heapcode/HEAPCODE.md` / `.heapcode/memory.md` convention. */
export function projectDir(cwd: string = process.cwd()): string {
  return join(cwd, '.heapcode');
}

export function configFile(): string {
  return join(globalDir(), 'config.json');
}

export function secretsFile(): string {
  return join(globalDir(), 'secrets.json');
}

/** Local-only, capped audit trail (event name + coarse metadata, never code/prompts/paths) — see audit.ts. */
export function auditFile(): string {
  return join(globalDir(), 'audit.json');
}

export function conversationsFile(cwd?: string): string {
  return join(projectDir(cwd), 'conversations.json');
}

export function permissionsFile(cwd?: string): string {
  return join(projectDir(cwd), 'permissions.json');
}

/** Shadow git's own git-dir — separate from the project's real .git, per docs/CLI_PLAN.md's ShadowGit port. */
export function shadowGitDir(cwd?: string): string {
  return join(projectDir(cwd), 'shadow-git');
}
