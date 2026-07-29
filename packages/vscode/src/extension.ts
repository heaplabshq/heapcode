import * as vscode from 'vscode';
import {
  AST_GRAMMAR_FILES,
  configureAstChunker,
  formatAuditDashboard,
  McpManager,
  type IndexState,
  type McpServerConfig,
} from '@heapcode/core';
import { AgentController, registerAgentDiffProvider } from './agent/controller.js';
import { PermissionEngine } from './agent/permissions.js';
import { exportBundle, importBundle } from './bundle.js';
import { openMemoryFile } from './memory.js';
import { reviewCurrentPr } from './prReview.js';
import { ChatViewProvider } from './chatViewProvider.js';
import { ServerLink } from './serverLink.js';
import { HeapCodeActionProvider } from './codeActions.js';
import { HeapCodeCompletionProvider } from './completionProvider.js';
import { generateCommitMessage } from './gitCommit.js';
import { JsonConversationStore } from './historyStore.js';
import { trackActiveEditor, trackTerminal } from './contextCollector.js';
import { registerInlineEdit } from './inlineEdit.js';
import { ProfileManager } from './profileManager.js';
import { WorkspaceKeywordIndex } from './rag/keywordIndex.js';
import { RepoMapIndexer } from './rag/repoMapIndexer.js';
import { RetentionTracker } from './retentionTracker.js';
import { ShadowGit } from './agent/shadowGit.js';
import { Telemetry } from './telemetry.js';

/**
 * Wires up AST-aware chunking (packages/core/src/rag/astChunker.ts) — core
 * stays IDE-agnostic and never resolves its own paths, so this is the one
 * place that knows where the bundled wasm assets live. Verifies every file
 * is actually present first: a missing/corrupt wasm binary makes the
 * underlying WASM runtime abort loudly instead of failing quietly, so it's
 * far better to catch that once here than let the indexer discover it
 * per-file later. Off the activation path — never blocks `activate()`.
 */
async function enableAstChunking(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<void> {
  const wasmDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'wasm');
  try {
    await Promise.all(
      AST_GRAMMAR_FILES.map((f) => vscode.workspace.fs.stat(vscode.Uri.joinPath(wasmDir, f))),
    );
    configureAstChunker((filename) => vscode.Uri.joinPath(wasmDir, filename).fsPath);
  } catch {
    log.appendLine(
      '[rag] AST-aware chunking unavailable (missing grammar assets) — using line-window chunking.',
    );
  }
}

