import { createHash } from 'node:crypto';
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

/**
 * Project-scoped CONFIGURATION meant to live alongside the code and be
 * shareable/committed with a team: HEAPCODE.md/memory.md/scoped instructions
 * (memory.ts) and project-scoped MCP servers (mcpConfig.ts). Analogous to a
 * CLAUDE.md/.claude/ directory — small, plain text, safe in version control.
 * Deliberately does NOT include session/cache state — see projectStateDir.
 */
export function projectConfigDir(cwd: string = process.cwd()): string {
  return join(cwd, '.heapcode');
}

/** A stable, readable-but-collision-safe directory name for a project's session state. */
function projectStateKey(root: string): string {
  const abs = canonicalize(root);
  const readable = abs.replace(/[\\/]+/g, '-').replace(/^-+/, '').slice(0, 80);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return `${readable}-${hash}`;
}

/**
 * Personal, machine-local session state for a project — conversation
 * history, permission grants, the semantic-search/repo-map caches, and
 * shadow-git checkpoints. Lives OUTSIDE the project entirely, under the
 * global `~/.heapcode/projects/<name>-<hash>/`, the same way Claude Code
 * keeps session history under `~/.claude/projects/` rather than inside your
 * repo: this is personal cache/history, not project configuration, so it
 * can never end up accidentally `git add -A`'d into a real commit and
 * doesn't clutter `ls`/Finder at the project root. Canonicalizes `root`
 * internally (idempotent) so every caller — interactive, headless, tests —
 * resolves to the same directory whether or not they pre-canonicalized it.
 */
export function projectStateDir(root: string = process.cwd()): string {
  return join(globalDir(), 'projects', projectStateKey(root));
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

export function conversationsFile(root?: string): string {
  return join(projectStateDir(root), 'conversations.json');
}

export function permissionsFile(root?: string): string {
  return join(projectStateDir(root), 'permissions.json');
}

/** Shadow git's own git-dir — separate from the project's real .git, per docs/CLI_PLAN.md's ShadowGit port. */
export function shadowGitDir(root?: string): string {
  return join(projectStateDir(root), 'shadow-git');
}
