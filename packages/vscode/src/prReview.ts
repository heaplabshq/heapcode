import * as vscode from 'vscode';
import { reviewCurrentPr as runPrReview, type PrReviewHost, type ReviewClient } from '@heapcode/core';
import { agentToolDefinitions, WorkspaceToolExecutor } from './agent/workspaceTools.js';
import { SessionCheckpoint } from './agent/checkpoint.js';
import type { ProfileManager } from './profileManager.js';

/**
 * The review itself lives in @heapcode/core (review/prReview.ts) so the CLI's
 * /pr-review runs the exact same passes, prompts, and safeguards. This file
 * is only the VS Code adapter: resolve the active profile into a provider,
 * wire the host's notifications/progress/preview, and offer "Open PR" at the
 * end.
 */
const VSCODE_CLIENT: ReviewClient = {
  attribution: 'the Heap Code VS Code extension',
  deepHint: 'run "Heap Code: Review Current PR (Deep, Verified)"',
};

export async function reviewCurrentPr(
  profiles: ProfileManager,
  log: vscode.OutputChannel,
  options?: { deep?: boolean },
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    void vscode.window.showWarningMessage('Heap Code: open a workspace folder first.');
    return;
  }

  const { provider, profile } = await profiles.createActiveProvider();
  if (!profile.model) {
    void vscode.window.showWarningMessage(`Heap Code: profile "${profile.name}" has no model configured.`);
    return;
  }
  const { window: contextWindow } = await profiles.contextWindowFor(profile, profile.model);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Heap Code: reviewing the current PR…', cancellable: true },
    async (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());

      const host: PrReviewHost = {
        warn: (message) => void vscode.window.showWarningMessage(`Heap Code: ${message}`),
        error: (message) => void vscode.window.showErrorMessage(`Heap Code: ${message}`),
        log: (message) => log.appendLine(message),
        progress: (message) => progress.report({ message }),
        // The preview opens as a real editor tab before the modal — nothing
        // is posted publicly without the user having had the full text in
        // front of them.
        confirm: async ({ pr, preview, findingCount, inlineCount, plainText }) => {
          const doc = await vscode.workspace.openTextDocument({ content: preview, language: 'markdown' });
          await vscode.window.showTextDocument(doc, { preview: false });
          const action = plainText ? 'Post Comment' : 'Post Review';
          const choice = await vscode.window.showWarningMessage(
            plainText
              ? `Post this review as a comment on PR #${pr.number}?`
              : `Post this review on PR #${pr.number}? (${findingCount} finding(s), ${inlineCount} as inline comments)`,
            {
              modal: true,
              detail:
                "Review the text in the editor tab that just opened before confirming — this posts publicly on GitHub and can't be un-sent from here.",
            },
            action,
          );
          return choice === action;
        },
      };

      const result = await runPrReview({
        cwd: root.fsPath,
        provider,
        model: profile.agentModel || profile.model,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        contextWindow,
        tools: agentToolDefinitions,
        executor: new WorkspaceToolExecutor(root, new SessionCheckpoint(), 60_000),
        host,
        client: VSCODE_CLIENT,
        signal: abort.signal,
        deep: options?.deep ?? false,
      });

      if (result.status !== 'posted') return;
      const openPr = await vscode.window.showInformationMessage(
        `Heap Code: posted the review on PR #${result.pr.number}.`,
        'Open PR',
      );
      if (openPr === 'Open PR') void vscode.env.openExternal(vscode.Uri.parse(result.pr.url));
    },
  );
}
