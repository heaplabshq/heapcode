import * as vscode from 'vscode';
import type { ContextBlock } from '@cortex/core';

const MAX_FILE_CHARS = 60_000;

function workspaceRelative(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

export function collectSelection(): ContextBlock | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return undefined;
  const text = editor.document.getText(editor.selection);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  return {
    label: `Selection (${workspaceRelative(editor.document.uri)}:${start}-${end})`,
    content: text,
    priority: 1,
  };
}

export function collectActiveFile(): ContextBlock | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  let content = editor.document.getText();
  if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS);
  return {
    label: `File (${workspaceRelative(editor.document.uri)})`,
    content,
    priority: 2,
  };
}

export async function collectFolder(): Promise<ContextBlock | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const files = await vscode.workspace.findFiles(
    '**/*',
    '**/{node_modules,dist,build,target,.git,coverage,vendor,out}/**',
    500,
  );
  const listing = files
    .map((f) => workspaceRelative(f))
    .sort()
    .join('\n');
  return { label: `Workspace files (${folder.name})`, content: listing, priority: 4 };
}

export function collectProblems(): ContextBlock | undefined {
  const all = vscode.languages.getDiagnostics();
  const lines: string[] = [];
  for (const [uri, diagnostics] of all) {
    for (const d of diagnostics) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      lines.push(`${workspaceRelative(uri)}:${d.range.start.line + 1} [${sev}] ${d.message}`);
      if (lines.length >= 100) break;
    }
    if (lines.length >= 100) break;
  }
  if (lines.length === 0) return undefined;
  return { label: 'Problems (diagnostics)', content: lines.join('\n'), priority: 3 };
}

export interface MentionResult {
  blocks: ContextBlock[];
  unresolved: string[];
}

/** Resolve @mentions in a chat message into context blocks. */
export async function resolveMentions(text: string): Promise<MentionResult> {
  const mentioned = new Set([...text.matchAll(/@(\w+)/g)].map((m) => m[1]!.toLowerCase()));
  const blocks: ContextBlock[] = [];
  const unresolved: string[] = [];

  const push = (block: ContextBlock | undefined, name: string) => {
    if (block) blocks.push(block);
    else unresolved.push(`@${name}`);
  };

  if (mentioned.has('selection')) push(collectSelection(), 'selection');
  if (mentioned.has('file')) push(collectActiveFile(), 'file');
  if (mentioned.has('problems')) push(collectProblems(), 'problems');
  if (mentioned.has('folder') || mentioned.has('workspace')) {
    push(await collectFolder(), 'folder');
  }

  return { blocks, unresolved };
}
