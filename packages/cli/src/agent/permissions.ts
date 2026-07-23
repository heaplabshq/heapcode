import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PermissionChoice, PermissionClass, ToolCall, ToolDefinition } from '@heapcode/core';

export type PermissionRequester = (req: {
  description: string;
  permission: PermissionClass;
  allowPersist: boolean;
}) => Promise<PermissionChoice>;

interface PersistedGrants {
  [key: string]: 'always';
}

/**
 * Node-native port of packages/vscode/src/agent/permissions.ts's
 * PermissionEngine — same Allow Once / Session / Always / Deny semantics,
 * Safe Mode, and per-(permission-class, tool) grant key, with persisted
 * "Always" grants in a project-scoped JSON file instead of vscode.Memento
 * (workspaceState there, so per-project here matches the same scope).
 */
export class PermissionEngine {
  private sessionAllowed = new Set<string>();
  private requester?: PermissionRequester;
  private grants: PersistedGrants = {};
  private loaded = false;

  constructor(
    private readonly grantsFile: string,
    private readonly safeMode: () => boolean = () => false,
    private readonly log: (message: string) => void = () => {},
    private readonly track?: (name: string, meta?: Record<string, unknown>) => void,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.grants = JSON.parse(await readFile(this.grantsFile, 'utf8')) as PersistedGrants;
    } catch {
      this.grants = {};
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.grantsFile), { recursive: true });
    await writeFile(this.grantsFile, JSON.stringify(this.grants, null, 2), 'utf8');
  }

  /** Clear all persisted "Always Allow" grants (and session grants). */
  async reset(): Promise<number> {
    this.sessionAllowed.clear();
    await this.load();
    const cleared = Object.keys(this.grants).length;
    this.grants = {};
    await this.persist();
    return cleared;
  }

  attachRequester(requester: PermissionRequester): void {
    this.requester = requester;
  }

  resetSession(): void {
    this.sessionAllowed.clear();
  }

  async request(call: ToolCall, tool: ToolDefinition, description: string): Promise<boolean> {
    if (tool.permission === 'read') return true;
    await this.load();

    const key = `${tool.permission}.${call.name}`;
    const audit = (decision: string) =>
      this.track?.('permission.decision', { tool: call.name, permission: tool.permission, decision });

    if (!this.safeMode()) {
      if (this.sessionAllowed.has(key)) {
        this.log(`[perm] auto-allowed (session grant): ${description}`);
        audit('auto-session');
        return true;
      }
      if (this.grants[key] === 'always') {
        this.log(`[perm] auto-allowed (persisted "Always" grant — reset via /permissions reset): ${description}`);
        audit('auto-always');
        return true;
      }
    }

    const allowPersist = tool.permission !== 'destructive' && !this.safeMode();
    if (!this.requester) {
      // No UI attached (shouldn't happen in practice) — fail closed, not open.
      audit('deny-no-requester');
      return false;
    }
    const choice = await this.requester({ description, permission: tool.permission, allowPersist });
    audit(choice);

    switch (choice) {
      case 'allow':
        return true;
      case 'session':
        this.sessionAllowed.add(key);
        return true;
      case 'always':
        this.grants[key] = 'always';
        await this.persist();
        return true;
      default:
        return false;
    }
  }
}
