import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  buildInlineEditMessages,
  extractFirstCodeBlock,
  findBestMatch,
  isAbortError,
  minIndent,
  reindent,
} from '@cortex/core';
import type { ProfileManager } from './profileManager.js';

const SCHEME = 'cortex-proposal';
const CONTEXT_LINES = 40;

const proposals = new Map<string, string>();

class ProposalContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return proposals.get(uri.path) ?? '';
  }
}

export function registerInlineEdit(
  context: vscode.ExtensionContext,
  profiles: ProfileManager,
  log: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ProposalContentProvider()),
    vscode.commands.registerCommand('cortex.inlineEdit', () => inlineEdit(profiles, log)),
  );
}

async function inlineEdit(profiles: ProfileManager, log: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Cortex: open a file to use inline edit.');
    return;
  }

  // Empty selection → edit the current line.
  let range: vscode.Range = editor.selection;
  if (editor.selection.isEmpty) {
    range = editor.document.lineAt(editor.selection.active.line).range;
  }

  const instruction = await vscode.window.showInputBox({
    title: 'Cortex: Edit selection',
    prompt: 'e.g. "add error handling", "convert to async/await", "fix the bug"',
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const document = editor.document;
  const selectedCode = document.getText(range);
  const prefixStart = Math.max(0, range.start.line - CONTEXT_LINES);
  const suffixEnd = Math.min(document.lineCount - 1, range.end.line + CONTEXT_LINES);
  const prefix = document.getText(
    new vscode.Range(prefixStart, 0, range.start.line, range.start.character),
  );
  const suffix = document.getText(
    new vscode.Range(range.end, document.lineAt(suffixEnd).range.end),
  );

  const response = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Cortex: generating edit…',
      cancellable: true,
    },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        const { provider, profile } = await profiles.createActiveProvider();
        const result = await provider.chat({
          model: profile.model,
          messages: buildInlineEditMessages({
            instruction,
            selectedCode,
            languageId: document.languageId,
            filePath: vscode.workspace.asRelativePath(document.uri, false),
            prefix,
            suffix,
          }),
          temperature: 0,
          maxTokens: profile.maxTokens,
          signal: abort.signal,
        });
        return result.content;
      } catch (err) {
        if (isAbortError(err)) return undefined;
        throw err;
      }
    },
  ).then(
    (content) => content,
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.appendLine(`[inline-edit] ${message}`);
      void vscode.window.showErrorMessage(`Cortex: ${message}`);
      return undefined;
    },
  );
  if (response === undefined) return;

  let newCode = extractFirstCodeBlock(response) ?? response.trim();
  newCode = reindent(newCode, minIndent(selectedCode));
  if (newCode === selectedCode) {
    void vscode.window.showInformationMessage('Cortex: the model proposed no changes.');
    return;
  }

  await proposeEdit(editor, range, newCode, `Cortex: ${instruction}`);
}

/**
 * Shared review pipeline: native diff of current file vs proposal, then
 * Accept applies the range replacement as a single undo step.
 * Used by inline edit (Ctrl+I) and chat's "Apply" code-block action.
 */
export async function proposeEdit(
  editor: vscode.TextEditor,
  range: vscode.Range,
  newCode: string,
  title: string,
): Promise<void> {
  const document = editor.document;
  const fullText = document.getText();
  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const proposedContent = fullText.slice(0, startOffset) + newCode + fullText.slice(endOffset);

  const key = `${randomUUID()}/${document.uri.path.split('/').pop() ?? 'file'}`;
  proposals.set(`/${key}`, proposedContent);
  const proposalUri = vscode.Uri.from({ scheme: SCHEME, path: `/${key}` });
  const versionBeforeReview = document.version;

  await vscode.commands.executeCommand('vscode.diff', document.uri, proposalUri, title, {
    preview: true,
  });

  const choice = await vscode.window.showInformationMessage(
    `Apply edit to ${vscode.workspace.asRelativePath(document.uri, false)}?`,
    { modal: false },
    'Accept',
    'Reject',
  );

  await closeDiffTab(proposalUri);
  proposals.delete(`/${key}`);
  // Put focus back on the real file — never leave it on the virtual proposal,
  // or a reflexive Cmd+S turns into a "Save As" prompt.
  await vscode.window.showTextDocument(document, {
    viewColumn: editor.viewColumn,
    preview: false,
  });

  if (choice !== 'Accept') return;

  if (document.version !== versionBeforeReview) {
    void vscode.window.showWarningMessage(
      'Cortex: the file changed while you were reviewing — edit not applied. Run it again.',
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, newCode);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage('Cortex: failed to apply the edit.');
    return;
  }
  await document.save();
}

/** Apply a chat code block: replace the selection, else fuzzy-locate it in the file. */
export async function applyCodeToEditor(code: string, log: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Cortex: open a file to apply code.');
    return;
  }
  const document = editor.document;

  if (!editor.selection.isEmpty) {
    const selected = document.getText(editor.selection);
    const adjusted = reindent(code, minIndent(selected));
    await proposeEdit(editor, editor.selection, adjusted, 'Cortex: apply code block');
    return;
  }

  const match = findBestMatch(document.getText(), code);
  if (match) {
    // The block already exists verbatim — nothing to change.
    log.appendLine('[apply] code block already present in file; inserting at cursor instead');
  }
  await editor.edit((builder) => builder.insert(editor.selection.active, code));
}

export async function insertCodeAtCursor(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Cortex: open a file to insert code.');
    return;
  }
  await editor.edit((builder) => builder.replace(editor.selection, code));
}

async function closeDiffTab(proposalUri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        input.modified.toString() === proposalUri.toString()
      ) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}
