import type { PermissionChoice } from '../protocol.js';
import { effectivePermission } from './commandRisk.js';
import { resolvePermission, type PermissionMode } from './permissionModes.js';
import type { PermissionClass, ToolCall, ToolDefinition } from './tools.js';

export interface PermissionRequest {
  description: string;
  permission: PermissionClass;
  allowPersist: boolean;
}

/**
 * Asks the user. Returning undefined means "this channel couldn't ask" (the
 * extension's chat view isn't open, say) — not a denial — and hands off to
 * the fallback requester if the host configured one.
 */
export type PermissionRequester = (req: PermissionRequest) => Promise<PermissionChoice | undefined>;

/**
 * Where "Always Allow" grants outlive the session: a JSON file in the CLI,
 * `vscode.Memento` (workspaceState) in the extension. Keys are
 * `<permission-class>.<tool>`; any namespacing the host's storage needs is
 * the adapter's business, not this engine's.
 */
export interface PermissionGrantStore {
  /** Whether a persisted "always" grant covers `key`. */
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
  /** Drop every persisted grant, returning how many there were. */
  clear(): Promise<number>;
}

export interface PermissionEngineOptions {
  grants: PermissionGrantStore;
  /** Safe Mode forces asking every time, ignoring both grant kinds. */
  safeMode?: () => boolean;
  /**
   * The session's current permission mode, read per request so a host can let
   * the user change it mid-run (Shift+Tab) without rebuilding the engine.
   * Omitted means "default" — ask for everything but reads, which is what
   * every caller did before modes existed.
   */
  mode?: () => PermissionMode;
  log?: (message: string) => void;
  /** Coarse audit hook — see the note on `audit` below. */
  track?: (name: string, meta?: Record<string, unknown>) => void;
  /** How this host's user clears persisted grants, named in the auto-allow log line. */
  resetHint?: string;
  /**
   * Asked when the primary requester is absent or declines to ask. The
   * extension uses this for its modal dialog, behind the in-chat card; the
   * CLI has a single channel and passes none, which fails closed.
   */
  fallbackRequester?: PermissionRequester;
}

/**
 * Ask Every Time / Allow This Session / Always Allow, per (permission class,
 * tool). Safe Mode forces asking every time. Reads never prompt.
 */
export class PermissionEngine {
  private sessionAllowed = new Set<string>();
  private requester?: PermissionRequester;

  constructor(private readonly opts: PermissionEngineOptions) {}

  /** Clear all persisted "Always Allow" grants (and session grants). */
  async reset(): Promise<number> {
    this.sessionAllowed.clear();
    return this.opts.grants.clear();
  }

  /** Sets the primary channel, replacing any previous one. */
  attachRequester(requester: PermissionRequester): void {
    this.requester = requester;
  }

  resetSession(): void {
    this.sessionAllowed.clear();
  }

  async request(call: ToolCall, tool: ToolDefinition, description: string): Promise<boolean> {
    // The class a call is judged at, not the one its tool declares: a shell
    // command carries its own risk in an argument, and `run_command` is
    // `execute` whether it lists a directory or erases one (commandRisk.ts).
    // Applied before every use below, the grant key included — otherwise an
    // "Always allow run_command" granted for `npm test` would sit in front of
    // an `rm -rf`, which is how a permission system stops meaning anything.
    const permission = effectivePermission(call, tool.permission);
    if (permission === 'read') return true;

    const safeMode = this.opts.safeMode?.() ?? false;
    const key = `${permission}.${call.name}`;

    // Coarse metadata only (tool name + permission class + decision) — never
    // the description text, which can carry command args and file paths.
    const audit = (decision: string): void =>
      this.opts.track?.('permission.decision', { tool: call.name, permission, decision });

    const mode = this.opts.mode?.() ?? 'default';
    if (!safeMode) {
      // The mode is consulted before grants: it is the coarser, more
      // deliberate switch, and a user who just put the session in auto should
      // not still be prompted for something they never granted individually.
      const resolution = resolvePermission(permission, mode);
      if (resolution === 'allow') {
        this.opts.log?.(`[perm] auto-allowed (${mode} mode): ${description}`);
        audit('auto-mode');
        return true;
      }
      if (resolution === 'deny') {
        this.opts.log?.(`[perm] denied by ${mode} mode: ${description}`);
        audit('deny-mode');
        return false;
      }
      // A grant made during THIS session still stands: the user chose it
      // moments ago, in context, and re-asking would make "Allow for this
      // session" meaningless.
      if (this.sessionAllowed.has(key)) {
        this.opts.log?.(`[perm] auto-allowed (session grant): ${description}`);
        audit('auto-session');
        return true;
      }
      // A grant persisted by an EARLIER session does not. Ask mode has to
      // mean ask: a grant saved weeks ago silently auto-approving edits is
      // indistinguishable, from the user's side, from the permission system
      // being broken — which is exactly how it was reported. Persisted grants
      // still apply in the auto modes, where the user has opted into less
      // prompting for this session on purpose.
      if (mode !== 'default' && (await this.opts.grants.has(key))) {
        const hint = this.opts.resetHint ? ` — reset via ${this.opts.resetHint}` : '';
        this.opts.log?.(`[perm] auto-allowed (persisted "Always" grant${hint}): ${description}`);
        audit('auto-always');
        return true;
      }
    }

    const req: PermissionRequest = {
      description,
      permission,
      // A destructive action is never made permanent — the user re-confirms every time.
      allowPersist: permission !== 'destructive' && !safeMode,
    };
    const choice = (await this.requester?.(req)) ?? (await this.opts.fallbackRequester?.(req));
    if (choice === undefined) {
      // Nowhere to ask — fail closed, not open.
      audit('deny-no-requester');
      return false;
    }
    audit(choice);

    switch (choice) {
      case 'allow':
        return true;
      case 'session':
        this.sessionAllowed.add(key);
        return true;
      case 'always':
        await this.opts.grants.add(key);
        // Also a session grant, so the choice takes effect immediately even in
        // Ask mode, where the persisted copy is deliberately not consulted.
        // Without this, picking "Always" in the default mode would prompt
        // again on the very next call — the opposite of what it says.
        this.sessionAllowed.add(key);
        return true;
      default:
        return false;
    }
  }
}
