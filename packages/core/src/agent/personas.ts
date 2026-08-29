import type { PermissionClass, ToolDefinition } from './tools.js';

/**
 * A persona scopes which tools the agent is even offered — a stricter,
 * cheaper-to-reason-about restriction than relying on the permission-prompt
 * system alone. The default ("agent") persona applies no restriction.
 *
 * Shared by both hosts: the CLI and the extension each maintained a copy of
 * this file that was identical apart from comments. Nothing here touches a
 * filesystem, an editor or a runtime, so it needs no injected seam.
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
      'You are in Architect persona: read-only tools only — no file edits, no commands. Produce a ' +
      'plan, design, or recommendation. Do not attempt changes; none of the tools to make them are ' +
      'available.\n' +
      'Read enough to be specific and stop there. A recommendation naming the three files to change ' +
      'and what to do in each is worth more than a survey of thirty, and it is what the person ' +
      'reading it can act on. Where you are unsure, say what you would check and what it would ' +
      'settle — do not keep reading until certainty arrives.',
  },
  {
    id: 'debug',
    label: 'Debug',
    description: 'Investigates and runs tests/commands, but cannot edit or delete files.',
    allowedPermissions: ['read', 'execute'],
    taskAddendum:
      'You are in Debug persona: you can read files and run commands and tests, but file-editing ' +
      'tools are not available. Find the root cause and report it with the evidence that proves it — ' +
      'the failing output, the line responsible, why that line produces that output. Do not fix it.\n' +
      'Prefer running something that would distinguish two explanations over reading more code to ' +
      'choose between them. If the evidence does not yet single one out, say which explanations are ' +
      'still open and what would separate them, rather than picking the likeliest and asserting it.',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Read-only review — reports findings without changing anything.',
    allowedPermissions: ['read'],
    taskAddendum:
      'You are in Reviewer persona: read-only tools only. Report findings — bugs, risks, and only ' +
      'then style. Do not fix anything; none of the tools to do so are available.\n' +
      'Every finding needs the input or state that triggers it and what goes wrong as a result. A ' +
      'finding you cannot describe that way is a preference, and should be marked as one or left ' +
      'out. Say plainly when you found nothing serious; padding a review with minor observations ' +
      'buries the one thing that mattered.',
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

/**
 * What the model is told when a write-restricted persona blocks a shell command
 * that looks like it would mutate files.
 *
 * Lives here, beside the check that triggers it, because it has already drifted
 * once: both hosts sent the full two-sentence text before Phase 2
 * (packages/vscode/src/agent/controller.ts:280-281 and
 * packages/cli/src/ink/App.tsx:1063-1064 at 6a8d443), and the second sentence
 * was dropped when the guard moved server-side. Two call sites re-derived it
 * independently after that, which is exactly how it went missing — so there is
 * one source now.
 *
 * The second sentence is the actionable half: without it the model knows only
 * that it was blocked, not that a different persona is the way through.
 */
export function filesystemMutatingBlockedMessage(persona: AgentPersona): string {
  return (
    'Blocked: this command looks like it would create, modify, or delete files, which the ' +
    `${persona.label} persona does not allow. Use a persona with file-editing tools instead.`
  );
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
 * delegated sub-agent more access than it has itself. Without this, a
 * Debug-persona agent (read+execute, no writes) could delegate_task without
 * naming a persona and the sub-agent would default to unrestricted "agent",
 * silently escaping the very restriction the user picked Debug for.
 */
export function intersectPersonas(parent: AgentPersona, requested: AgentPersona): AgentPersona {
  if (!parent.allowedPermissions) return requested;
  if (!requested.allowedPermissions) return parent;
  return {
    ...requested,
    allowedPermissions: requested.allowedPermissions.filter((p) => parent.allowedPermissions!.includes(p)),
  };
}
