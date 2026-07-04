import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  lineDiffStats,
  runAgent,
  resolveCapabilities,
  type ExtensionToWebview,
  type FileEditInfo,
  type ToolCall,
} from '@cortex/core';
import { agentToolDefinitions, WorkspaceToolExecutor } from './workspaceTools.js';
import { SessionCheckpoint } from './checkpoint.js';
import { PermissionEngine } from './permissions.js';
import type { ProfileManager } from '../profileManager.js';
import type { RagIndexer } from '../rag/indexer.js';
import type { McpManager } from './mcp.js';
import { loadProjectInstructions } from '../memory.js';

export class AgentController {
  private abort?: AbortController;
  private checkpoint?: SessionCheckpoint;

  /** ask_user tool: forwards the agent's question to the chat UI; set by extension.ts. */
  askUser?: (question: string, options?: string[]) => Promise<string | undefined>;

  constructor(
    private readonly profiles: ProfileManager,
    private readonly permissions: PermissionEngine,
    private readonly log: vscode.OutputChannel,
    private readonly post: (msg: ExtensionToWebview) => void,
    private readonly rag?: RagIndexer,
    private readonly mcp?: McpManager,
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

    const fileEdits = new Map<string, FileEditInfo>();
    let lastToolStreamPost = 0;
    await this.mcp?.ensureConnected();
    const mcpTools = this.mcp?.getToolDefinitions() ?? [];
    const instructions = await loadProjectInstructions();
    const fullTask = instructions ? `${instructions}\n\n---\n\nTask: ${task}` : task;

    try {
      const outcome = await runAgent({
        provider,
        model: profile.agentModel || profile.model,
        task: fullTask,
        workspaceName: path.basename(root.fsPath),
        tools: [...agentToolDefinitions, ...mcpTools],
        nativeToolCalls: capabilities.nativeToolCalls,
        execute: async (call) => {
          if (call.name === 'ask_user') {
            const options = Array.isArray(call.args.options)
              ? call.args.options.map(String)
              : undefined;
            const answer = await this.askUser?.(String(call.args.question ?? ''), options);
            return {
              id: call.id,
              name: call.name,
              content: answer?.trim()
                ? `User answered: ${answer}`
                : 'The user did not answer. Proceed with your best judgment.',
            };
          }
          if (this.mcp?.isMcpTool(call.name)) {
            const content = await this.mcp.call(call.name, call.args);
            return { id: call.id, name: call.name, content };
          }
          const result = await executor.execute(call);
          if (!result.isError && (call.name === 'write_file' || call.name === 'edit_file')) {
            const info = await this.computeFileEdit(String(call.args.path ?? ''));
            if (info) fileEdits.set(call.id, info);
          }
          return result;
        },
        requestPermission: (call, tool) =>
          this.permissions.request(call, tool, this.describe(call, executor)),
        events: {
          onText: (text) => this.post({ type: 'agentText', text }),
          onTextDelta: (text) => this.post({ type: 'agentTextDelta', text }),
          onTextEnd: () => this.post({ type: 'agentTextEnd' }),
          onReasoningDelta: (text) => this.post({ type: 'agentReasoningDelta', text }),
          onReasoningEnd: () => this.post({ type: 'agentReasoningEnd' }),
          onToolStream: (chars) => {
            // Throttle: one progress post per ~512 chars is plenty.
            if (chars - lastToolStreamPost >= 512 || chars < lastToolStreamPost) {
              lastToolStreamPost = chars;
              this.post({ type: 'agentToolStream', chars });
            }
          },
          onPlan: (text) => this.post({ type: 'agentPlan', text }),
          onToolCall: (call) => {
            const description = this.describe(call, executor);
            this.log.appendLine(`[agent] tool: ${description}`);
            this.post({
              type: 'agentToolCall',
              id: call.id,
              name: call.name,
              description,
              terminalCommand:
                call.name === 'run_command' ? String(call.args.command ?? '') : undefined,
            });
          },
          onContextUsage: (used, window) => this.post({ type: 'contextUsage', used, window }),
          onCompaction: (before, after) => {
            this.log.appendLine(`[agent] compacted context: ~${before} → ~${after} tokens`);
            this.post({ type: 'compacted', before, after });
          },
          onToolResult: (result) =>
            this.post({
              type: 'agentToolResult',
              id: result.id,
              ok: !result.isError,
              summary: result.content.slice(0, 300),
              label: resultLabel(result.name, result.content, result.isError),
              fileEdit: fileEdits.get(result.id),
            }),
        },
        plan: cfg.get<boolean>('planFirst', true),
        maxIterations: cfg.get<number>('maxIterations', 25),
        // Unset max_tokens defaults to ~1k on some providers (e.g. NVIDIA NIM),
        // which truncates large write_file calls mid-generation.
        maxTokens: profile.maxTokens ?? 16_384,
        contextWindow: await this.profiles.contextWindowFor(
          profile,
          profile.agentModel || profile.model,
        ),
        signal: this.abort.signal,
      });
      this.log.appendLine(`[agent] finished: ${outcome}`);
      // Snapshot the agent's final version of each touched file — this is
      // what makes Reapply possible after a revert or a manual undo.
      await this.checkpoint.captureFinals();
      this.post({
        type: 'agentStatus',
        status: outcome,
        changedFiles: this.checkpoint.changedFiles(),
      });
    } finally {
      this.abort = undefined;
    }
  }

