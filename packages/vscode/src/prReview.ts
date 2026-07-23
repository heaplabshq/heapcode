import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import type { ChatMessage, Provider } from '@heapcode/core';
import { agentToolDefinitions, WorkspaceToolExecutor } from './agent/workspaceTools.js';
import { SessionCheckpoint } from './agent/checkpoint.js';
import type { ProfileManager } from './profileManager.js';

const MAX_DIFF_CHARS = 40_000;
const MAX_REVIEW_ITERATIONS = 6;

interface GhResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs `gh` directly (no shell) — an explicit argument array, never string-interpolated, so nothing here can be an injection surface. */
function runGh(args: string[], cwd: string, stdin?: string): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.on('error', (err) => resolve({ stdout: '', stderr: String(err), code: -1 }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

interface PrInfo {
  number: number;
  title: string;
  url: string;
}

/**
 * A read-only chat-with-tools loop, self-contained (not tied to the live chat
 * transcript/webview) — adapted from ChatViewProvider's own runAskWithTools
 * for the same reason it exists there: a PR diff alone often isn't enough
 * context, letting the model read surrounding code produces a materially
 * better review than judging the diff in isolation.
 */
async function runReadOnlyReview(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  temperature: number | undefined,
  maxTokens: number,
  signal: AbortSignal,
  log: vscode.OutputChannel,
): Promise<string> {
  const root = vscode.workspace.workspaceFolders![0]!.uri;
  const readOnlyTools = agentToolDefinitions.filter((t) => t.permission === 'read' && t.name !== 'ask_user');
  const executor = new WorkspaceToolExecutor(root, new SessionCheckpoint(), 60_000);
  const convo = [...messages];

  for (let i = 0; i < MAX_REVIEW_ITERATIONS; i++) {
    const offerTools = i < MAX_REVIEW_ITERATIONS - 1;
    if (!offerTools) {
      convo.push({
        role: 'user',
        content: 'Tool access has ended for this review. Give your final, complete review now in plain text.',
      });
    }
    const res = await provider.chat({
      model,
      messages: convo,
      tools: offerTools ? readOnlyTools : undefined,
      temperature,
      maxTokens,
      signal,
    });
    if (offerTools && res.toolCalls && res.toolCalls.length > 0) {
      convo.push({
        role: 'assistant',
        content: res.content,
        toolCalls: res.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });
      for (const call of res.toolCalls) {
        const toolCall = { id: call.id, name: call.name, args: call.args };
        log.appendLine(`[pr-review] tool: ${executor.describe(toolCall)}`);
        const result = call.argsParseError
          ? {
              id: call.id,
              name: call.name,
              content: `Invalid JSON arguments: ${call.argsParseError}`,
              isError: true,
            }
          : await executor.execute(toolCall);
        convo.push({ role: 'tool', content: result.content, toolCallId: call.id });
      }
      continue;
    }
    return res.content;
  }
  return '';
}

/**
 * PLAN.md M13: review the PR for the current branch and, only with explicit
 * confirmation, post the result as a real comment via the GitHub CLI (`gh`)
 * — reusing whatever `gh auth login` session already exists rather than
 * building token storage. The generated review is always shown in an editor
 * tab before the confirm dialog; nothing is posted without that step.
 */
export async function reviewCurrentPr(profiles: ProfileManager, log: vscode.OutputChannel): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    void vscode.window.showWarningMessage('Heap Code: open a workspace folder first.');
    return;
  }
  const cwd = root.fsPath;

  const version = await runGh(['--version'], cwd);
  if (version.code !== 0) {
    void vscode.window.showErrorMessage(
      'Heap Code: the GitHub CLI ("gh") is required for PR review. Install it from https://cli.github.com, run "gh auth login", then try again.',
    );
    return;
  }

  const prView = await runGh(['pr', 'view', '--json', 'number,title,url'], cwd);
  if (prView.code !== 0) {
    void vscode.window.showWarningMessage(
      `Heap Code: no pull request found for the current branch (${prView.stderr.trim() || 'gh pr view failed'}).`,
    );
    return;
  }
  let pr: PrInfo;
  try {
    pr = JSON.parse(prView.stdout) as PrInfo;
  } catch {
    void vscode.window.showErrorMessage('Heap Code: could not parse "gh pr view" output.');
    return;
  }

  const diffRes = await runGh(['pr', 'diff', String(pr.number)], cwd);
  if (diffRes.code !== 0 || !diffRes.stdout.trim()) {
    void vscode.window.showWarningMessage('Heap Code: could not fetch a diff for this PR (no changes, or gh failed).');
    return;
  }
  let diff = diffRes.stdout;
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS);

  const { provider, profile } = await profiles.createActiveProvider();
  if (!profile.model) {
    void vscode.window.showWarningMessage(`Heap Code: profile "${profile.name}" has no model configured.`);
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Heap Code: reviewing PR #${pr.number}…`, cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());

      const messages: ChatMessage[] = [
        {
          role: 'user',
          content:
            `Review this pull request as a senior engineer: #${pr.number} "${pr.title}"\n\n` +
            'Point out bugs, edge cases, security issues, and style problems, ordered by severity. ' +
            'Read surrounding code with your tools if you need context beyond the diff itself.' +
            (truncated ? '\n\n(Diff truncated to fit context — reviewing the first part only.)' : '') +
            `\n\n\`\`\`diff\n${diff}\n\`\`\``,
        },
      ];

      let reviewText: string;
      try {
        reviewText = await runReadOnlyReview(
          provider,
          profile.agentModel || profile.model!,
          messages,
          profile.temperature,
          profile.maxTokens ?? 4096,
          abort.signal,
          log,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Heap Code: review failed — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (!reviewText.trim()) {
        void vscode.window.showWarningMessage('Heap Code: the model returned an empty review.');
        return;
      }

      const doc = await vscode.workspace.openTextDocument({
        content: `# Review of PR #${pr.number}: ${pr.title}\n${pr.url}\n\n${reviewText}`,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: false });

      const confirm = await vscode.window.showWarningMessage(
        `Post this review as a comment on PR #${pr.number}?`,
        {
          modal: true,
          detail:
            'Review the text in the editor tab that just opened before confirming — this posts publicly on GitHub and can\'t be un-sent from here.',
        },
        'Post Comment',
      );
      if (confirm !== 'Post Comment') return;

      const postRes = await runGh(['pr', 'comment', String(pr.number), '--body-file', '-'], cwd, reviewText);
      if (postRes.code !== 0) {
        void vscode.window.showErrorMessage(
          `Heap Code: failed to post the comment — ${postRes.stderr.trim() || 'unknown error'}`,
        );
        return;
      }
      const openPr = await vscode.window.showInformationMessage(
        `Heap Code: posted the review on PR #${pr.number}.`,
        'Open PR',
      );
      if (openPr === 'Open PR') void vscode.env.openExternal(vscode.Uri.parse(pr.url));
    },
  );
}
