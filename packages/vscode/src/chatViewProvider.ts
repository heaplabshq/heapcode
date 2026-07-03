import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  assembleContext,
  builtinPrompts,
  isAbortError,
  parseSlashCommand,
  renderTemplate,
  type Conversation,
  type ConversationStore,
  type ExtensionToWebview,
  type PromptTemplate,
  type StoredMessage,
  type WebviewToExtension,
} from '@cortex/core';
import { collectSelection, resolveMentions } from './contextCollector.js';
import { applyCodeToEditor, insertCodeAtCursor } from './inlineEdit.js';
import type { AgentController } from './agent/controller.js';
import type { ProfileManager } from './profileManager.js';
import type { RagIndexer } from './rag/indexer.js';

const SYSTEM_PROMPT =
  'You are Cortex, an expert AI programming assistant inside the user\'s IDE. ' +
  'Be concise and technically precise. Use markdown; put code in fenced blocks with a language tag. ' +
  'Context sections (marked with "---") may accompany the user\'s message — use them, and say so if they are insufficient.';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cortex.chatView';

  private view?: vscode.WebviewView;
  private viewReady = false;
  private pendingSends: string[] = [];
  private conversation: Conversation = newConversation();
  private abortController?: AbortController;

  /** Set right after construction (controller needs this.post, we need controller). */
  agent?: AgentController;
  rag?: RagIndexer;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly profiles: ProfileManager,
    private readonly store: ConversationStore,
    private readonly log: vscode.OutputChannel,
  ) {}

  postToWebview(msg: ExtensionToWebview): void {
    this.post(msg);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToExtension) => void this.onMessage(msg));
    view.onDidDispose(() => {
      this.view = undefined;
      this.viewReady = false;
    });
  }

  /**
   * Entry point for context-menu commands and code actions: opens the chat
   * view (waiting for it to boot if needed) and runs `text` as a user turn.
   */
  async sendFromCommand(text: string): Promise<void> {
    await vscode.commands.executeCommand('cortex.chatView.focus');
    if (this.viewReady) {
      this.post({ type: 'userMessage', text });
      await this.handleSend(text);
    } else {
      this.pendingSends.push(text);
    }
  }

  /** Built-in prompts plus user prompts from `cortex.customPrompts` (later wins on collision). */
  private allPrompts(): PromptTemplate[] {
    const custom = vscode.workspace
      .getConfiguration('cortex')
      .get<PromptTemplate[]>('customPrompts', [])
      .filter((p) => p.command && p.template);
    const merged = new Map(builtinPrompts.map((p) => [p.command, p]));
    for (const p of custom) {
      merged.set(p.command.toLowerCase(), { ...p, title: p.title || p.command });
    }
    return [...merged.values()];
  }

  postConfig(): void {
    const profile = this.profiles.getActiveProfile();
    this.post({
      type: 'config',
      profile: profile.name,
      model: profile.model,
      slashCommands: this.allPrompts().map((p) => ({ command: p.command, title: p.title })),
    });
  }

  private post(msg: ExtensionToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: WebviewToExtension): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.viewReady = true;
        this.postConfig();
        const pending = this.pendingSends;
        this.pendingSends = [];
        for (const text of pending) {
          this.post({ type: 'userMessage', text });
          await this.handleSend(text);
        }
        break;
      }
      case 'send':
        await this.handleSend(msg.text);
        break;
      case 'stop':
        this.abortController?.abort();
        break;
      case 'newChat':
        await this.startNewChat();
        break;
      case 'listHistory':
        this.post({ type: 'history', items: await this.store.list() });
        break;
      case 'openConversation':
        await this.openConversation(msg.id);
        break;
      case 'deleteConversation':
        await this.store.delete(msg.id);
        this.post({ type: 'history', items: await this.store.list() });
        break;
      case 'runCommand': {
        const allowed = {
          selectProfile: 'cortex.selectProfile',
          selectModel: 'cortex.selectModel',
          setApiKey: 'cortex.setApiKey',
        } as const;
        const command = allowed[msg.command];
        if (command) void vscode.commands.executeCommand(command);
        break;
      }
      case 'insertCode':
        await insertCodeAtCursor(msg.code);
        break;
      case 'applyCode':
        await applyCodeToEditor(msg.code, this.log);
        break;
      case 'agentStart':
        await this.agent?.start(msg.task);
        break;
      case 'agentStop':
        this.agent?.stop();
        break;
      case 'agentRevert':
        await this.agent?.revert();
        break;
    }
  }

  private async startNewChat(): Promise<void> {
    this.abortController?.abort();
    if (this.conversation.messages.length > 0) {
      await this.store.save(this.conversation);
    }
    this.conversation = newConversation();
    this.post({ type: 'newChatStarted' });
  }

  private async openConversation(id: string): Promise<void> {
    const loaded = await this.store.get(id);
    if (!loaded) return;
    this.abortController?.abort();
    if (this.conversation.messages.length > 0 && this.conversation.id !== id) {
      await this.store.save(this.conversation);
    }
    this.conversation = loaded;
    this.post({
      type: 'conversation',
      id: loaded.id,
      messages: loaded.messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.display ?? m.content,
      })),
    });
  }

  /**
   * Builds the LLM-facing message: expands slash commands via the prompt
   * library, resolves @mentions to context blocks, and auto-attaches the
   * selection for slash commands (that's almost always the intent).
   */
  private async buildUserMessage(text: string): Promise<StoredMessage> {
    const slash = parseSlashCommand(text, this.allPrompts());
    let body: string;
    const { blocks, unresolved } = await resolveMentions(
      text,
      this.rag?.ready ? (q) => this.rag!.queryFormatted(q) : undefined,
    );

    if (slash) {
      const selection = collectSelection();
      body = renderTemplate(slash.prompt.template, {
        input: slash.input,
        selection: selection?.content ?? '',
      });
      // Templates that inline {selection} handle it themselves; otherwise attach as context.
      if (
        selection &&
        !slash.prompt.template.includes('{selection}') &&
        !blocks.some((b) => b.label.startsWith('Selection'))
      ) {
        blocks.push(selection);
      }
    } else {
      body = text;
    }

    const context = assembleContext(blocks);
    if (context.dropped.length > 0) {
      this.log.appendLine(`[context] dropped over budget: ${context.dropped.join(', ')}`);
    }
    if (unresolved.length > 0) {
      body += `\n\n(Note: ${unresolved.join(', ')} could not be resolved — no matching editor state.)`;
    }

    return { role: 'user', content: body + context.text, display: text };
  }

  private async handleSend(text: string): Promise<void> {
    const { provider, profile } = await this.profiles.createActiveProvider();
    if (!profile.model) {
      this.post({
        type: 'error',
        message: `Profile "${profile.name}" has no model configured. Pick one via the status bar or the "Cortex: Select Model" command.`,
      });
      return;
    }

    const userMessage = await this.buildUserMessage(text);
    this.conversation.messages.push(userMessage);
    if (this.conversation.messages.length === 1) {
      this.conversation.title = text.slice(0, 60);
    }

    this.abortController = new AbortController();
    let assistant = '';

    try {
      const stream = provider.streamChat({
        model: profile.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...this.conversation.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        signal: this.abortController.signal,
      });
      for await (const chunk of stream) {
        assistant += chunk.content;
        this.post({ type: 'chunk', text: chunk.content });
      }
      this.finishTurn(assistant);
      this.post({ type: 'done' });
    } catch (err) {
      if (isAbortError(err)) {
        this.finishTurn(assistant); // keep the partial response coherent in history
        this.post({ type: 'done' });
        return;
      }
      this.conversation.messages.pop(); // drop the failed turn so retry doesn't duplicate
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[chat] error: ${message}`);
      this.post({ type: 'error', message });
    } finally {
      this.abortController = undefined;
    }
  }

  private finishTurn(assistant: string): void {
    if (assistant) {
      this.conversation.messages.push({ role: 'assistant', content: assistant });
    }
    this.conversation.updatedAt = Date.now();
    void this.store.save(this.conversation);
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

function newConversation(): Conversation {
  return { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [] };
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
