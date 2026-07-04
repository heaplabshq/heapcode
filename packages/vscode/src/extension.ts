import * as vscode from 'vscode';
import { AgentController, registerAgentDiffProvider } from './agent/controller.js';
import { McpManager } from './agent/mcp.js';
import { PermissionEngine } from './agent/permissions.js';
import { openMemoryFile } from './memory.js';
import { ChatViewProvider } from './chatViewProvider.js';
import { CortexCodeActionProvider } from './codeActions.js';
import { CortexCompletionProvider } from './completionProvider.js';
import { generateCommitMessage } from './gitCommit.js';
import { JsonConversationStore } from './historyStore.js';
import { registerInlineEdit } from './inlineEdit.js';
import { ProfileManager } from './profileManager.js';
import { RagIndexer } from './rag/indexer.js';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Cortex Code');
  const profiles = new ProfileManager(context.secrets, log);
  const storageDir = context.storageUri ?? context.globalStorageUri;
  const store = new JsonConversationStore(storageDir);
  const chatProvider = new ChatViewProvider(context.extensionUri, profiles, store, log);
  const permissions = new PermissionEngine(context.workspaceState);
  permissions.attachChatRequester((req) => chatProvider.requestPermissionInChat(req));
  const rag = new RagIndexer(profiles, storageDir, log);
  const mcp = new McpManager(log);
  chatProvider.rag = rag;
  chatProvider.agent = new AgentController(
    profiles,
    permissions,
    log,
    (msg) => chatProvider.postToWebview(msg),
    rag,
    mcp,
  );

  const ragStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  ragStatus.command = 'cortex.buildIndex';
  const updateRagStatus = () => {
    const s = rag.status();
    switch (s.state) {
      case 'no-embedder':
        ragStatus.text = '$(database) no index';
        ragStatus.tooltip =
          'Cortex semantic index — configure an embeddings model first (status bar → Select model → Embeddings)';
        break;
      case 'indexing':
        ragStatus.text = `$(sync~spin) indexing ${s.files}`;
        ragStatus.tooltip = 'Cortex: indexing workspace…';
        break;
      case 'error':
        ragStatus.text = '$(database) index error';
        ragStatus.tooltip = 'Cortex: indexing failed — see the output panel. Click to retry.';
        break;
      default:
        ragStatus.text = `$(database) ${s.chunks}`;
        ragStatus.tooltip = `Cortex semantic index: ${s.files} files / ${s.chunks} chunks. Click to re-index.`;
    }
    ragStatus.show();
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'cortex.menu';
  const completionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  completionStatus.command = 'cortex.toggleCompletion';
  const updateStatusBar = () => {
    const profile = profiles.getActiveProfile();
    statusBar.text = `$(sparkle) ${profile.name} · ${profile.model || 'no model'}`;
    statusBar.tooltip = `Cortex Code — ${profile.baseUrl}\nClick to switch profile or model`;
    statusBar.show();
    const completionsOn = vscode.workspace
      .getConfiguration('cortex.completion')
      .get<boolean>('enable', true);
    completionStatus.text = completionsOn ? '$(zap) CC' : '$(circle-slash) CC';
    completionStatus.tooltip = `Cortex completions: ${completionsOn ? 'on' : 'off'} — click to toggle`;
    completionStatus.show();
    chatProvider.postConfig();
  };

  context.subscriptions.push(
    log,
    profiles,
    statusBar,
    completionStatus,
    rag,
    ragStatus,
    mcp,
    rag.onStatus(updateRagStatus),
    vscode.commands.registerCommand('cortex.buildIndex', () => rag.buildIndex()),
    vscode.commands.registerCommand('cortex.clearIndex', () => rag.clear()),
    vscode.commands.registerCommand('cortex.openMemory', () => openMemoryFile()),
    vscode.commands.registerCommand('cortex.addMcpServer', async () => {
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
      const cfg = vscode.workspace.getConfiguration('cortex');
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
        `Cortex: MCP server "${name}" added — its tools appear in the next agent session.`,
      );
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),
    profiles.onDidChange(updateStatusBar),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cortex')) updateStatusBar();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => chatProvider.postActiveFile()),

    vscode.commands.registerCommand('cortex.openChat', () => {
      void vscode.commands.executeCommand('workbench.view.extension.cortex');
    }),
    vscode.commands.registerCommand('cortex.menu', () => profiles.menuFlow()),
    vscode.commands.registerCommand('cortex.selectProfile', () => profiles.selectProfileFlow()),
    vscode.commands.registerCommand('cortex.addProfile', () => profiles.addProfileFlow()),
    vscode.commands.registerCommand('cortex.selectModel', () => profiles.selectModelFlow()),
    vscode.commands.registerCommand('cortex.setApiKey', () => profiles.setApiKeyFlow()),

    vscode.commands.registerCommand('cortex.explain', () => chatProvider.sendFromCommand('/explain')),
    vscode.commands.registerCommand('cortex.fix', () => chatProvider.sendFromCommand('/fix @problems')),
    vscode.commands.registerCommand('cortex.refactor', () => chatProvider.sendFromCommand('/refactor')),
    vscode.commands.registerCommand('cortex.optimize', () => chatProvider.sendFromCommand('/optimize')),
    vscode.commands.registerCommand('cortex.generateTests', () => chatProvider.sendFromCommand('/test')),
    vscode.commands.registerCommand('cortex.generateDocs', () => chatProvider.sendFromCommand('/docs')),
    vscode.commands.registerCommand('cortex.reviewCode', () => chatProvider.sendFromCommand('/review')),
    vscode.commands.registerCommand('cortex.generateCommitMessage', () =>
      generateCommitMessage(profiles, log),
    ),

    vscode.languages.registerCodeActionsProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      new CortexCodeActionProvider(),
      CortexCodeActionProvider.metadata,
    ),

    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      new CortexCompletionProvider(profiles, log),
    ),
    vscode.commands.registerCommand('cortex.toggleCompletion', async () => {
      const cfg = vscode.workspace.getConfiguration('cortex.completion');
      await cfg.update('enable', !cfg.get<boolean>('enable', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('cortex.triggerCompletion', () =>
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger'),
    ),
  );

  registerInlineEdit(context, profiles, log);
  registerAgentDiffProvider(context);

  updateRagStatus();
  if (vscode.workspace.getConfiguration('cortex.rag').get<boolean>('autoIndex', true)) {
    // Background, off the activation path.
    setTimeout(() => void rag.buildIndex().then(updateRagStatus), 5_000);
  }

  updateStatusBar();
  log.appendLine('Cortex Code activated.');
}

export function deactivate(): void {}
