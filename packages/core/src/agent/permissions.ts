import type { PermissionChoice } from '../protocol.js';
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
    if (tool.permission === 'read') return true;

    const safeMode = this.opts.safeMode?.() ?? false;
    const key = `${tool.permission}.${call.name}`;

    // Coarse metadata only (tool name + permission class + decision) — never
    // the description text, which can carry command args and file paths.
    const audit = (decision: string): void =>
      this.opts.track?.('permission.decision', { tool: call.name, permission: tool.permission, decision });

    if (!safeMode) {
      if (this.sessionAllowed.has(key)) {
        this.opts.log?.(`[perm] auto-allowed (session grant): ${description}`);
        audit('auto-session');
        return true;
      }
      if (await this.opts.grants.has(key)) {
        const hint = this.opts.resetHint ? ` — reset via ${this.opts.resetHint}` : '';
        this.opts.log?.(`[perm] auto-allowed (persisted "Always" grant${hint}): ${description}`);
        audit('auto-always');
        return true;
      }
    }

    const req: PermissionRequest = {
      description,
      permission: tool.permission,
      // A destructive action is never made permanent — the user re-confirms every time.
      allowPersist: tool.permission !== 'destructive' && !safeMode,
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
        return true;
      default:
        return false;
    }
  }
}
