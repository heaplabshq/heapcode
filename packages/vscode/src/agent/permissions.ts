import * as vscode from 'vscode';
import type { PermissionChoice, PermissionClass, ToolCall, ToolDefinition } from '@heapcode/core';

type Decision = 'always';

/**
 * Asks in the chat view (inline card, Copilot-style); a permission request
 * arrives while the chat isn't available falls back to a modal dialog.
 */
export type ChatPermissionRequester = (req: {
  description: string;
  permission: PermissionClass;
  allowPersist: boolean;
}) => Promise<PermissionChoice | undefined>;

/**
 * Ask Every Time / Allow This Session / Always Allow, per (permission class,
 * tool). Safe Mode forces asking every time. Reads never prompt.
 */
export class PermissionEngine {
  private sessionAllowed = new Set<string>();
  private chatRequester?: ChatPermissionRequester;

  constructor(
    private readonly state: vscode.Memento,
    private readonly log?: vscode.OutputChannel,
    private readonly track?: (name: string, meta?: Record<string, unknown>) => void,
  ) {}

  /** Clear all persisted "Always Allow" grants (and session grants). */
  async reset(): Promise<number> {
    this.sessionAllowed.clear();
    let cleared = 0;
    for (const key of this.state.keys()) {
      if (key.startsWith('heapcode.perm.')) {
        await this.state.update(key, undefined);
        cleared++;
      }
    }
    return cleared;
  }

  attachChatRequester(requester: ChatPermissionRequester): void {
    this.chatRequester = requester;
  }

  resetSession(): void {
    this.sessionAllowed.clear();
  }

  async request(call: ToolCall, tool: ToolDefinition, description: string): Promise<boolean> {
    if (tool.permission === 'read') return true;

    const safeMode = vscode.workspace
      .getConfiguration('heapcode.agent')
      .get<boolean>('safeMode', false);
    const key = `heapcode.perm.${tool.permission}.${call.name}`;

    // Coarse metadata only (tool name + permission class + decision) — never the
    // description text, which can carry command args/file paths (PLAN.md M13 audit trail).
    const audit = (decision: string) => this.track?.('permission.decision', { tool: call.name, permission: tool.permission, decision });

    if (!safeMode) {
      if (this.sessionAllowed.has(key)) {
        this.log?.appendLine(`[perm] auto-allowed (session grant): ${description}`);
        audit('auto-session');
        return true;
      }
      if (this.state.get<Decision>(key) === 'always') {
        this.log?.appendLine(
          `[perm] auto-allowed (persisted "Always" grant — reset via "Heap Code: Reset Agent Permissions"): ${description}`,
        );
        audit('auto-always');
        return true;
      }
    }

    const allowPersist = tool.permission !== 'destructive' && !safeMode;

    const inChat = await this.chatRequester?.({
      description,
      permission: tool.permission,
      allowPersist,
    });
    const choice = inChat ?? (await this.modalRequest(tool.permission, description, allowPersist));
    audit(choice);

    switch (choice) {
      case 'allow':
        return true;
      case 'session':
        this.sessionAllowed.add(key);
        return true;
      case 'always':
        await this.state.update(key, 'always');
        return true;
      default:
        return false;
    }
  }

  private async modalRequest(
    permission: PermissionClass,
    description: string,
    allowPersist: boolean,
  ): Promise<PermissionChoice> {
    const buttons = allowPersist
      ? (['Allow Once', 'Allow This Session', 'Always Allow'] as const)
      : (['Allow Once'] as const);
    const picked = await vscode.window.showWarningMessage(
      `Heap Code Agent wants to ${permissionLabel(permission)}`,
      { modal: true, detail: description },
      ...buttons,
    );
    switch (picked) {
      case 'Allow Once':
        return 'allow';
      case 'Allow This Session':
        return 'session';
      case 'Always Allow':
        return 'always';
      default:
        return 'deny';
    }
  }
}

function permissionLabel(p: PermissionClass): string {
  switch (p) {
    case 'write':
      return 'modify files';
    case 'execute':
      return 'run a command';
    case 'destructive':
      return 'perform a DESTRUCTIVE action';
    default:
      return p;
  }
}
