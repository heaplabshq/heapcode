import * as vscode from 'vscode';
import type { PermissionClass, ToolCall, ToolDefinition } from '@cortex/core';

type Decision = 'always';

/**
 * Ask Every Time / Allow This Session / Always Allow, per (permission class,
 * tool). Safe Mode forces asking every time. Reads never prompt.
 */
export class PermissionEngine {
  private sessionAllowed = new Set<string>();

  constructor(private readonly state: vscode.Memento) {}

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

    const label = permissionLabel(tool.permission);
    const buttons =
      tool.permission === 'destructive' || safeMode
        ? (['Allow Once'] as const)
        : (['Allow Once', 'Allow This Session', 'Always Allow'] as const);

    const choice = await vscode.window.showWarningMessage(
      `Cortex Agent wants to ${label}`,
      { modal: true, detail: description },
      ...buttons,
    );

    switch (choice) {
      case 'Allow Once':
        return true;
      case 'Allow This Session':
        this.sessionAllowed.add(key);
        return true;
      case 'Always Allow':
        await this.state.update(key, 'always');
        return true;
      default:
        return false;
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
