import * as vscode from 'vscode';
import { isAbortError } from '@heapcode/core';
import type { ServerLink } from './serverLink.js';

const MAX_DIFF_CHARS = 30_000;

// Minimal surface of the built-in vscode.git extension API.
interface GitRepository {
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
  rootUri: vscode.Uri;
}
interface GitApi {
  repositories: GitRepository[];
}
interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

function getRepository(): GitRepository | undefined {
  const gitExtension =
    vscode.extensions.getExtension<GitExtensionExports>('vscode.git')?.exports;
  const api = gitExtension?.getAPI(1);
  const repos = api?.repositories ?? [];
  if (repos.length <= 1) return repos[0];
  // Prefer the repo containing the active file.
  const active = vscode.window.activeTextEditor?.document.uri.toString();
  return repos.find((r) => active?.startsWith(r.rootUri.toString())) ?? repos[0];
}

/**
 * Everything here is host work: finding the repo through VS Code's own git
 * extension, deciding whether "the changes" means staged or the working tree,
 * and dropping the result into the commit box. The model call itself is one
 * `git/commitMessage` request — no Provider, no key, and no prompt in this
 * process (docs/phase3-protocol-design.md §4, shape 8b).
 */
export async function generateCommitMessage(
  link: ServerLink,
  log: vscode.OutputChannel,
  track?: (name: string, meta?: Record<string, unknown>) => void,
): Promise<void> {
  const repo = getRepository();
  if (!repo) {
    void vscode.window.showWarningMessage('Heap Code: no git repository found in this workspace.');
    return;
  }

  let diff = await repo.diff(true); // staged
  let scope = 'staged changes';
  if (!diff.trim()) {
    diff = await repo.diff(false);
    scope = 'working tree changes';
  }
  if (!diff.trim()) {
    void vscode.window.showInformationMessage('Heap Code: no changes to describe.');
    return;
  }
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + '\n…[diff truncated]';
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: `Heap Code: writing commit message from ${scope}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        // The editModel role redirect and the fence/quote stripping both moved
        // server-side with the call — normalizeCommitMessage sits next to the
        // prompt it belongs to now.
        const message = await link.commitMessage(diff, abort.signal);
        if (message) {
          repo.inputBox.value = message;
          track?.('commit.generated');
        }
      } catch (err) {
        if (isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        log.appendLine(`[commit] ${message}`);
        void vscode.window.showErrorMessage(`Heap Code: ${message}`);
      }
    },
  );
}