  /** +/− line counts for a just-edited file (checkpoint original vs current). */
  private async computeFileEdit(relPath: string): Promise<FileEditInfo | undefined> {
    const entry = this.checkpoint?.entryFor(relPath);
    if (!entry) return undefined;
    try {
      const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(entry.uri));
      const original = entry.original ? new TextDecoder().decode(entry.original) : '';
      const { added, removed } = lineDiffStats(original, current);
      return { path: relPath, added, removed };
    } catch {
      return undefined;
    }
  }

  private describe(call: ToolCall, executor: WorkspaceToolExecutor): string {
    if (this.mcp?.isMcpTool(call.name)) {
      return `MCP tool ${call.name.replace(/^mcp__/, '').replace('__', ': ')} ${JSON.stringify(call.args).slice(0, 120)}`;
    }
    return executor.describe(call);
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
          ? `Reverted ${reverted.length} file(s): ${reverted.join(', ')}. Use Reapply to bring any back.`
          : 'Nothing to revert.',
    });
    this.postChangedFiles();
  }

  /** Native diff: checkpointed original (left) vs the agent's result (right). */
  async diffFile(relPath: string): Promise<void> {
    const entry = this.checkpoint?.entryFor(relPath);
    if (!entry) return;
    agentOriginals.set(relPath, entry.original ?? new Uint8Array());
    const originalUri = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${relPath}` });
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      entry.uri,
      `Cortex Agent: ${relPath}`,
      { preview: true },
    );
  }

  async revertFile(relPath: string): Promise<void> {
    const ok = await this.checkpoint?.revertFile(relPath);
    if (ok) this.post({ type: 'agentText', text: `Reverted ${relPath}.` });
    this.postChangedFiles();
  }

  /** Restore the agent's version (after a Revert or a manual undo). */
  async reapplyFile(relPath: string): Promise<void> {
    const ok = await this.checkpoint?.reapplyFile(relPath);
    this.post({
      type: 'agentText',
      text: ok ? `Reapplied the agent's version of ${relPath}.` : `Could not reapply ${relPath}.`,
    });
    this.postChangedFiles();
  }

  keepFile(relPath: string): void {
    this.checkpoint?.keepFile(relPath);
    this.postChangedFiles();
  }

  private postChangedFiles(): void {
    this.post({
      type: 'agentStatus',
      status: 'done',
      changedFiles: this.checkpoint?.changedFiles() ?? [],
    });
  }
}

const ORIGINAL_SCHEME = 'cortex-agent-original';
const agentOriginals = new Map<string, Uint8Array>();

export function registerAgentDiffProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
      provideTextDocumentContent(uri: vscode.Uri): string {
        const bytes = agentOriginals.get(uri.path.slice(1));
        return bytes ? new TextDecoder().decode(bytes) : '';
      },
    }),
  );
}

function resultLabel(name: string, content: string, isError?: boolean): string {
  if (isError) return content.split('\n')[0]!.slice(0, 80);
  switch (name) {
    case 'read_file':
      return `${content.split('\n').length} lines`;
    case 'search':
    case 'semantic_search':
      return content === 'No matches.' ? 'no matches' : `${content.split('\n').length} result(s)`;
    case 'list_dir':
      return `${content.split('\n').length} entries`;
    case 'get_diagnostics':
      return content.startsWith('No errors') ? 'clean' : `${content.split('\n').length} problem(s)`;
    case 'run_command': {
      const match = /^exit code: (\S+)/.exec(content);
      return match ? `exit ${match[1]}` : 'done';
    }
    default:
      return 'done';
  }
}
