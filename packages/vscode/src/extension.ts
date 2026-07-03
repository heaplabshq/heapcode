import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider.js';
import { JsonConversationStore } from './historyStore.js';
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
  );

  updateStatusBar();
  log.appendLine('Cortex Code activated.');
}

export function deactivate(): void {}
