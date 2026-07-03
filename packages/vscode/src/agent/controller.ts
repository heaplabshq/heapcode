import * as path from 'node:path';
import * as vscode from 'vscode';
import { runAgent, resolveCapabilities, type ExtensionToWebview } from '@cortex/core';
import { agentToolDefinitions, WorkspaceToolExecutor } from './workspaceTools.js';
import { SessionCheckpoint } from './checkpoint.js';
import { PermissionEngine } from './permissions.js';
import type { ProfileManager } from '../profileManager.js';
import type { RagIndexer } from '../rag/indexer.js';

export class AgentController {
  private abort?: AbortController;
  private checkpoint?: SessionCheckpoint;

  constructor(
    private readonly profiles: ProfileManager,
    private readonly permissions: PermissionEngine,
    private readonly log: vscode.OutputChannel,
    private readonly post: (msg: ExtensionToWebview) => void,
    private readonly rag?: RagIndexer,
  ) {}

  get running(): boolean {
    return this.abort !== undefined;
  }

  async start(task: string): Promise<void> {
    if (this.running) {
      this.post({ type: 'error', message: 'An agent session is already running. Stop it first.' });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.post({ type: 'error', message: 'Agent mode needs an open workspace folder.' });
      return;
    }
    const cfg = vscode.workspace.getConfiguration('cortex.agent');
    if (!cfg.get<boolean>('enable', true)) {
      this.post({ type: 'error', message: 'Agent mode is disabled (cortex.agent.enable).' });
      return;
    }

    const { provider, profile } = await this.profiles.createActiveProvider();
    if (!profile.model) {
      this.post({ type: 'error', message: `Profile "${profile.name}" has no model configured.` });
      return;
    }
    const capabilities = resolveCapabilities(profile);

    this.checkpoint = new SessionCheckpoint();
    this.permissions.resetSession();
    const executor = new WorkspaceToolExecutor(
      root,
      this.checkpoint,
      cfg.get<number>('commandTimeout', 60) * 1000,
      this.rag ? (query) => this.rag!.queryFormatted(query) : undefined,
    );
    this.abort = new AbortController();
    this.post({ type: 'agentStatus', status: 'running', changedFiles: [] });
    this.log.appendLine(
      `[agent] start (${capabilities.nativeToolCalls ? 'native tools' : 'text fallback'}): ${task}`,
    );

    try {
      const outcome = await runAgent({
        provider,
        model: profile.model,
        task,
        workspaceName: path.basename(root.fsPath),
        tools: agentToolDefinitions,
        nativeToolCalls: capabilities.nativeToolCalls,
        execute: (call) => executor.execute(call),
        requestPermission: (call, tool) =>
          this.permissions.request(call, tool, executor.describe(call)),
        events: {
          onText: (text) => this.post({ type: 'agentText', text }),
          onToolCall: (call) => {
            this.log.appendLine(`[agent] tool: ${executor.describe(call)}`);
            this.post({
              type: 'agentToolCall',
              id: call.id,
              name: call.name,
              description: executor.describe(call),
            });
          },
          onToolResult: (result) =>
            this.post({
              type: 'agentToolResult',
              id: result.id,
              ok: !result.isError,
              summary: result.content.slice(0, 300),
            }),
        },
        maxIterations: cfg.get<number>('maxIterations', 25),
        maxTokens: profile.maxTokens,
        signal: this.abort.signal,
      });
      this.log.appendLine(`[agent] finished: ${outcome}`);
      this.post({
        type: 'agentStatus',
        status: outcome,
        changedFiles: this.checkpoint.changedFiles(),
      });
    } finally {
      this.abort = undefined;
    }
  }

  stop(): void {
    this.abort?.abort();
  }

  async revert(): Promise<void> {
    const reverted = (await this.checkpoint?.revertAll()) ?? [];
    this.post({
      type: 'agentText',
      text:
        reverted.length > 0
          ? `Reverted ${reverted.length} file(s): ${reverted.join(', ')}`
          : 'Nothing to revert.',
    });
    this.post({ type: 'agentStatus', status: 'done', changedFiles: [] });
  }
}
