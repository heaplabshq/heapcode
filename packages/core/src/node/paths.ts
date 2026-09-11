import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a project's personal state lives, in the one place every host agrees.
 *
 * These moved here from `@heapcode/host` so the VS Code extension can reach
 * them. It depends on core alone, deliberately — a workspace may be remote or
 * virtual, so it reads through `vscode.workspace.fs` rather than Node's — but
 * the *path* it should read is the one the CLI writes, and keeping two
 * implementations of that is how the two silently stopped sharing a
 * conversation history. `@heapcode/host` re-exports these, so nothing on that
 * side changed, and the logic below is unchanged from where it lived.
 */

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
 * A stable, readable-but-collision-safe directory name for a project's
 * session state.
 *
 * The readable half is the absolute path with its separators flattened, so
 * on Windows it starts life containing the drive's colon (`C:-Users-...`) —
 * and `:` is illegal in a Windows filename, which made every `mkdir` under
 * `~/.heapcode/projects/` fail with a bare ENOENT. Everything Windows
 * forbids (`<>:"|?*` and control characters) is folded to `-` here; the
 * hash suffix, which is taken from the untouched path, keeps two projects
 * that flatten to the same readable name apart. Kept unconditional rather
 * than `platform === 'win32'`-only so one machine's directory names don't
 * depend on which host process created them first.
 *
 * MUST stay identical to packages/core/src/server/address.ts's copy — see
 * the note there.
 */
export function projectStateKey(root: string): string {
  const abs = canonicalize(root);
  const readable = abs
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 80);
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

/** One project's conversation history, shared by every host on this machine. */
export function conversationsFile(root?: string): string {
  return join(projectStateDir(root), 'conversations.json');
}
