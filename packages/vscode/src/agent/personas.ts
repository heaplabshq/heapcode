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
