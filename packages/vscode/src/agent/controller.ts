import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  lineDiffStats,
  runAgent,
  resolveCapabilities,
  type ExtensionToWebview,
  type FileEditInfo,
  type ToolCall,
} from '@heapcode/core';
import { agentToolDefinitions, WorkspaceToolExecutor } from './workspaceTools.js';
import { SessionCheckpoint } from './checkpoint.js';
import { PermissionEngine } from './permissions.js';
import { callLmTool, getLmToolDefinitions, getLmToolGroups, isLmTool } from './lmTools.js';
import { getActiveEditor } from '../contextCollector.js';
import type { ProfileManager } from '../profileManager.js';
import type { RagIndexer } from '../rag/indexer.js';
import type { McpManager } from './mcp.js';
import { loadProjectInstructions } from '../memory.js';

export class AgentController {
  private abort?: AbortController;
  private checkpoint?: SessionCheckpoint;

  /** ask_user tool: forwards the agent's question to the chat UI; set by extension.ts. */
  askUser?: (question: string, options?: string[]) => Promise<string | undefined>;

  /** Built-in tools grouped the way Copilot groups its own (read/search/edit/execute/other). */
  private static readonly BUILTIN_CATEGORIES: Array<{ label: string; names: string[] }> = [
    {
      label: 'Built-in · Read',
      names: ['read_file', 'list_dir', 'get_symbols', 'find_references', 'go_to_definition', 'get_diagnostics'],
    },
    { label: 'Built-in · Search', names: ['search', 'semantic_search'] },
    {
      label: 'Built-in · Edit',
      names: ['write_file', 'edit_file', 'multi_edit', 'rename_file', 'delete_file', 'create_directory'],
    },
    { label: 'Built-in · Execute', names: ['run_command'] },
    { label: 'Built-in · Skills', names: ['list_skills', 'load_skill'] },
    { label: 'Built-in · Other', names: ['ask_user', 'fetch_url'] },
  ];

  /** All tools the agent could use, grouped by source (for the composer's tools picker). */
  listToolGroups(): Array<{
    id: string;
    label: string;
    tools: Array<{ name: string; label: string; description: string }>;
  }> {
    const groups: Array<{ id: string; label: string; tools: Array<{ name: string; label: string; description: string }> }> = [];

    const byName = new Map(agentToolDefinitions.map((t) => [t.name, t]));
    for (const cat of AgentController.BUILTIN_CATEGORIES) {
      const tools = cat.names
        .map((n) => byName.get(n))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .map((t) => ({ name: t.name, label: t.name, description: t.description }));
      if (tools.length > 0) groups.push({ id: cat.label, label: cat.label, tools });
    }

    const mcpByServer = new Map<string, Array<{ name: string; label: string; description: string }>>();
    for (const t of this.mcp?.getToolDefinitions() ?? []) {
      const withoutPrefix = t.name.replace(/^mcp__/, '');
      const sep = withoutPrefix.indexOf('__');
      const server = sep >= 0 ? withoutPrefix.slice(0, sep) : withoutPrefix;
      const label = sep >= 0 ? withoutPrefix.slice(sep + 2) : withoutPrefix;
      if (!mcpByServer.has(server)) mcpByServer.set(server, []);
      mcpByServer.get(server)!.push({ name: t.name, label, description: t.description });
    }
    for (const [server, tools] of mcpByServer) {
      groups.push({ id: `mcp-${server}`, label: `MCP · ${server}`, tools });
    }

    for (const g of getLmToolGroups()) {
      groups.push({
        id: `lm-${g.label}`,
        label: g.label,
        tools: g.tools.map((t) => ({ name: t.name, label: t.label, description: t.description })),
      });
    }

    return groups;
  }

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

