import { join } from 'node:path';
import { globalDir, projectStateDir } from '@heapcode/core/node';

/**
 * Re-exported, not redefined. These moved to `@heapcode/core/node` so the VS
 * Code extension — which depends on core alone — resolves a project to the
 * same directory the CLI does. Everything below still builds on them.
 */
export { canonicalize, conversationsFile, globalDir, projectStateDir } from '@heapcode/core/node';

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

/**
 * Folders opened recently, for the web UI's workspace picker.
 *
 * Cross-project, so it belongs beside config.json rather than under any one
 * project's state dir — the whole point of the list is to get you from one
 * project to another.
 */
export function workspacesFile(): string {
  return join(globalDir(), 'workspaces.json');
}

/**
 * What Heap Chat has learned about the person, across every folder.
 *
 * Global rather than per-project, and that is the whole distinction from
 * `.heapcode/memory.md`: project memory is about a repo and belongs beside it,
 * where it can be committed and shared. This is about the person — how they
 * like to be helped, what they have told the assistant to remember — and
 * following them from folder to folder is the point.
 *
 * Deliberately NOT the same store. Project memory leaking into a personal
 * conversation, or personal facts leaking into a repo's committed notes, are
 * both bad, and they are bad in different ways.
 */
export function chatMemoryFile(): string {
  return join(globalDir(), 'chat-memory.json');
}

export function permissionsFile(root?: string): string {
  return join(projectStateDir(root), 'permissions.json');
}

/** Shadow git's own git-dir — separate from the project's real .git, per docs/CLI_PLAN.md's ShadowGit port. */
export function shadowGitDir(root?: string): string {
  return join(projectStateDir(root), 'shadow-git');
}
