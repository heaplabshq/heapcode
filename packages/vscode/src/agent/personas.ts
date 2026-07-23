import type { PermissionClass, ToolDefinition } from '@heapcode/core';

/**
 * A persona scopes which tools the agent is even offered — a stricter,
 * cheaper-to-reason-about restriction than relying on the permission-prompt
 * system alone (PLAN.md M9). The default ("agent") persona applies no
 * restriction and matches today's behavior exactly.
 */
export interface AgentPersona {
  id: string;
  label: string;
  description: string;
  /** If set, only tools whose permission class is in this list are offered. */
  allowedPermissions?: PermissionClass[];
  /** Appended to the task, describing the persona's focus/constraints. */
  taskAddendum?: string;
}

export const BUILTIN_PERSONAS: AgentPersona[] = [
  {
    id: 'agent',
    label: 'Agent',
    description: 'Full autonomous access — reads, edits, and runs commands.',
  },
  {
    id: 'architect',
    label: 'Architect',
    description: 'Plans and explores only — cannot edit files or run commands.',
    allowedPermissions: ['read'],
    taskAddendum:
      'You are in Architect persona: read-only tools only (no file edits, no commands). ' +
      'Explore the codebase and produce a plan, design, or recommendation — do not attempt to ' +
      'make changes; none of the tools to do so are available.',
  },
  {
    id: 'debug',
    label: 'Debug',
    description: 'Investigates and runs tests/commands, but cannot edit or delete files.',
    allowedPermissions: ['read', 'execute'],
    taskAddendum:
      'You are in Debug persona: you can read files and run commands/tests, but file-editing ' +
      'tools are not available. Investigate and report the root cause with supporting evidence — ' +
      'do not attempt a fix.',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Read-only review — reports findings without changing anything.',
    allowedPermissions: ['read'],
    taskAddendum:
      'You are in Reviewer persona: read-only tools only. Review the relevant code and report ' +
      'findings (bugs, risks, style issues) — do not attempt to fix anything; none of the tools ' +
      'to do so are available.',
  },
];

/**
 * `run_command` is declared `permission: 'execute'` so personas without
 * `write` (e.g. Debug) still get it — but a shell command can create, edit,
 * or delete files just as easily as write_file/edit_file can, which lets a
 * write-restricted persona escape its own restriction (e.g. `mkdir foo`,
 * `rm -rf foo`, `echo x > foo`). This heuristic flags commands whose
 * effect is filesystem mutation, so personas without `write` can be blocked
 * from running them even though `run_command` itself stays offered for
 * legitimate read-only/execute use (tests, git status, build, etc).
 */
const FS_MUTATING_COMMAND_RE = [
  /(?:^|[\s;&|])(mkdir|rmdir|rm|touch|cp|mv|ln|tee|truncate|chmod|chown)(?:\s|$)/,
  /(?:^|[\s;&|])sed\s+(?:-i|--in-place)/,
  /(?:^|[\s;&|])git\s+(?:add|commit|checkout|reset|clean|rm|mv|apply|stash)\b/,
  /(?:^|[\s;&|])(?:New-Item|Remove-Item|Copy-Item|Move-Item|Set-Content|Add-Content)\b/i,
  // Redirection into a real file, e.g. `echo x > out.txt` — excludes fd
  // duplication (2>&1) and the common no-op `> /dev/null`.
  /(?<!\d)>{1,2}\s*(?!&|\/dev\/null\b)\S/,
];

export function looksFilesystemMutating(command: string): boolean {
  return FS_MUTATING_COMMAND_RE.some((re) => re.test(command));
}

export function getPersona(id: string | undefined): AgentPersona {
  return BUILTIN_PERSONAS.find((p) => p.id === id) ?? BUILTIN_PERSONAS[0]!;
}

/** Restrict a tool list to what a persona allows. No restriction fields → no change. */
export function filterToolsForPersona(
  tools: ToolDefinition[],
  persona: AgentPersona,
): ToolDefinition[] {
  if (!persona.allowedPermissions) return tools;
  const allowed = new Set(persona.allowedPermissions);
  return tools.filter((t) => allowed.has(t.permission));
}

/**
 * The stricter of two personas — a restricted persona can never grant a
 * delegated sub-agent (PLAN.md M12) more access than it has itself. Without
 * this, a Debug-persona agent (read+execute, no writes) could delegate_task
 * without naming a persona and the sub-agent would default to unrestricted
 * "agent", silently escaping the very restriction the user picked Debug for.
 */
export function intersectPersonas(parent: AgentPersona, requested: AgentPersona): AgentPersona {
  if (!parent.allowedPermissions) return requested;
  if (!requested.allowedPermissions) return parent;
  return {
    ...requested,
    allowedPermissions: requested.allowedPermissions.filter((p) => parent.allowedPermissions!.includes(p)),
  };
}