  async start(task: string, images?: string[]): Promise<void> {
    if (this.running) {
      this.post({ type: 'error', message: 'An agent session is already running. Stop it first.' });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.post({ type: 'error', message: 'Agent mode needs an open workspace folder.' });
      return;
    }
    const cfg = vscode.workspace.getConfiguration('heapcode.agent');
    if (!cfg.get<boolean>('enable', true)) {
      this.post({ type: 'error', message: 'Agent mode is disabled (heapcode.agent.enable).' });
      return;
    }

    const { provider, profile } = await this.profiles.resolveRole('agentModel');
    if (!profile.model) {
      this.post({ type: 'error', message: `Profile "${profile.name}" has no model configured.` });
      return;
    }
    const capabilities = resolveCapabilities(profile);
    if (images && images.length > 0 && !capabilities.vision) {
      this.post({
        type: 'error',
        message:
          `Profile "${profile.name}" is not marked vision-capable, so images can't be sent. ` +
          'If your model does support images, set "capabilities": {"vision": true} on the profile (heapcode.profiles).',
      });
      return;
    }

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

    const contextWindow = await this.profiles.contextWindowFor(
      profile,
      profile.agentModel || profile.model,
    );
    const fileEdits = new Map<string, FileEditInfo>();
    let lastToolStreamPost = 0;
    await this.mcp?.ensureConnected();
    const mcpTools = this.mcp?.getToolDefinitions() ?? [];
    const lmTools = getLmToolDefinitions();
    const activeEditor = getActiveEditor();
    const activeFilePath = activeEditor
      ? vscode.workspace.asRelativePath(activeEditor.document.uri, false)
      : undefined;
    const instructions = await loadProjectInstructions(activeFilePath);
    const fullTask = instructions ? `${instructions}\n\n---\n\nTask: ${task}` : task;

    try {
      const outcome = await runAgent({
        provider,
        model: profile.agentModel || profile.model,
        task: fullTask,
        images,
        workspaceName: path.basename(root.fsPath),
        tools: [...agentToolDefinitions, ...mcpTools, ...lmTools].filter(
          (t) => !new Set(cfg.get<string[]>('disabledTools', [])).has(t.name),
        ),
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
          if (isLmTool(call.name)) {
            try {
              const content = await callLmTool(call.name, call.args);
              return { id: call.id, name: call.name, content };
            } catch (err) {
              return {
                id: call.id,
                name: call.name,
                content: err instanceof Error ? err.message : String(err),
                isError: true,
              };
            }
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
          onContextUsage: (used, window) =>
            this.post({ type: 'contextUsage', used, window, source: contextWindow.source }),
          onCompaction: (before, after) => {
            this.log.appendLine(`[agent] compacted context: ~${before} → ~${after} tokens`);
            this.post({ type: 'compacted', before, after });
          },
          onToolResult: (result) =>
            this.post({
              type: 'agentToolResult',
              id: result.id,
              ok: !result.isError,
              summary: result.content.slice(0, TOOL_SUMMARY_CHARS),
              label: resultLabel(result.name, result.content, result.isError),
              fileEdit: fileEdits.get(result.id),
            }),
        },
        plan: cfg.get<boolean>('planFirst', true),
        maxIterations: cfg.get<number>('maxIterations', 25),
        // Unset max_tokens defaults to ~1k on some providers (e.g. NVIDIA NIM),
        // which truncates large write_file calls mid-generation. Capped at a
        // quarter of the window so small local models don't reject the request.
        maxTokens: profile.maxTokens ?? Math.min(16_384, Math.floor(contextWindow.window / 4)),
        contextWindow: contextWindow.window,
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
    if (isLmTool(call.name)) {
      return `VS Code tool ${call.name.replace(/^vslm__/, '')} ${JSON.stringify(call.args).slice(0, 120)}`;
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
      `Heap Code Agent: ${relPath}`,
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

  /** Accept every remaining (non-reverted) file at once — the "Keep all" counterpart to Revert all. */
  keepAll(): void {
    const kept = this.checkpoint?.keepAll() ?? [];
    this.post({
      type: 'agentText',
      text: kept.length > 0 ? `Kept ${kept.length} file(s): ${kept.join(', ')}.` : 'Nothing to keep.',
    });
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

const ORIGINAL_SCHEME = 'heapcode-agent-original';
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

/** How much tool output the expandable chip in the chat can show (it scrolls). */
export const TOOL_SUMMARY_CHARS = 5_000;

export function resultLabel(name: string, content: string, isError?: boolean): string {
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
