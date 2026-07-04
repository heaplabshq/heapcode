import * as vscode from 'vscode';
import type { PermissionChoice, PermissionClass, ToolCall, ToolDefinition } from '@cortex/core';

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

  constructor(private readonly state: vscode.Memento) {}

  attachChatRequester(requester: ChatPermissionRequester): void {
    this.chatRequester = requester;
  }

  resetSession(): void {
    this.sessionAllowed.clear();
  }

  async request(call: ToolCall, tool: ToolDefinition, description: string): Promise<boolean> {
    if (tool.permission === 'read') return true;

    const safeMode = vscode.workspace
      .getConfiguration('cortex.agent')
      .get<boolean>('safeMode', false);
    const key = `cortex.perm.${tool.permission}.${call.name}`;

    if (!safeMode) {
      if (this.sessionAllowed.has(key)) return true;
      if (this.state.get<Decision>(key) === 'always') return true;
    }

    const allowPersist = tool.permission !== 'destructive' && !safeMode;

    const inChat = await this.chatRequester?.({
      description,
      permission: tool.permission,
      allowPersist,
    });
    const choice = inChat ?? (await this.modalRequest(tool.permission, description, allowPersist));

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
      `Cortex Agent wants to ${permissionLabel(permission)}`,
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
