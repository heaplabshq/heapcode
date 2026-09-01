import * as vscode from 'vscode';
import { type ReviewClient, type ReviewEvent } from '@heapcode/core';
import { agentToolDefinitions, WorkspaceToolExecutor } from './agent/workspaceTools.js';
import { SessionCheckpoint } from './agent/checkpoint.js';
import type { ProfileManager } from './profileManager.js';
import type { ServerLink } from './serverLink.js';

/**
 * The review itself lives in @heapcode/core (review/prReview.ts) and now runs
 * in the core server, so the CLI's /pr-review and this command share not just
 * the passes and prompts but the process they run in. This file is only the VS
 * Code adapter: wire the host's notifications/progress/preview, execute the
 * review's read-only tools locally, and offer "Open PR" at the end.
 *
 * No Provider is built here any more — the server resolves the profile from the
 * key pushed at hello (custody note, Option A2).
 */
const VSCODE_CLIENT: ReviewClient = {
  attribution: 'the Heap Code VS Code extension',
  deepHint: 'run "Heap Code: Review Current PR (Deep, Verified)"',
};

export async function reviewCurrentPr(
  profiles: ProfileManager,
  link: ServerLink,
  log: vscode.OutputChannel,
  options?: { deep?: boolean },
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    void vscode.window.showWarningMessage('Heap Code: open a workspace folder first.');
    return;
  }

  // resolveRoleProfile, not resolveRole: this needs the model and context
  // window, never a Provider. Review is agent work, so it runs on the agent
  // role rather than on whatever chat happens to be pointing at.
  const profile = profiles.resolveRoleProfile('agent');
  if (!profile?.model) {
    void vscode.window.showWarningMessage(
      'Heap Code: no model is set for the agent. Pick one in Settings → Model roles.',
    );
    return;
  }
  const { window: contextWindow } = await profiles.contextWindowFor(profile, profile.model);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Heap Code: reviewing the current PR…', cancellable: true },
    async (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      const executor = new WorkspaceToolExecutor(root, new SessionCheckpoint(), 60_000);

      const onEvent = (event: ReviewEvent): void => {
        switch (event.kind) {
          case 'warn':
            void vscode.window.showWarningMessage(`Heap Code: ${event.message}`);
            return;
          case 'error':
            void vscode.window.showErrorMessage(`Heap Code: ${event.message}`);
            return;
          case 'log':
            log.appendLine(event.message);
            return;
          case 'progress':
            progress.report({ message: event.message });
        }
      };

      const result = await link.reviewRun(
        {
          model: profile.model,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          contextWindow,
          tools: agentToolDefinitions,
          client: VSCODE_CLIENT,
          deep: options?.deep ?? false,
        },
        {
          onEvent,
          execute: (call, signal) => executor.execute(call, signal),
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
        },
        abort.signal,
      );

      if (result.status !== 'posted') return;
      const openPr = await vscode.window.showInformationMessage(
        `Heap Code: posted the review on PR #${result.pr.number}.`,
        'Open PR',
      );
      if (openPr === 'Open PR') void vscode.env.openExternal(vscode.Uri.parse(result.pr.url));
    },
  );
}