/** Set at the end of activate() — deactivate() flushes any debounced conversation save through it. */
let activeChatProvider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Heap Code');
  void enableAstChunking(context, log);
  const telemetry = new Telemetry(context, log);
  const track = (name: string, meta?: Record<string, unknown>) => telemetry.track(name, meta);
  const retention = new RetentionTracker(context.workspaceState, track);
  const profiles = new ProfileManager(context.secrets, log);
  const storageDir = context.storageUri ?? context.globalStorageUri;
  const store = new JsonConversationStore(storageDir);
  // Chat turns and model listing run on the core server too; this is their
  // connection, kept separate from the agent's (see ServerLink's note).
  const serverOptions = {
    clientVersion: String(context.extension.packageJSON.version ?? ''),
    daemonEntry: vscode.Uri.joinPath(context.extensionUri, 'dist', 'daemon.js').fsPath,
  };
  const link = new ServerLink(profiles, log, serverOptions);
  profiles.setModelLister((profileName) => link.listModels(profileName));
  const chatProvider = new ChatViewProvider(context.extensionUri, profiles, store, log, link, track);
  activeChatProvider = chatProvider;
  const permissions = new PermissionEngine(context.workspaceState, log, track);
  permissions.attachChatRequester((req) => chatProvider.requestPermissionInChat(req));
  // Ghost text's typing trigger retrieves from this, not from the semantic
  // index: BM25 over the same chunks, no embeddings, no model calls, no I/O
  // on the keystroke path (docs/phase3-rag-design.md §2.3).
  const keywords = new WorkspaceKeywordIndex(storageDir, log);
  const repoMap = new RepoMapIndexer(storageDir, log);
  // Settings are the extension's config source (the CLI injects a file
  // loader instead); `[mcp]` prefixing stays here so the log channel reads
  // the same as it always has.
  const mcp = new McpManager(
    () => vscode.workspace.getConfiguration('heapcode').get<Record<string, McpServerConfig>>('mcpServers', {}),
    (line) => log.appendLine(`[mcp] ${line}`),
    String(context.extension.packageJSON.version ?? ''),
  );
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (workspaceRoot?.scheme === 'file') {
    chatProvider.shadowGit = new ShadowGit(
      workspaceRoot.fsPath,
      vscode.Uri.joinPath(storageDir, 'shadow-git'),
      log,
    );
  }
  const agent = new AgentController(
    profiles,
    permissions,
    log,
    (msg) => chatProvider.postToWebview(msg),
    mcp,
    repoMap,
    track,
    chatProvider.shadowGit,
    // How this host reaches the core server. The agent loop runs there now,
    // so the extension's job on that path is to answer tool/execute,
    // permission/request, snapshot/before and key/request — see
    // docs/phase3-protocol-design.md §7.
    serverOptions,
  );
  chatProvider.agent = agent;
  chatProvider.agent.askUser = (question, options) =>
    chatProvider.askAgentQuestion(question, options);

  const ragStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  ragStatus.command = 'heapcode.buildIndex';
  /**
   * The status surface stays host-side and becomes pure rendering
   * (docs/phase3-rag-design.md §4): counts and state arrive from `rag/status`
   * and `rag/event` instead of from a local indexer.
   */
  let lastRagStatus: { state: IndexState; files: number; chunks: number; available: boolean } = {
    state: 'idle',
    files: 0,
    chunks: 0,
    available: true,
  };
  const renderRagStatus = (): void => {
    const s = lastRagStatus;
    if (!s.available) {
      // A workspace the server cannot read for itself — no index, and saying
      // "no embeddings model" would be wrong and unactionable.
      ragStatus.hide();
      return;
    }
    switch (s.state) {
      case 'no-embedder':
        ragStatus.text = '$(database) no index';
        ragStatus.tooltip =
          'Heap Code semantic index — configure an embeddings model first (status bar → Select model → Embeddings)';
        break;
      case 'indexing':
        ragStatus.text = `$(sync~spin) indexing ${s.files}`;
        ragStatus.tooltip = 'Heap Code: indexing workspace…';
        break;
      case 'error':
        ragStatus.text = '$(database) index error';
        ragStatus.tooltip = 'Heap Code: indexing failed — see the output panel. Click to retry.';
        break;
      default:
        ragStatus.text = `$(database) ${s.chunks}`;
        ragStatus.tooltip = `Heap Code semantic index: ${s.files} files / ${s.chunks} chunks. Click to re-index.`;
    }
    ragStatus.show();
  };
  const refreshRagStatus = async (): Promise<void> => {
    lastRagStatus = (await link.ragStatus()) ?? { ...lastRagStatus, available: false };
    renderRagStatus();
  };
  /**
   * Rebuild the semantic index in the server. The "no embeddings model"
   * warning stays here rather than becoming a log line: it is a setup gap the
   * user can fix, and it is what they clicked the status bar to find out.
   */
  const buildSemanticIndex = async (): Promise<void> => {
    const result = await link.ragIndex({ full: true, runId: `index-${Date.now()}` });
    if (!result) {
      await refreshRagStatus();
      if (lastRagStatus.available && lastRagStatus.state === 'no-embedder') {
        void vscode.window.showWarningMessage(
          'Heap Code: no embeddings model configured. Status bar → Select model → Embeddings (e.g. nomic-embed-text on Ollama).',
        );
      }
      return;
    }
    if (result.chunks === 0) {
      void vscode.window.showWarningMessage(
        'Heap Code: no embeddings model configured. Status bar → Select model → Embeddings (e.g. nomic-embed-text on Ollama).',
      );
    } else if (result.fresh) {
      // Decision 5 of the RAG migration: the index moved out of this
      // extension's own workspace storage into the shared project state dir,
      // so the first build after upgrading is a full rebuild rather than an
      // incremental update. Say so rather than leaving the user wondering why
      // indexing took minutes this once.
      log.appendLine(
        `[rag] built a fresh index (${result.files} files / ${result.chunks} chunks) — no existing index was ` +
          'found for this workspace, so every file was embedded',
      );
    }
    track('rag.index.built');
    await refreshRagStatus();
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'heapcode.menu';
  const completionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  completionStatus.command = 'heapcode.toggleCompletion';
  const updateStatusBar = () => {
    const profile = profiles.getActiveProfile();
    statusBar.text = `$(sparkle) ${profile.name} · ${profile.model || 'no model'}`;
    statusBar.tooltip = `Heap Code — ${profile.baseUrl}\nClick to switch profile or model`;
    statusBar.show();
    const completionsOn = vscode.workspace
      .getConfiguration('heapcode.completion')
      .get<boolean>('enable', true);
    completionStatus.text = completionsOn ? '$(zap) CC' : '$(circle-slash) CC';
    completionStatus.tooltip = `Heap Code completions: ${completionsOn ? 'on' : 'off'} — click to toggle`;
    completionStatus.show();
    chatProvider.postConfig();
  };

  context.subscriptions.push(
    log,
    telemetry,
    profiles,
    // Closes the socket to the core server; the daemon itself is shared with
    // every other window and shuts down on its own idle timer (§6).
    agent,
    // Profiles and key material are pushed at session/hello and the server
    // never reads workspace settings for itself (§2), so a settings edit has
    // to reach it as a fresh session — applied on the next run, not mid-run.
    profiles.onDidChange(() => agent.markProfilesChanged()),
    profiles.onDidChange(() => link.markProfilesChanged()),
    { dispose: () => link.dispose() },
    statusBar,
    completionStatus,
    keywords,
    repoMap,
    ragStatus,
    mcp,
    link.onRagEvent((event) => {
      if (event.kind === 'progress') {
        lastRagStatus = { ...lastRagStatus, state: 'indexing', files: event.total, available: true };
      } else {
        lastRagStatus = { state: event.state, files: event.files, chunks: event.chunks, available: true };
      }
      renderRagStatus();
    }),
    vscode.commands.registerCommand('heapcode.buildIndex', () => {
      track('command.buildIndex');
      void buildSemanticIndex();
    }),
    vscode.commands.registerCommand('heapcode.clearIndex', async () => {
      await link.ragClear();
      await refreshRagStatus();
    }),
    vscode.commands.registerCommand('heapcode.openMemory', () => openMemoryFile()),
    vscode.commands.registerCommand('heapcode.showRepoMapDebug', async () => {
      if (!repoMap.ready) {
        void vscode.window.showInformationMessage(
          'Heap Code: repo map has no files indexed yet — give it a few seconds after opening the workspace, or run "Heap Code: Build Index".',
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument({
        content: repoMap.debugRanking(),
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('heapcode.exportBundle', () => {
      track('command.exportBundle');
      return exportBundle();
    }),
    vscode.commands.registerCommand('heapcode.importBundle', () => {
      track('command.importBundle');
      return importBundle();
    }),
    vscode.commands.registerCommand('heapcode.showAuditDashboard', async () => {
      const doc = await vscode.workspace.openTextDocument({
        content: formatAuditDashboard(telemetry.auditHistory()),
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('heapcode.reviewPr', () => {
      track('command.reviewPr');
      return reviewCurrentPr(profiles, link, log);
    }),
    vscode.commands.registerCommand('heapcode.reviewPrDeep', () => {
      track('command.reviewPrDeep');
      return reviewCurrentPr(profiles, link, log, { deep: true });
    }),
    vscode.commands.registerCommand('heapcode.resetPermissions', async () => {
      const cleared = await permissions.reset();
      void vscode.window.showInformationMessage(
        `Heap Code: cleared ${cleared} stored permission grant(s) — the agent will ask again.`,
      );
    }),
    vscode.commands.registerCommand('heapcode.addMcpServer', async () => {
      const name = await vscode.window.showInputBox({
        title: 'MCP server name',
        prompt: 'A short identifier, e.g. "filesystem" or "github"',
        validateInput: (v) => (/^[\w-]+$/.test(v) ? undefined : 'Letters, digits, - and _ only'),
      });
      if (!name) return;
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'stdio (local command)', description: 'e.g. npx -y @modelcontextprotocol/server-filesystem /path', transport: 'stdio' },
          { label: 'HTTP / SSE (remote URL)', description: 'Streamable HTTP or SSE endpoint', transport: 'url' },
        ],
        { title: `MCP server "${name}" — transport` },
      );
      if (!picked) return;
      const cfg = vscode.workspace.getConfiguration('heapcode');
      const servers = { ...cfg.get<Record<string, unknown>>('mcpServers', {}) };
      if (picked.transport === 'stdio') {
        const commandLine = await vscode.window.showInputBox({
          title: 'Command to launch the server',
          prompt: 'Full command line, e.g. npx -y @modelcontextprotocol/server-filesystem /Users/me',
        });
        if (!commandLine) return;
        const [command, ...args] = commandLine.split(/\s+/);
        servers[name] = { command, args };
      } else {
        const url = await vscode.window.showInputBox({ title: 'Server URL', prompt: 'https://…' });
        if (!url) return;
        servers[name] = { url };
      }
      await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        `Heap Code: MCP server "${name}" added — its tools appear in the next agent session.`,
      );
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      // Keep chat state (incl. live agent transcripts) across sidebar switches.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    profiles.onDidChange(updateStatusBar),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('heapcode')) updateStatusBar();
    }),
    trackActiveEditor(() => chatProvider.postActiveFile()),
    trackTerminal(),
    vscode.window.onDidChangeActiveTextEditor(() => chatProvider.postActiveFile()),
    vscode.window.onDidChangeTextEditorSelection(() => chatProvider.postActiveFile()),

    vscode.commands.registerCommand('heapcode.openChat', () => {
      void vscode.commands.executeCommand('workbench.view.extension.heapcode');
    }),
    vscode.commands.registerCommand('heapcode.menu', () => profiles.menuFlow()),
    vscode.commands.registerCommand('heapcode.selectProfile', () => profiles.selectProfileFlow()),
    vscode.commands.registerCommand('heapcode.addProfile', () => profiles.addProfileFlow()),
    vscode.commands.registerCommand('heapcode.selectModel', () => profiles.selectModelFlow()),
    vscode.commands.registerCommand('heapcode.setApiKey', () => profiles.setApiKeyFlow()),

    vscode.commands.registerCommand('heapcode.explain', () => {
      track('command.explain');
      void chatProvider.sendFromCommand('/explain');
    }),
    vscode.commands.registerCommand('heapcode.fix', () => {
      track('command.fix');
      void chatProvider.sendFromCommand('/fix @problems');
    }),
    vscode.commands.registerCommand('heapcode.refactor', () => {
      track('command.refactor');
      void chatProvider.sendFromCommand('/refactor');
    }),
    vscode.commands.registerCommand('heapcode.optimize', () => {
      track('command.optimize');
      void chatProvider.sendFromCommand('/optimize');
    }),
    vscode.commands.registerCommand('heapcode.generateTests', () => {
      track('command.generateTests');
      void chatProvider.sendFromCommand('/test');
    }),
    vscode.commands.registerCommand('heapcode.generateDocs', () => {
      track('command.generateDocs');
      void chatProvider.sendFromCommand('/docs');
    }),
    vscode.commands.registerCommand('heapcode.reviewCode', () => {
      track('command.reviewCode');
      void chatProvider.sendFromCommand('/review');
    }),
    vscode.commands.registerCommand('heapcode.securityReview', () => {
      track('command.securityReview');
      void chatProvider.sendFromCommand('/security-review');
    }),
    vscode.commands.registerCommand('heapcode.generateCommitMessage', () =>
      generateCommitMessage(link, log, track),
    ),

    vscode.languages.registerCodeActionsProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      new HeapCodeActionProvider(),
      HeapCodeActionProvider.metadata,
    ),

    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      new HeapCodeCompletionProvider(profiles, log, link, keywords.inner),
    ),
    vscode.commands.registerCommand('heapcode.toggleCompletion', async () => {
      const cfg = vscode.workspace.getConfiguration('heapcode.completion');
      const next = !cfg.get<boolean>('enable', true);
      track('command.toggleCompletion', { enabled: next });
      await cfg.update('enable', next, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('heapcode.triggerCompletion', () => {
      track('command.triggerCompletion');
      return vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }),
    // Fired via the `command` VS Code attaches to an accepted InlineCompletionItem
    // (completionProvider.ts) — not user-invoked.
    vscode.commands.registerCommand(
      'heapcode.completionAccepted',
      (uri: string, text: string) => {
        track('completion.accepted');
        retention.watch('completion', vscode.Uri.parse(uri), text);
      },
    ),
    vscode.workspace.onDidSaveTextDocument((document) => retention.checkOnSave(document)),
  );

  registerInlineEdit(context, profiles, log, link, track, retention);
  registerAgentDiffProvider(context);

  renderRagStatus();
  if (vscode.workspace.getConfiguration('heapcode.rag').get<boolean>('autoIndex', true)) {
    // Background, off the activation path. This is the first thing in a plain
    // editor window that reaches the server, so autoIndex is now also what
    // decides whether a window starts the daemon it would otherwise only
    // start on the first chat message or agent run. Turning the setting off
    // restores the fully-lazy behavior.
    setTimeout(() => void buildSemanticIndex(), 5_000);
  }
  // Repo map needs no embeddings model, but stays off the activation path too.
  setTimeout(() => void repoMap.buildIndex(), 5_000);
  // Neither does the keyword index — it is the one retrieval path that works
  // with no model configured at all, so it is never gated on rag.autoIndex.
  setTimeout(() => void keywords.init().then(() => keywords.buildIndex()), 5_000);

  updateStatusBar();
  track('extension.activated');
  log.appendLine('Heap Code activated.');
}

export function deactivate(): Thenable<void> | undefined {
  return activeChatProvider?.flushPendingSave();
}
