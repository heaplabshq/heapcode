import * as vscode from 'vscode';

/** Lightbulb quick fix: send diagnostics + selection to Cortex. */
export class CortexCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(
    _document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (context.diagnostics.length === 0) return [];
    const action = new vscode.CodeAction('Fix with Cortex', vscode.CodeActionKind.QuickFix);
    action.command = { command: 'cortex.fix', title: 'Fix with Cortex' };
    return [action];
  }
}
