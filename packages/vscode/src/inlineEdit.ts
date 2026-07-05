import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  buildApplyMessages,
  buildInlineEditMessages,
  extractFirstCodeBlock,
  extractUpdatedCode,
  findBestMatch,
  isAbortError,
  minIndent,
  reindent,
} from '@heapcode/core';
import { getActiveEditor } from './contextCollector.js';
import type { ProfileManager } from './profileManager.js';

const SCHEME = 'heapcode-proposal';
const CONTEXT_LINES = 40;

const proposals = new Map<string, string>();

/** The review in progress; resolved by the diff title-bar buttons, the notification, or closing the tab. */
let pendingReview: ((accepted: boolean) => void) | undefined;

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
    vscode.commands.registerCommand('heapcode.inlineEdit', () => inlineEdit(profiles, log)),
    vscode.commands.registerCommand('heapcode.acceptEdit', () => pendingReview?.(true)),
    vscode.commands.registerCommand('heapcode.rejectEdit', () => pendingReview?.(false)),
  );
}

async function inlineEdit(profiles: ProfileManager, log: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Heap Code: open a file to use inline edit.');
    return;
  }

  // Empty selection → edit the current line.
  let range: vscode.Range = editor.selection;
  if (editor.selection.isEmpty) {
    range = editor.document.lineAt(editor.selection.active.line).range;
  }

  const instruction = await vscode.window.showInputBox({
    title: 'Heap Code: Edit selection',
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
      title: 'Heap Code: generating edit…',
      cancellable: true,
    },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        const { provider, profile } = await profiles.createActiveProvider();
        const result = await provider.chat({
          model: profile.editModel || profile.model,
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
      void vscode.window.showErrorMessage(`Heap Code: ${message}`);
      return undefined;
    },
  );
  if (response === undefined) return;

  let newCode = extractFirstCodeBlock(response) ?? response.trim();
  newCode = reindent(newCode, minIndent(selectedCode));
  if (newCode === selectedCode) {
    void vscode.window.showInformationMessage('Heap Code: the model proposed no changes.');
    return;
  }

  await proposeEdit(editor, range, newCode, `Heap Code: ${instruction}`);
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

  // Only one review at a time — cancel any previous one.
  pendingReview?.(false);

  await vscode.commands.executeCommand('vscode.diff', document.uri, proposalUri, title, {
    preview: true,
  });

  const accepted = await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      tabListener.dispose();
      resolve(value);
    };
    pendingReview = settle;

    // Closing the diff tab by hand counts as Reject.
    const tabListener = vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputTextDiff &&
          input.modified.toString() === proposalUri.toString()
        ) {
          settle(false);
        }
      }
    });

    // Review happens in the diff itself: ✓ / ✗ in its title bar, or close the
    // tab to reject. A status-bar hint replaces the old notification popup.
    vscode.window.setStatusBarMessage(
      '$(git-compare) Heap Code: review the proposed edit — ✓ accept / ✗ reject in the diff title bar',
      15_000,
    );
  });
  pendingReview = undefined;

  await closeDiffTab(proposalUri);
  proposals.delete(`/${key}`);
  // Put focus back on the real file — never leave it on the virtual proposal,
  // or a reflexive Cmd+S turns into a "Save As" prompt.
  await vscode.window.showTextDocument(document, {
    viewColumn: editor.viewColumn,
    preview: false,
  });

  if (!accepted) return;

  if (document.version !== versionBeforeReview) {
    void vscode.window.showWarningMessage(
      'Heap Code: the file changed while you were reviewing — edit not applied. Run it again.',
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, newCode);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage('Heap Code: failed to apply the edit.');
    return;
  }
  await document.save();
}

const MAX_APPLY_FILE_CHARS = 40_000;

/**
 * Apply a chat code block to the active file.
 * Preferred: a fast-apply merge model (profile.applyModel) merges the snippet
 * into the whole file. Fallbacks: replace the selection, else insert at cursor.
 */
export async function applyCodeToEditor(
  code: string,
  profiles: ProfileManager,
  log: vscode.OutputChannel,
): Promise<void> {
  const editor = getActiveEditor();
  if (!editor) {
    void vscode.window.showWarningMessage('Heap Code: open a file to apply code.');
    return;
  }
  const document = editor.document;
  const profile = profiles.getActiveProfile();

  if (profile.applyModel && document.getText().length <= MAX_APPLY_FILE_CHARS) {
    const merged = await runApplyModel(document.getText(), code, profiles, log);
    if (merged !== undefined && merged.trim() && merged !== document.getText()) {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end,
      );
      await proposeEdit(editor, fullRange, merged, 'Heap Code: apply changes');
      return;
    }
    if (merged !== undefined) {
      void vscode.window.showInformationMessage('Heap Code: apply model produced no changes.');
      return;
    }
    // Apply model failed — fall through to the simple paths.
  }

  if (!editor.selection.isEmpty) {
    const selected = document.getText(editor.selection);
    const adjusted = reindent(code, minIndent(selected));
    await proposeEdit(editor, editor.selection, adjusted, 'Heap Code: apply code block');
    return;
  }

  const match = findBestMatch(document.getText(), code);
  if (match) {
    // The block already exists verbatim — nothing to change.
    log.appendLine('[apply] code block already present in file; inserting at cursor instead');
  }
  await editor.edit((builder) => builder.insert(editor.selection.active, code));
}

async function runApplyModel(
  original: string,
  snippet: string,
  profiles: ProfileManager,
  log: vscode.OutputChannel,
): Promise<string | undefined> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Heap Code: merging changes (apply model)…',
      cancellable: true,
    },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        const { provider, profile } = await profiles.createActiveProvider();
        const res = await provider.chat({
          model: profile.applyModel!,
          messages: buildApplyMessages(original, snippet),
          temperature: 0,
          // The model must re-emit the whole file — budget generously.
          maxTokens: Math.max(4096, Math.ceil(original.length / 2)),
          signal: abort.signal,
        });
        const merged = extractUpdatedCode(res.content) ?? extractFirstCodeBlock(res.content);
        if (merged === undefined) {
          log.appendLine('[apply] apply model returned no <updated-code> block; falling back');
        }
        return merged;
      } catch (err) {
        if (!isAbortError(err)) {
          log.appendLine(`[apply] apply model failed: ${err instanceof Error ? err.message : err}`);
        }
        return undefined;
      }
    },
  );
}

export async function insertCodeAtCursor(code: string): Promise<void> {
  const editor = getActiveEditor();
  if (!editor) {
    void vscode.window.showWarningMessage('Heap Code: open a file to insert code.');
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
