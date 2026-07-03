import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider.js';
import { CortexCodeActionProvider } from './codeActions.js';
import { generateCommitMessage } from './gitCommit.js';
import { JsonConversationStore } from './historyStore.js';
import { registerInlineEdit } from './inlineEdit.js';
import { ProfileManager } from './profileManager.js';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Cortex Code');
  const profiles = new ProfileManager(context.secrets, log);
  const storageDir = context.storageUri ?? context.globalStorageUri;
  const store = new JsonConversationStore(storageDir);
  const chatProvider = new ChatViewProvider(context.extensionUri, profiles, store, log);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'cortex.menu';
  const updateStatusBar = () => {
    const profile = profiles.getActiveProfile();
    statusBar.text = `$(sparkle) ${profile.name} · ${profile.model || 'no model'}`;
    statusBar.tooltip = `Cortex Code — ${profile.baseUrl}\nClick to switch profile or model`;
    statusBar.show();
    chatProvider.postConfig();
  };

  context.subscriptions.push(
    log,
    profiles,
    statusBar,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),
    profiles.onDidChange(updateStatusBar),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cortex')) updateStatusBar();
    }),

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
  );

  registerInlineEdit(context, profiles, log);

  updateStatusBar();
  log.appendLine('Cortex Code activated.');
}

export function deactivate(): void {}
