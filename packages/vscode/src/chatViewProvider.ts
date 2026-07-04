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
  type DisplayMessage,
  type ExtensionToWebview,
  type PermissionChoice,
  type PromptTemplate,
  type StoredMessage,
  type WebviewToExtension,
} from '@cortex/core';
import { collectSelection, resolveMentions } from './contextCollector.js';
import { loadProjectInstructions } from './memory.js';
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

  private pendingPermissions = new Map<string, (choice: PermissionChoice | undefined) => void>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly profiles: ProfileManager,
    private readonly store: ConversationStore,
    private readonly log: vscode.OutputChannel,
  ) {}

  postToWebview(msg: ExtensionToWebview): void {
    this.recordAgentMessage(msg);
    this.post(msg);
  }

  /** Persist agent transcript entries so history reloads show the full session. */
  private recordAgentMessage(msg: ExtensionToWebview): void {
    switch (msg.type) {
      case 'agentText':
        this.conversation.messages.push({ role: 'assistant', content: msg.text });
        break;
      case 'agentPlan':
        this.conversation.messages.push({
          role: 'assistant',
          content: msg.text,
          ui: { plan: true },
        });
        break;
      case 'agentToolCall':
        this.conversation.messages.push({
          role: 'assistant',
          content: '',
          ui: { tool: { id: msg.id, name: msg.name, description: msg.description, ok: true } },
        });
        break;
      case 'agentToolResult': {
        for (let i = this.conversation.messages.length - 1; i >= 0; i--) {
          const tool = this.conversation.messages[i]!.ui?.tool;
          if (tool?.id === msg.id) {
            tool.ok = msg.ok;
            tool.label = msg.label;
            tool.fileEdit = msg.fileEdit;
            break;
          }
        }
        break;
      }
      case 'agentStatus':
        if (msg.status !== 'running') {
          this.conversation.messages.push({
            role: 'assistant',
            content: '',
            ui: { status: { state: msg.status } },
          });
          this.conversation.updatedAt = Date.now();
          void this.store.save(this.conversation);
        }
        break;
    }
  }

  /**
   * Inline permission card in the chat. Reveals the chat view first — messages
   * to hidden webviews are dropped silently, which would strand the agent.
   * Resolves undefined (→ modal fallback) if the view can't be shown or dies.
   */
  async requestPermissionInChat(req: {
    description: string;
    permission: string;
    allowPersist: boolean;
  }): Promise<PermissionChoice | undefined> {
    try {
      await vscode.commands.executeCommand('cortex.chatView.focus');
      for (let i = 0; i < 20 && !this.viewReady; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!this.view || !this.viewReady) {
        this.log.appendLine('[perm] chat view unavailable — falling back to modal');
        return undefined;
      }

      const id = randomUUID();
      this.log.appendLine(`[perm] asking in chat: ${req.description}`);
      return await new Promise<PermissionChoice | undefined>((resolve) => {
        this.pendingPermissions.set(id, resolve);
        // Belt and suspenders: if the card is never answered (webview crash,
        // dropped message), fall back to the modal instead of stranding the agent.
        const timeout = setTimeout(() => {
          if (this.pendingPermissions.delete(id)) {
            this.log.appendLine('[perm] no response from chat card after 120s — modal fallback');
            resolve(undefined);
          }
        }, 120_000);
        this.pendingPermissions.set(id, (choice) => {
          clearTimeout(timeout);
          this.pendingPermissions.delete(id);
          resolve(choice);
        });
        this.post({
          type: 'permissionRequest',
          id,
          description: req.description,
          permission: req.permission,
          allowPersist: req.allowPersist,
        });
      });
    } catch (err) {
      this.log.appendLine(`[perm] in-chat request failed: ${err instanceof Error ? err.message : err}`);
      return undefined; // modal fallback
    }
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
      // Never leave the agent hanging on a card nobody can see — fall back to modal.
      for (const resolve of this.pendingPermissions.values()) resolve(undefined);
      this.pendingPermissions.clear();
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
    this.postActiveFile();
  }

  postActiveFile(): void {
    const editor = vscode.window.activeTextEditor;
    const path =
      editor && editor.document.uri.scheme === 'file'
        ? vscode.workspace.asRelativePath(editor.document.uri, false)
        : null;
    this.post({ type: 'activeFile', path });
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
        await this.handleSend(msg.text, msg.files);
        break;
      case 'permissionResponse': {
        const resolve = this.pendingPermissions.get(msg.id);
        this.pendingPermissions.delete(msg.id);
        resolve?.(msg.choice);
        break;
      }
      case 'listModels': {
        const active = this.profiles.getActiveProfile();
        let models: string[] = [];
        try {
          const { provider } = await this.profiles.createActiveProvider();
          models = (await provider.listModels()).map((m) => m.id);
        } catch (err) {
          this.log.appendLine(`[models] list failed: ${String(err)}`);
        }
        this.post({
          type: 'models',
          profiles: this.profiles
            .getProfiles()
            .map((p) => ({ name: p.name, active: p.name === active.name })),
          models,
        });
        break;
      }
      case 'setModel':
        await this.profiles.setChatModel(msg.model);
        break;
      case 'setProfile':
        await this.profiles.setActiveByName(msg.name);
        break;
      case 'pickContextFiles': {
        const files = await vscode.workspace.findFiles(
          '**/*',
          '**/{node_modules,dist,build,target,.git,coverage,vendor,out,.next}/**',
          5000,
        );
        const picked = await vscode.window.showQuickPick(
          files.map((f) => vscode.workspace.asRelativePath(f, false)).sort(),
          { title: 'Cortex: Attach files as context', canPickMany: true },
        );
        if (picked && picked.length > 0) this.post({ type: 'contextFiles', files: picked });
        break;
      }
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
        await applyCodeToEditor(msg.code, this.profiles, this.log);
        break;
      case 'agentStart': {
        const task =
          msg.files && msg.files.length > 0
            ? `${msg.task}\n\nStart by reading these attached files: ${msg.files.join(', ')}`
            : msg.task;
        this.conversation.messages.push({ role: 'user', content: task, display: msg.task });
        if (this.conversation.messages.length === 1) {
          this.conversation.title = msg.task.slice(0, 60);
        }
        await this.agent?.start(task);
        break;
      }
      case 'agentStop':
        this.agent?.stop();
        break;
      case 'agentRevert':
        await this.agent?.revert();
        break;
      case 'agentDiffFile':
        await this.agent?.diffFile(msg.path);
        break;
      case 'agentRevertFile':
        await this.agent?.revertFile(msg.path);
        break;
      case 'agentKeepFile':
        this.agent?.keepFile(msg.path);
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
      messages: loaded.messages.map(
        (m): DisplayMessage => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.display ?? m.content,
          plan: m.ui?.plan,
          tool: m.ui?.tool,
          status: m.ui?.status,
        }),
      ),
    });
  }

  /**
   * Builds the LLM-facing message: expands slash commands via the prompt
   * library, resolves @mentions to context blocks, and auto-attaches the
   * selection for slash commands (that's almost always the intent).
   */
  private async buildUserMessage(text: string, files?: string[]): Promise<StoredMessage> {
    const slash = parseSlashCommand(text, this.allPrompts());
    let body: string;
    const { blocks, unresolved } = await resolveMentions(
      text,
      this.rag?.ready ? (q) => this.rag!.queryFormatted(q) : undefined,
    );

    // Explicitly attached files (📎) — highest-priority context after selection.
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root && files) {
      for (const rel of files.slice(0, 8)) {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel));
          blocks.push({
            label: `Attached file (${rel})`,
            content: new TextDecoder().decode(bytes).slice(0, 20_000),
            priority: 1.5,
          });
        } catch {
          unresolved.push(rel);
        }
      }
    }

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

  private async handleSend(text: string, files?: string[]): Promise<void> {
    const { provider, profile } = await this.profiles.createActiveProvider();
    if (!profile.model) {
      this.post({
        type: 'error',
        message: `Profile "${profile.name}" has no model configured. Pick one via the status bar or the "Cortex: Select Model" command.`,
      });
      return;
    }

    const userMessage = await this.buildUserMessage(text, files);
    this.conversation.messages.push(userMessage);
    if (this.conversation.messages.length === 1) {
      this.conversation.title = text.slice(0, 60);
    }

    this.abortController = new AbortController();
    let assistant = '';
    const instructions = await loadProjectInstructions();

    try {
      const stream = provider.streamChat({
        model: profile.model,
        messages: [
          {
            role: 'system',
            content: instructions ? `${SYSTEM_PROMPT}\n\n${instructions}` : SYSTEM_PROMPT,
          },
          // Agent tool chips / status markers are UI-only — not LLM context.
          ...this.conversation.messages
            .filter((m) => !m.ui?.tool && !m.ui?.status && m.content.trim())
            .map((m) => ({ role: m.role, content: m.content })),
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
