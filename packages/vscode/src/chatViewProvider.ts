import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  assembleContext,
  builtinPrompts,
  COMPACTION_THRESHOLD,
  estimateMessagesTokens,
  isAbortError,
  parseSlashCommand,
  providerPresets,
  renderTemplate,
  resolveCapabilities,
  type Conversation,
  type ConversationStore,
  type DisplayMessage,
  type ExtensionToWebview,
  type PermissionChoice,
  type PromptTemplate,
  type StoredMessage,
  type WebviewToExtension,
} from '@cortex/core';
import {
  collectAttachedFolder,
  collectSelection,
  getActiveEditor,
  isFolderAttachment,
  listFolderFiles,
  resolveMentions,
} from './contextCollector.js';
import { loadProjectInstructions } from './memory.js';
import { applyCodeToEditor, insertCodeAtCursor } from './inlineEdit.js';
import type { AgentController } from './agent/controller.js';
import type { ShadowGit } from './agent/shadowGit.js';
import type { ProfileManager } from './profileManager.js';
import type { RagIndexer } from './rag/indexer.js';

const INIT_TASK =
  'Initialize this project for Cortex. Explore the workspace (key files, tech stack, structure, ' +
  'build/test/run commands, conventions), then: 1) create CORTEX.md at the workspace root — concise ' +
  'project instructions for AI assistants (stack, layout, commands, conventions; under 60 lines); ' +
  '2) create .cortex/memory.md with sections "## Coding style", "## Architecture", "## Preferences" ' +
  '(seed them with anything obvious from the code). Do not modify any other files.';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10_000_000;

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
  /** Workspace checkpoints for prompt editing; unset when git is unavailable. */
  shadowGit?: ShadowGit;

  private pendingPermissions = new Map<string, (choice: PermissionChoice | undefined) => void>();
  private pendingQuestions = new Map<string, (answer: string | undefined) => void>();
  private terminal?: vscode.Terminal;

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

  private agentStreamBuffer = '';

  /** Persist agent transcript entries so history reloads show the full session. */
  private recordAgentMessage(msg: ExtensionToWebview): void {
    switch (msg.type) {
      case 'agentText':
        this.conversation.messages.push({ role: 'assistant', content: msg.text });
        break;
      case 'agentTextDelta':
        this.agentStreamBuffer += msg.text;
        break;
      case 'agentTextEnd':
        if (this.agentStreamBuffer.trim()) {
          this.conversation.messages.push({ role: 'assistant', content: this.agentStreamBuffer });
        }
        this.agentStreamBuffer = '';
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
          if (this.agentStreamBuffer.trim()) {
            this.conversation.messages.push({ role: 'assistant', content: this.agentStreamBuffer });
            this.agentStreamBuffer = '';
          }
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

  /** Everything the settings panel renders: profiles, presets, key status. */
  private async postSettingsData(): Promise<void> {
    const profiles = this.profiles.getProfiles();
    const keySaved: Record<string, boolean> = {};
    for (const p of profiles) keySaved[p.name] = await this.profiles.hasApiKey(p.name);
    this.post({
      type: 'settingsData',
      profiles,
      active: this.profiles.getActiveProfile().name,
      presets: providerPresets.map((p) => ({
        id: p.id,
        label: p.label,
        defaultBaseUrl: p.defaultBaseUrl,
        requiresApiKey: p.requiresApiKey,
        local: p.local,
      })),
      keySaved,
    });
  }

  /** ask_user tool: question card in the chat, awaiting the user's answer. */
  async askAgentQuestion(question: string, options?: string[]): Promise<string | undefined> {
    try {
      await vscode.commands.executeCommand('cortex.chatView.focus');
      for (let i = 0; i < 20 && !this.viewReady; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!this.view || !this.viewReady) return undefined;
      const id = randomUUID();
      return await new Promise<string | undefined>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.pendingQuestions.delete(id)) resolve(undefined);
        }, 300_000);
        this.pendingQuestions.set(id, (answer) => {
          clearTimeout(timeout);
          this.pendingQuestions.delete(id);
          resolve(answer);
        });
        this.post({ type: 'agentQuestion', id, question, options });
      });
    } catch {
      return undefined;
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
      slashCommands: [
        ...this.allPrompts().map((p) => ({ command: p.command, title: p.title })),
        { command: 'init', title: 'Set up CORTEX.md & project memory (agent)' },
      ],
    });
    this.postActiveFile();
  }

  /** Last few conversational turns (no tool chips/status), for agent follow-ups. */
  private recentConversationContext(): string {
    const turns = this.conversation.messages
      .filter((m) => !m.ui?.tool && !m.ui?.status && (m.display ?? m.content).trim())
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.display ?? m.content).slice(0, 400)}`);
    return turns.join('\n').slice(0, 2400);
  }

  /**
   * Open a code reference mentioned in chat: a workspace file path directly,
   * else the first content match (e.g. a CSS selector or symbol name).
   */
  private async openReference(text: string): Promise<void> {
    const needle = text.trim().slice(0, 200);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!needle || !root) return;

    try {
      const uri = vscode.Uri.joinPath(root, needle);
      await vscode.workspace.fs.stat(uri);
      await vscode.window.showTextDocument(uri, { preview: true });
      return;
    } catch {
      // not a file path — fall through to content search
    }

    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,dist,build,target,.git,coverage,vendor,out,.next}/**',
      800,
    );
    for (const file of files) {
      let content: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        if (bytes.byteLength > 300_000) continue;
        content = new TextDecoder().decode(bytes);
        if (content.includes(' ')) continue;
      } catch {
        continue;
      }
      const index = content.indexOf(needle);
      if (index === -1) continue;
      const line = content.slice(0, index).split('\n').length - 1;
      const editor = await vscode.window.showTextDocument(file, { preview: true });
      const pos = new vscode.Position(line, 0);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(pos, pos);
      return;
    }
    void vscode.window.setStatusBarMessage(`Cortex: "${needle}" not found in workspace`, 3000);
  }

  postActiveFile(): void {
    const editor = getActiveEditor();
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
        if (msg.text.trim() === '/init') {
          this.conversation.messages.push({ role: 'user', content: INIT_TASK, display: '/init' });
          await this.agent?.start(INIT_TASK);
          break;
        }
        await this.handleSend(msg.text, msg.files, msg.images);
        break;
      case 'permissionResponse': {
        const resolve = this.pendingPermissions.get(msg.id);
        this.pendingPermissions.delete(msg.id);
        resolve?.(msg.choice);
        break;
      }
      case 'agentQuestionResponse':
        this.pendingQuestions.get(msg.id)?.(msg.answer);
        break;
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
      case 'settingsLoad':
        await this.postSettingsData();
        break;
      case 'settingsSaveProfile':
        try {
          await this.profiles.upsertProfile(msg.original, msg.profile, msg.apiKey);
        } catch (err) {
          void vscode.window.showErrorMessage(`Cortex: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.postSettingsData();
        break;
      case 'settingsDeleteProfile': {
        const confirm = await vscode.window.showWarningMessage(
          `Delete profile "${msg.name}"? Its stored API key is removed too.`,
          { modal: true },
          'Delete',
        );
        if (confirm === 'Delete') await this.profiles.deleteProfile(msg.name);
        await this.postSettingsData();
        break;
      }
      case 'settingsActivateProfile':
        await this.profiles.setActiveByName(msg.name);
        await this.postSettingsData();
        break;
      case 'openNativeSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:cortexcode.cortex-code');
        break;
      case 'pickContextFiles': {
        const files = await vscode.workspace.findFiles(
          '**/*',
          '**/{node_modules,dist,build,target,.git,coverage,vendor,out,.next}/**',
          5000,
        );
        const rels = files.map((f) => vscode.workspace.asRelativePath(f, false)).sort();
        // Folders (derived from the file list, up to 3 levels) are attachable
        // too — an attached folder means "everything under it, recursively".
        const dirs = new Set<string>();
        for (const rel of rels) {
          const parts = rel.split('/');
          let prefix = '';
          for (let i = 0; i < parts.length - 1 && i < 3; i++) {
            prefix += `${parts[i]}/`;
            dirs.add(prefix);
          }
        }
        const picked = await vscode.window.showQuickPick(
          [
            ...[...dirs].sort().map((d) => ({ label: `$(folder) ${d}`, value: d })),
            ...rels.map((r) => ({ label: r, value: r })),
          ],
          { title: 'Cortex: Attach files or folders as context', canPickMany: true },
        );
        if (picked && picked.length > 0) {
          this.post({ type: 'contextFiles', files: picked.map((p) => p.value) });
        }
        break;
      }
      case 'resolveDropped': {
        const attachments: string[] = [];
        const images: string[] = [];
        for (const raw of msg.uris.slice(0, 30)) {
          try {
            const uri = vscode.Uri.parse(raw);
            // Dropped images become vision attachments (data URLs); images may
            // also come from outside the workspace (e.g. a screenshots folder).
            if (IMAGE_EXTENSIONS.test(uri.path) && images.length < MAX_IMAGES) {
              const bytes = await vscode.workspace.fs.readFile(uri);
              if (bytes.byteLength <= MAX_IMAGE_BYTES) {
                const ext = uri.path.split('.').pop()!.toLowerCase();
                const mime = ext === 'jpg' ? 'jpeg' : ext;
                images.push(`data:image/${mime};base64,${Buffer.from(bytes).toString('base64')}`);
              }
              continue;
            }
            const rel = vscode.workspace.asRelativePath(uri, false);
            if (rel === uri.fsPath) continue; // outside the workspace
            const stat = await vscode.workspace.fs.stat(uri);
            attachments.push(stat.type === vscode.FileType.Directory ? `${rel}/` : rel);
          } catch {
            // unreadable/vanished — skip
          }
        }
        if (attachments.length > 0) this.post({ type: 'contextFiles', files: attachments });
        if (images.length > 0) this.post({ type: 'imageAttachments', images });
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
          addProfile: 'cortex.addProfile',
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
      case 'agentStart':
        await this.startAgentTask(msg.task, msg.files, msg.images);
        break;
      case 'editUserMessage':
        await this.editUserMessage(msg.ordinal, msg.text, msg.files, msg.mode);
        break;
      case 'openInTerminal': {
        if (!this.terminal || this.terminal.exitStatus) {
          this.terminal = vscode.window.createTerminal('Cortex');
        }
        this.terminal.show();
        // Insert without executing — the user reviews and presses Enter.
        this.terminal.sendText(msg.command, false);
        break;
      }
      case 'openReference':
        await this.openReference(msg.text);
        break;
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
      case 'agentReapplyFile':
        await this.agent?.reapplyFile(msg.path);
        break;
      case 'agentKeepFile':
        this.agent?.keepFile(msg.path);
        break;
    }
  }

  /** Agent turn: checkpoint the workspace, expand attachments, run the agent. */
  private async startAgentTask(rawTask: string, files?: string[], images?: string[]): Promise<void> {
    let task = rawTask.trim() === '/init' ? INIT_TASK : rawTask;
    if (files && files.length > 0) {
      const plainFiles = files.filter((f) => !isFolderAttachment(f));
      const folders = files.filter(isFolderAttachment);
      if (plainFiles.length > 0) {
        task +=
          `\n\nThe user attached these files as likely-relevant context: ${plainFiles.join(', ')}. ` +
          'Read them, but do not limit yourself to them — explore the workspace as the task requires.';
      }
      for (const folder of folders.slice(0, 3)) {
        const listing = await listFolderFiles(folder);
        task +=
          `\n\nThe user attached the folder "${folder}" as context — everything under it, ` +
          `including nested subfolders, is in scope. It contains:\n${listing.slice(0, 200).join('\n')}` +
          `${listing.length > 200 ? `\n…and ${listing.length - 200} more files` : ''}\n` +
          'Read whichever of these files the task requires.';
      }
    }
    // Follow-ups ("done?", "now also…") need the conversation so far —
    // agent sessions are otherwise blank-slate.
    const prior = this.recentConversationContext();
    if (prior) {
      task = `Conversation so far (for context):\n${prior}\n\n---\n\nNew task: ${task}`;
    }
    const checkpoint = await this.shadowGit?.snapshot(`before: ${rawTask.slice(0, 80)}`);
    this.conversation.messages.push({
      role: 'user',
      content: task,
      display: rawTask,
      checkpoint,
      images: images?.slice(0, MAX_IMAGES),
    });
    if (this.conversation.messages.length === 1) {
      this.conversation.title = (rawTask || 'Image').slice(0, 60);
    }
    await this.agent?.start(task, images?.slice(0, MAX_IMAGES));
  }

  /**
   * Edit a previous prompt: truncate the conversation at that user turn,
   * restore the workspace to the checkpoint taken before the first agent
   * turn from that point on, and resend the new text.
   */
  private async editUserMessage(
    ordinal: number,
    text: string,
    files: string[] | undefined,
    mode: 'chat' | 'agent',
  ): Promise<void> {
    let index = -1;
    let seen = -1;
    for (let i = 0; i < this.conversation.messages.length; i++) {
      if (this.conversation.messages[i]!.role === 'user' && !this.conversation.messages[i]!.ui) {
        seen++;
        if (seen === ordinal) {
          index = i;
          break;
        }
      }
    }
    if (index === -1) {
      this.post({ type: 'error', message: 'Could not locate that message to edit.' });
      return;
    }

    this.abortController?.abort();
    this.agent?.stop();

    // The checkpoint on the edited turn — or the next one after it — is the
    // workspace state before any agent work from this point on.
    const checkpoint = this.conversation.messages
      .slice(index)
      .find((m) => m.checkpoint)?.checkpoint;
    if (checkpoint) {
      const restored = await this.shadowGit?.restore(checkpoint);
      if (restored && restored.length > 0) {
        this.post({
          type: 'agentText',
          text: `Restored ${restored.length} file(s) to the state before this message.`,
        });
      }
    }

    this.conversation.messages = this.conversation.messages.slice(0, index);
    await this.store.save(this.conversation);
    this.post({
      type: 'conversation',
      id: this.conversation.id,
      messages: this.conversation.messages.map(
        (m): DisplayMessage => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.display ?? m.content,
          images: m.images,
          plan: m.ui?.plan,
          tool: m.ui?.tool,
          status: m.ui?.status,
        }),
      ),
    });

    if (mode === 'agent') {
      this.post({ type: 'userTurn', text, files });
      await this.startAgentTask(text, files);
    } else {
      this.post({ type: 'userMessage', text });
      await this.handleSend(text, files);
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
          images: m.images,
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

    // Explicitly attached files (📎/drag-and-drop) — highest-priority context after selection.
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root && files) {
      for (const rel of files.filter((f) => !isFolderAttachment(f)).slice(0, 8)) {
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
      // Attached folders: recursive listing + as many nested files inlined as fit.
      for (const rel of files.filter(isFolderAttachment).slice(0, 3)) {
        const folderBlocks = await collectAttachedFolder(rel);
        if (folderBlocks.length > 0) blocks.push(...folderBlocks);
        else unresolved.push(rel);
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

  private async handleSend(text: string, files?: string[], images?: string[]): Promise<void> {
    const { provider, profile } = await this.profiles.createActiveProvider();
    if (!profile.model) {
      this.post({
        type: 'error',
        message: `Profile "${profile.name}" has no model configured. Pick one via the status bar or the "Cortex: Select Model" command.`,
      });
      return;
    }
    if (images && images.length > 0 && !resolveCapabilities(profile).vision) {
      this.post({
        type: 'error',
        message:
          `Profile "${profile.name}" is not marked vision-capable, so images can't be sent. ` +
          'If your model does support images, set "capabilities": {"vision": true} on the profile (cortex.profiles).',
      });
      return;
    }

    const userMessage = await this.buildUserMessage(text, files);
    if (images && images.length > 0) {
      userMessage.images = images.slice(0, MAX_IMAGES);
      if (!userMessage.content.trim()) userMessage.content = 'See the attached image(s).';
    }
    this.conversation.messages.push(userMessage);
    if (this.conversation.messages.length === 1) {
      this.conversation.title = (text || 'Image').slice(0, 60);
    }

    this.abortController = new AbortController();
    let assistant = '';
    const instructions = await loadProjectInstructions();

    const systemMessage = {
      role: 'system' as const,
      content: instructions ? `${SYSTEM_PROMPT}\n\n${instructions}` : SYSTEM_PROMPT,
    };
    // Agent tool chips / status markers are UI-only — not LLM context.
    const history = this.conversation.messages
      .filter((m) => !m.ui?.tool && !m.ui?.status && (m.content.trim() || m.images?.length))
      .map((m) => ({ role: m.role, content: m.content, images: m.images }));

    // Sliding window: drop the oldest turns (full history stays on disk)
    // until the prompt plus a reply fits the model's context window.
    const window = await this.profiles.contextWindowFor(profile, profile.model);
    const budget = Math.max(
      2_000,
      window * COMPACTION_THRESHOLD - Math.min(profile.maxTokens ?? 4_096, window / 4),
    );
    let dropped = 0;
    while (history.length > 2 && estimateMessagesTokens([systemMessage, ...history]) > budget) {
      history.shift();
      dropped++;
    }
    if (dropped > 0) {
      this.log.appendLine(`[chat] trimmed ${dropped} old message(s) to fit the context window`);
      history.unshift({
        role: 'user',
        content: `[${dropped} earlier message(s) omitted — the conversation exceeded the context window.]`,
        images: undefined,
      });
    }
    this.post({
      type: 'contextUsage',
      used: estimateMessagesTokens([systemMessage, ...history]),
      window,
    });

    try {
      const stream = provider.streamChat({
        model: profile.model,
        messages: [systemMessage, ...history],
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
