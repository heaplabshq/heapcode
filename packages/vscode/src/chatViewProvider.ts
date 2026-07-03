import * as vscode from 'vscode';
import {
  OpenAICompatibleProvider,
  isAbortError,
  type ChatMessage,
  type ExtensionToWebview,
  type WebviewToExtension,
} from '@cortex/core';

const API_KEY_SECRET = 'cortex.apiKey';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cortex.chatView';

  private view?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private abortController?: AbortController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToExtension) => void this.onMessage(msg));
  }

  private post(msg: ExtensionToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: WebviewToExtension): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postConfig();
        break;
      case 'send':
        await this.handleSend(msg.text);
        break;
      case 'stop':
        this.abortController?.abort();
        break;
      case 'clear':
        this.messages = [];
        break;
    }
  }

  private postConfig(): void {
    const cfg = vscode.workspace.getConfiguration('cortex');
    this.post({
      type: 'config',
      baseUrl: cfg.get<string>('baseUrl', ''),
      model: cfg.get<string>('model', ''),
    });
  }

  private async handleSend(text: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('cortex');
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    const provider = new OpenAICompatibleProvider({
      baseUrl: cfg.get<string>('baseUrl', ''),
      apiKey,
    });

    this.messages.push({ role: 'user', content: text });
    this.abortController = new AbortController();
    let assistant = '';

    try {
      const stream = provider.streamChat({
        model: cfg.get<string>('model', ''),
        messages: this.messages,
        temperature: cfg.get<number>('temperature'),
        maxTokens: cfg.get<number>('maxTokens'),
        signal: this.abortController.signal,
      });
      for await (const chunk of stream) {
        assistant += chunk.content;
        this.post({ type: 'chunk', text: chunk.content });
      }
      this.messages.push({ role: 'assistant', content: assistant });
      this.post({ type: 'done' });
    } catch (err) {
      if (isAbortError(err)) {
        // Keep the partial response in history so the conversation stays coherent.
        if (assistant) this.messages.push({ role: 'assistant', content: assistant });
        this.post({ type: 'done' });
        return;
      }
      // Drop the failed user turn so a retry doesn't duplicate it.
      this.messages.pop();
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[chat] error: ${message}`);
      this.post({ type: 'error', message });
    } finally {
      this.abortController = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Cortex Chat</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
