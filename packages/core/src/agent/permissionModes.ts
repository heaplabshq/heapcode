import { getPersona, intersectPersonas, type AgentPersona } from './personas.js';
import type { PermissionClass } from './tools.js';

/**
 * How much the agent may do without asking. Orthogonal to personas: a persona
 * says which tools are *offered* (a capability ceiling the model can see),
 * while a mode says how the permission prompts for those tools are answered.
 *
 * These four ids are already public surface as `heapcode -p --permission-mode`
 * values, so they are the vocabulary here too rather than a parallel set.
 * They live in core because every client needs the same semantics — the
 * terminal, the extension, and headless runs must not each invent their own
 * idea of what "auto" means.
 */
export const PERMISSION_MODES = ['plan', 'default', 'auto-edit', 'full-auto'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

export interface PermissionModeInfo {
  id: PermissionMode;
  /** Short name for a status line or chip. */
  label: string;
  /** One line, for a menu row or tooltip. */
  hint: string;
}

export const PERMISSION_MODE_INFO: readonly PermissionModeInfo[] = [
  { id: 'plan', label: 'Plan', hint: 'Read-only — investigate and propose, change nothing' },
  // Labelled "Confirm" rather than "Ask": the extension's composer already has
  // an Ask/Agent chip for chat-vs-agent, and two adjacent chips both reading
  // "Ask" meant two unrelated settings looked like one.
  { id: 'default', label: 'Confirm', hint: 'Ask before writing, running commands, or anything destructive' },
  { id: 'auto-edit', label: 'Auto-edit', hint: 'Apply file edits without asking; still ask to run commands' },
  { id: 'full-auto', label: 'Auto', hint: 'Edit and run without asking; still ask before destructive actions' },
];

export function getPermissionModeInfo(mode: PermissionMode): PermissionModeInfo {
  return PERMISSION_MODE_INFO.find((m) => m.id === mode) ?? PERMISSION_MODE_INFO[1]!;
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * What a mode says about one permission class, before any grant or prompt is
 * consulted.
 *
 * `ask` is deliberately not resolved here: an interactive host prompts, while
 * a non-interactive one has to fall back to a policy of its own (headless
 * denies, except under full-auto, which exists precisely to finish unattended
 * — see resolveUnattended). Collapsing `ask` into a boolean in this function
 * would force one of those two behaviors on both.
 */
export type PermissionResolution = 'allow' | 'ask' | 'deny';

export function resolvePermission(
  permission: PermissionClass,
  mode: PermissionMode,
): PermissionResolution {
  // Reads never prompt in any mode — the same rule PermissionEngine applies.
  if (permission === 'read') return 'allow';
  switch (mode) {
    case 'plan':
      // Plan mode also stops non-read tools being offered at all (see
      // applyModeToPersona), so this is the backstop for a tool that slipped
      // through — an MCP server's, say, added mid-session.
      return 'deny';
    case 'auto-edit':
      return permission === 'write' ? 'allow' : 'ask';
    case 'full-auto':
      // Destructive stays `ask` even here. Auto is one keystroke away in the
      // UIs, and an unrecoverable action taken because of a mistyped
      // Shift+Tab is a different category of mistake from an unwanted edit,
      // which the checkpoint/rewind machinery can undo.
      return permission === 'destructive' ? 'ask' : 'allow';
    default:
      return 'ask';
  }
}

/**
 * The decision for a host that cannot prompt (headless, CI). Preserves the
 * documented behavior of `--permission-mode`: full-auto is the mode you pass
 * when the run is meant to complete with nobody watching, so an `ask` there
 * resolves to allow; every other mode fails closed.
 */
export function resolveUnattended(permission: PermissionClass, mode: PermissionMode): boolean {
  const resolution = resolvePermission(permission, mode);
  if (resolution === 'allow') return true;
  if (resolution === 'deny') return false;
  return mode === 'full-auto';
}

/**
 * The next mode in the Shift+Tab cycle. Ordered least- to most-permissive so
 * repeated presses escalate predictably and wrap back to the read-only end,
 * rather than landing on "auto" by accident on the way somewhere else.
 */
export function cyclePermissionMode(mode: PermissionMode, step = 1): PermissionMode {
  const index = PERMISSION_MODES.indexOf(mode);
  const from = index === -1 ? PERMISSION_MODES.indexOf(DEFAULT_PERMISSION_MODE) : index;
  const next = (from + step + PERMISSION_MODES.length) % PERMISSION_MODES.length;
  return PERMISSION_MODES[next]!;
}

/**
 * The persona a task should actually run with under `mode`. Plan mode narrows
 * whatever persona is active to read-only by intersecting it with Architect —
 * the same mechanism that stops a restricted parent granting a sub-agent more
 * access than it holds itself, so a persona that is *already* narrower than
 * Architect stays narrower.
 */
export function applyModeToPersona(persona: AgentPersona, mode: PermissionMode): AgentPersona {
  return mode === 'plan' ? intersectPersonas(persona, getPersona('architect')) : persona;
}
