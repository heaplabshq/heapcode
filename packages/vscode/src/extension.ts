import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Cortex Code');
  const chatProvider = new ChatViewProvider(context.extensionUri, context.secrets, log);

  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),

    vscode.commands.registerCommand('cortex.openChat', () => {
      void vscode.commands.executeCommand('workbench.view.extension.cortex');
    }),

    vscode.commands.registerCommand('cortex.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'API key for your OpenAI-compatible endpoint (leave empty for local servers like Ollama)',
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      if (key === '') {
        await context.secrets.delete('cortex.apiKey');
        void vscode.window.showInformationMessage('Cortex: API key cleared.');
      } else {
        await context.secrets.store('cortex.apiKey', key);
        void vscode.window.showInformationMessage('Cortex: API key saved to secure storage.');
      }
    }),

    vscode.commands.registerCommand('cortex.clearApiKey', async () => {
      await context.secrets.delete('cortex.apiKey');
      void vscode.window.showInformationMessage('Cortex: API key cleared.');
    }),
  );

  log.appendLine('Cortex Code activated.');
}

export function deactivate(): void {}
