import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ASK_USER_COUNTDOWN_MS,
  assembleContext,
  builtinPrompts,
  COMPACTION_THRESHOLD,
  createProvider,
  DEFAULT_IGNORE_GLOB,
  estimateMessagesTokens,
  IdleDeadline,
  isAbortError,
  parseSlashCommand,
  providerPresets,
  renderTemplate,
  resolveCapabilities,
  stripToolCallArtifacts,
  type ChatMessage,
  type Conversation,
  type ConversationStore,
  type DisplayMessage,
  type ExtensionToWebview,
  type PermissionChoice,
  type PromptTemplate,
  type ProviderProfileConfig,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type StoredMessage,
  type WebviewToExtension,
} from '@heapcode/core';
import {
  collectActiveFile,
  collectAttachedFolder,
  collectSelection,
  getActiveEditor,
  isFolderAttachment,
  listFolderFiles,
  resolveMentions,
} from './contextCollector.js';
import { filterIgnored } from './ignoreFiles.js';
import { loadProjectInstructions } from './memory.js';
import { applyCodeToEditor, insertCodeAtCursor } from './inlineEdit.js';
import { agentToolDefinitions, getHeapCodeTerminal, WorkspaceToolExecutor } from './agent/workspaceTools.js';
import { SessionCheckpoint } from './agent/checkpoint.js';
import { resultLabel, TOOL_SUMMARY_CHARS, type AgentController } from './agent/controller.js';
import type { ShadowGit } from './agent/shadowGit.js';
import type { ProfileManager } from './profileManager.js';
import type { ServerLink } from './serverLink.js';

const INIT_TASK =
  'Initialize this project for Heap Code. Explore the workspace (key files, tech stack, structure, ' +
  'build/test/run commands, conventions), then: 1) create .heapcode/HEAPCODE.md — concise ' +
  'project instructions for AI assistants (stack, layout, commands, conventions; under 60 lines); ' +
  '2) create .heapcode/memory.md with sections "## Coding style", "## Architecture", "## Preferences" ' +
  '(seed them with anything obvious from the code). Do not modify any other files.';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10_000_000;

const SYSTEM_PROMPT =
  'You are Heap Code, an expert AI programming assistant inside the user\'s IDE. ' +
  'Be concise and technically precise. Use markdown; put code in fenced blocks with a language tag. ' +
  'Context sections (marked with "---") may accompany the user\'s message — use them, and say so if they are insufficient. ' +
  'When asked about specific code (a function, file, or "my X") and no matching code appears in the ' +
  'context sections, say so plainly and ask the user to share it (or use @file/@workspace) — never ' +
  'invent, guess, or reconstruct a plausible-looking implementation and present it as their real code.';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'heapcode.chatView';

  private view?: vscode.WebviewView;
  private viewReady = false;
  private pendingSends: string[] = [];
  private conversation: Conversation = newConversation();
  private abortController?: AbortController;

  /** Set right after construction (controller needs this.post, we need controller). */
  agent?: AgentController;
  /** Workspace checkpoints for prompt editing; unset when git is unavailable. */
  shadowGit?: ShadowGit;

  private pendingPermissions = new Map<string, (choice: PermissionChoice | undefined) => void>();
  private pendingQuestions = new Map<string, (answer: string | undefined) => void>();
  /** Idle deadlines for pending questions, so webview activity can push them back. */
  private questionDeadlines = new Map<string, IdleDeadline>();
  /** Last partial answer the card reported, handed to the agent if the question expires. */
  private questionPartials = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly profiles: ProfileManager,
    private readonly store: ConversationStore,
    private readonly log: vscode.OutputChannel,
    /** Chat turns and model listing both run server-side now. */
    private readonly link: ServerLink,
    private readonly track?: (name: string, meta?: Record<string, unknown>) => void,
  ) {}

  postToWebview(msg: ExtensionToWebview): void {
    this.recordAgentMessage(msg);
    this.post(msg);
    // Notify on completion (PLAN.md M12) when nobody's watching — the agent
    // loop runs in the extension host regardless of whether the sidebar view
    // is visible, so a run that finishes while it's hidden/disposed would
    // otherwise go completely unnoticed until the user happens to look.
    if (msg.type === 'agentStatus' && msg.status !== 'running' && !this.view?.visible) {
      this.notifyAgentFinished(msg.status);
    }
  }

  private notifyAgentFinished(status: string): void {
    const message =
      status === 'done'
        ? 'Heap Code: agent task finished.'
        : status === 'error'
          ? 'Heap Code: agent task failed.'
          : status === 'stopped'
            ? 'Heap Code: agent task stopped.'
            : status === 'max-iterations'
              ? 'Heap Code: agent hit its iteration limit.'
              : status === 'incomplete'
                ? 'Heap Code: agent stopped without completing the task.'
                : status === 'planned'
                  ? 'Heap Code: agent has a plan ready for your approval.'
                  : 'Heap Code: agent task finished.';
    void vscode.window.showInformationMessage(message, 'Show').then((choice) => {
      if (choice === 'Show') void vscode.commands.executeCommand('heapcode.chatView.focus');
    });
  }

  private agentStreamBuffer = '';
  private saveDebounceTimer?: ReturnType<typeof setTimeout>;

  /**
   * Debounced save so a long-running agent turn is periodically flushed to
   * disk, not just at completion — a run stuck on a hung command (or force-
   * closing the window mid-run) previously lost the whole in-progress
   * conversation, since it only ever saved once the agent reached a terminal
   * status. Worst case now is losing the last ~2s of activity, not the run.
   */
  private scheduleSave(): void {
    this.conversation.updatedAt = Date.now();
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = undefined;
      void this.store.save(this.conversation);
    }, 2000);
  }

  /** Belt-and-suspenders flush for a graceful shutdown (window reload, extension disable) — see deactivate(). */
  async flushPendingSave(): Promise<void> {
    if (!this.saveDebounceTimer) return;
    clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = undefined;
    await this.store.save(this.conversation);
  }

  /** Persist agent transcript entries so history reloads show the full session. */
  private recordAgentMessage(msg: ExtensionToWebview): void {
    switch (msg.type) {
      case 'agentText':
        this.conversation.messages.push({ role: 'assistant', content: msg.text });
        this.scheduleSave();
        break;
      case 'agentTextDelta':
        this.agentStreamBuffer += msg.text;
        break;
      case 'agentTextEnd':
        if (this.agentStreamBuffer.trim()) {
          this.conversation.messages.push({ role: 'assistant', content: this.agentStreamBuffer });
          this.scheduleSave();
        }
        this.agentStreamBuffer = '';
        break;
      case 'agentPlan':
        this.conversation.messages.push({
          role: 'assistant',
          content: msg.text,
          ui: { plan: true },
        });
        this.scheduleSave();
        break;
      case 'agentToolCall':
        this.conversation.messages.push({
          role: 'assistant',
          content: '',
          ui: { tool: { id: msg.id, name: msg.name, description: msg.description, ok: true } },
        });
        this.scheduleSave();
        break;
      case 'agentToolResult': {
        for (let i = this.conversation.messages.length - 1; i >= 0; i--) {
          const tool = this.conversation.messages[i]!.ui?.tool;
          if (tool?.id === msg.id) {
            tool.ok = msg.ok;
            tool.label = msg.label;
            tool.summary = msg.summary;
            tool.fileEdit = msg.fileEdit;
            tool.checkpoint = msg.checkpoint;
            break;
          }
        }
        this.scheduleSave();
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
          if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = undefined;
          }
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
      await vscode.commands.executeCommand('heapcode.chatView.focus');
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
      subAgentsEnabled: vscode.workspace.getConfiguration('heapcode.agent').get<boolean>('subAgents', false),
    });
  }

  /**
   * ask_user tool: question card in the chat, awaiting the user's answer.
   *
   * This used to impose a hardcoded, invisible 300-second cap that resolved to
   * `undefined` — so a question silently became "the user did not answer" after
   * five minutes with no countdown, no way to configure it, and no way to tell
   * it apart from a cancelled run. (controller.ts's comment claimed there was
   * no timeout at all; the two disagreed.) That is replaced by the same opt-in
   * idle bound the CLI has: unbounded unless `heapcode.agent.askUserQuestionTimeout`
   * is set, reset by any activity, visible for its last stretch, and resolving
   * with guidance rather than silence.
   *
   * `idleMs` undefined → waits indefinitely. Returns `{ idle: true }` only when
   * the bound expired; cancellation and a dead view stay `idle: false` so the
   * caller keeps using ASK_USER_NO_ANSWER for them.
   */
  async askAgentQuestion(
    question: string,
    options?: string[],
    idleMs?: number,
  ): Promise<{ answer?: string; idle: boolean; partial?: string }> {
    try {
      await vscode.commands.executeCommand('heapcode.chatView.focus');
      for (let i = 0; i < 20 && !this.viewReady; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!this.view || !this.viewReady) return { idle: false };
      const id = randomUUID();
      return await new Promise<{ answer?: string; idle: boolean; partial?: string }>((resolve) => {
        let countdown: ReturnType<typeof setInterval> | undefined;
        const finish = (result: { answer?: string; idle: boolean; partial?: string }): void => {
          deadline.stop();
          if (countdown) clearInterval(countdown);
          this.pendingQuestions.delete(id);
          this.questionPartials.delete(id);
          resolve(result);
        };
        const deadline = new IdleDeadline(idleMs, () => {
          // Tell the card to stop accepting input before answering the agent,
          // so the user never types into a question that has already resolved.
          this.post({ type: 'agentQuestionClosed', id, reason: 'idle' });
          finish({ idle: true, partial: this.questionPartials.get(id) });
        });
        this.pendingQuestions.set(id, (answer) => finish({ answer, idle: false }));
        this.questionDeadlines.set(id, deadline);
        deadline.start();
        this.post({ type: 'agentQuestion', id, question, options });
        if (deadline.enabled) {
          countdown = setInterval(() => {
            const remaining = deadline.remainingMs();
            if (remaining <= ASK_USER_COUNTDOWN_MS) {
              this.post({ type: 'agentQuestionCountdown', id, seconds: Math.ceil(remaining / 1_000) });
            }
          }, 500);
          countdown.unref?.();
        }
      }).finally(() => this.questionDeadlines.delete(id));
    } catch {
      return { idle: false };
    }
  }

  /** Cancellation/teardown: take a pending question down the way it always did. */
  closePendingQuestions(): void {
    for (const [id, resolve] of [...this.pendingQuestions]) {
      this.post({ type: 'agentQuestionClosed', id, reason: 'cancelled' });
      resolve(undefined);
    }
  }

  /**
   * Abort the running turn. Always goes through here rather than calling
   * `abortController.abort()` directly, because a pending question has nothing
   * else to resolve it: aborting the run abandons the `await` in executeTool,
   * so without this the promise and its card would both linger. The old
   * hardcoded 300s cap used to paper over that; an unbounded wait cannot.
   */
  private abortRun(): void {
    this.abortController?.abort();
    this.closePendingQuestions();
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
      // Same for questions, and now load-bearing: an unanswered question used
      // to give up after the hardcoded 300s, but the default is now an
      // unbounded wait, so a disposed view would hang the run forever.
      this.closePendingQuestions();
    });
  }

  /**
   * Entry point for context-menu commands and code actions: opens the chat
   * view (waiting for it to boot if needed) and runs `text` as a user turn.
   */
  async sendFromCommand(text: string): Promise<void> {
    await vscode.commands.executeCommand('heapcode.chatView.focus');
    if (this.viewReady) {
      this.post({ type: 'userMessage', text });
      await this.handleSend(text);
    } else {
      this.pendingSends.push(text);
    }
  }

  /** Built-in prompts plus user prompts from `heapcode.customPrompts` (later wins on collision). */
  private allPrompts(): PromptTemplate[] {
    const custom = vscode.workspace
      .getConfiguration('heapcode')
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
        { command: 'init', title: 'Set up HEAPCODE.md & project memory (agent)' },
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

    const found = await vscode.workspace.findFiles('**/*', DEFAULT_IGNORE_GLOB, 800);
    const files = await filterIgnored(root, found);
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
    void vscode.window.setStatusBarMessage(`Heap Code: "${needle}" not found in workspace`, 3000);
  }

  private lastActiveFilePost = '';

  postActiveFile(): void {
    const editor = getActiveEditor();
    const path =
      editor && editor.document.uri.scheme === 'file'
        ? vscode.workspace.asRelativePath(editor.document.uri, false)
        : null;
    const selection =
      path && editor && !editor.selection.isEmpty
        ? { start: editor.selection.start.line + 1, end: editor.selection.end.line + 1 }
        : undefined;
    // Selection events fire on every cursor move — only post real changes.
    const key = `${path}|${selection?.start ?? ''}|${selection?.end ?? ''}`;
    if (key === this.lastActiveFilePost) return;
    this.lastActiveFilePost = key;
    this.post({ type: 'activeFile', path, selection });
  }

  private post(msg: ExtensionToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  private async onMessage(msg: WebviewToExtension): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.viewReady = true;
        this.postConfig();
        // Reconnecting to an in-progress (or just-finished) conversation — the
        // agent loop itself runs in the extension host and isn't tied to the
        // webview's lifecycle, so a task started before the view was hidden/
        // disposed keeps running regardless; this just rehydrates a freshly-
        // mounted webview with what it missed (PLAN.md M12).
        if (this.conversation.messages.length > 0) {
          this.post({
            type: 'conversation',
            id: this.conversation.id,
            messages: this.toDisplayMessages(this.conversation.messages),
          });
          if (this.agent?.running) this.post({ type: 'agentStatus', status: 'running', changedFiles: [] });
        }
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
      case 'agentQuestionActivity': {
        // Typing, or the card regaining focus — the user is still here.
        if (msg.partial !== undefined) this.questionPartials.set(msg.id, msg.partial);
        this.questionDeadlines.get(msg.id)?.touch();
        return;
      }
      case 'agentQuestionResponse':
        this.pendingQuestions.get(msg.id)?.(msg.answer);
        break;
      case 'listModels': {
        const active = this.profiles.getActiveProfile();
        let models: string[] = [];
        try {
          models = (await this.link.listModels(active.name)).map((m) => m.id);
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
          void vscode.window.showErrorMessage(`Heap Code: ${err instanceof Error ? err.message : String(err)}`);
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
      case 'settingsSetSubAgents':
        await vscode.workspace.getConfiguration('heapcode.agent').update(
          'subAgents',
          msg.enabled,
          vscode.workspace.workspaceFolders
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global,
        );
        await this.postSettingsData();
        break;
      case 'settingsTestConnection': {
        try {
          const apiKey =
            msg.apiKey ??
            (msg.originalName ? await this.profiles.getApiKey({ ...msg.profile, name: msg.originalName }) : undefined);
          const provider = createProvider(msg.profile, apiKey);
          const models = (await provider.listModels()).map((m) => m.id);
          this.post({ type: 'settingsModels', models });
        } catch (err) {
          this.post({
            type: 'settingsModels',
            models: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'listTools': {
        const disabled = new Set(
          vscode.workspace.getConfiguration('heapcode.agent').get<string[]>('disabledTools', []),
        );
        this.post({
          type: 'toolsList',
          groups: (this.agent?.listToolGroups() ?? []).map((g) => ({
            ...g,
            tools: g.tools.map((t) => ({ ...t, enabled: !disabled.has(t.name) })),
          })),
        });
        break;
      }
      case 'setToolEnabled': {
        const cfg = vscode.workspace.getConfiguration('heapcode.agent');
        const disabled = new Set(cfg.get<string[]>('disabledTools', []));
        if (msg.enabled) disabled.delete(msg.name);
        else disabled.add(msg.name);
        await cfg.update(
          'disabledTools',
          [...disabled].sort(),
          vscode.workspace.workspaceFolders
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global,
        );
        break;
      }
      case 'openNativeSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:heapcode.heap-code');
        break;
      case 'pickContextFiles': {
        const pickRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        const found = await vscode.workspace.findFiles('**/*', DEFAULT_IGNORE_GLOB, 5000);
        const files = pickRoot ? await filterIgnored(pickRoot, found) : found;
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
          { title: 'Heap Code: Attach files or folders as context', canPickMany: true },
        );
        if (picked && picked.length > 0) {
          this.post({ type: 'contextFiles', files: picked.map((p) => p.value) });
        }
        break;
      }
      case 'pickUpload': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Attach',
          title: 'Heap Code: Attach files or images',
        });
        if (!picked || picked.length === 0) break;
        const files: string[] = [];
        const images: string[] = [];
        for (const uri of picked.slice(0, 10)) {
          try {
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
            // Files outside the workspace attach by absolute path.
            files.push(rel === uri.fsPath ? uri.fsPath : rel);
          } catch {
            // unreadable — skip
          }
        }
        if (files.length > 0) this.post({ type: 'contextFiles', files });
        if (images.length > 0) this.post({ type: 'imageAttachments', images });
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
        this.abortRun();
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
          selectProfile: 'heapcode.selectProfile',
          selectModel: 'heapcode.selectModel',
          setApiKey: 'heapcode.setApiKey',
          addProfile: 'heapcode.addProfile',
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
        await this.startAgentTask(msg.task, msg.files, msg.images, msg.persona);
        break;
      case 'agentApprovePlan':
        await this.agent?.approvePlan();
        break;
      case 'editUserMessage':
        await this.editUserMessage(msg.ordinal, msg.text, msg.files, msg.mode, msg.persona);
        break;
      case 'restoreCheckpoint':
        await this.restoreCheckpoint(msg.ordinal);
        break;
      case 'restoreToolCheckpoint':
        await this.restoreToolCheckpoint(msg.hash);
        break;
      case 'openInTerminal': {
        // Same terminal the agent's own run_command uses (getHeapCodeTerminal) —
        // one recognizable "Heap Code" terminal, not a new one per click.
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const terminal = root ? getHeapCodeTerminal(root) : vscode.window.createTerminal('Heap Code');
        terminal.show();
        // Insert without executing — the user reviews and presses Enter.
        terminal.sendText(msg.command, false);
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
      case 'agentKeepAll':
        this.agent?.keepAll();
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
  private async startAgentTask(
    rawTask: string,
    files?: string[],
    images?: string[],
    persona?: string,
  ): Promise<void> {
    let task = rawTask.trim() === '/init' ? INIT_TASK : rawTask;
    if (files && files.length > 0) {
      // "path#L10-80" (selection chip) → tell the agent which lines matter.
      const plainFiles = files
        .filter((f) => !isFolderAttachment(f))
        .map((f) => {
          const range = /^(.*)#L(\d+)-(\d+)$/.exec(f);
          return range ? `${range[1]} (especially lines ${range[2]}-${range[3]})` : f;
        });
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
    await this.agent?.start(task, images?.slice(0, MAX_IMAGES), { personaId: persona });
  }

  /** Index in conversation.messages of the Nth real (non-UI) user turn, or -1. */
  private userMessageIndex(ordinal: number): number {
    let seen = -1;
    for (let i = 0; i < this.conversation.messages.length; i++) {
      if (this.conversation.messages[i]!.role === 'user' && !this.conversation.messages[i]!.ui) {
        seen++;
        if (seen === ordinal) return i;
      }
    }
    return -1;
  }

  /**
   * Timeline restore: put the workspace files back to the state before this
   * turn ran. The conversation itself is untouched — unlike editing a prompt.
   */
  private async restoreCheckpoint(ordinal: number): Promise<void> {
    const index = this.userMessageIndex(ordinal);
    if (index === -1) {
      this.post({ type: 'error', message: 'Could not locate that message.' });
      return;
    }
    const checkpoint = this.conversation.messages
      .slice(index)
      .find((m) => m.checkpoint)?.checkpoint;
    if (!checkpoint) {
      this.post({
        type: 'agentText',
        text: 'No workspace checkpoint for this turn — checkpoints are taken when a prompt runs in agent mode.',
      });
      return;
    }
    const restored = await this.shadowGit?.restore(checkpoint);
    if (restored && restored.length > 0) this.track?.('checkpoint.restoreTurn', { count: restored.length });
    this.post({
      type: 'agentText',
      text:
        restored && restored.length > 0
          ? `⤺ Restored ${restored.length} file(s) to the workspace state before this message.`
          : 'Workspace already matches the state before this message — nothing to restore.',
    });
  }

  /**
   * Granular timeline restore (PLAN.md M8): rewind to the shadow-git snapshot
   * taken right before one specific tool call, not the whole turn.
   */
  private async restoreToolCheckpoint(hash: string): Promise<void> {
    const restored = await this.shadowGit?.restore(hash);
    if (restored && restored.length > 0) this.track?.('checkpoint.restoreStep', { count: restored.length });
    this.post({
      type: 'agentText',
      text:
        restored && restored.length > 0
          ? `⤺ Restored ${restored.length} file(s) to the workspace state before this step.`
          : 'Workspace already matches the state before this step — nothing to restore.',
    });
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
    persona?: string,
  ): Promise<void> {
    const index = this.userMessageIndex(ordinal);
    if (index === -1) {
      this.post({ type: 'error', message: 'Could not locate that message to edit.' });
      return;
    }

    this.abortRun();
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
      messages: this.toDisplayMessages(this.conversation.messages),
    });

    if (mode === 'agent') {
      this.post({ type: 'userTurn', text, files });
      await this.startAgentTask(text, files, undefined, persona);
    } else {
      this.post({ type: 'userMessage', text });
      await this.handleSend(text, files);
    }
  }

  private async startNewChat(): Promise<void> {
    this.abortRun();
    if (this.conversation.messages.length > 0) {
      await this.store.save(this.conversation);
    }
    this.conversation = newConversation();
    this.post({ type: 'newChatStarted' });
  }

  private async openConversation(id: string): Promise<void> {
    const loaded = await this.store.get(id);
    if (!loaded) return;
    this.abortRun();
    if (this.conversation.messages.length > 0 && this.conversation.id !== id) {
      await this.store.save(this.conversation);
    }
    this.conversation = loaded;
    this.post({ type: 'conversation', id: loaded.id, messages: this.toDisplayMessages(loaded.messages) });
  }

  private toDisplayMessages(messages: StoredMessage[]): DisplayMessage[] {
    return messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.display ?? m.content,
      images: m.images,
      plan: m.ui?.plan,
      tool: m.ui?.tool,
      status: m.ui?.status,
    }));
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
      (q) => this.link.ragQuery(q).then((r) => r.formatted),
    );

    // Explicitly attached files (📎/drag-and-drop) — highest-priority context after selection.
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root && files) {
      for (const attachment of files.filter((f) => !isFolderAttachment(f)).slice(0, 8)) {
        // "path#L10-80" = attach only those lines (editor selection chip).
        const range = /^(.*)#L(\d+)-(\d+)$/.exec(attachment);
        const rel = range ? range[1]! : attachment;
        try {
          const uri = path.isAbsolute(rel) ? vscode.Uri.file(rel) : vscode.Uri.joinPath(root, rel);
          let content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
          let label = `Attached file (${rel})`;
          if (range) {
            const start = Number(range[2]);
            const end = Number(range[3]);
            content = content
              .split('\n')
              .slice(start - 1, end)
              .join('\n');
            label = `Attached selection (${rel}:${start}-${end})`;
          }
          blocks.push({ label, content: content.slice(0, 20_000), priority: 1.5, trust: 'untrusted' });
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

    // No @mention, attachment, or selection resolved any context — ground the answer in
    // whatever's open rather than let the model guess at code it has never seen.
    if (blocks.length === 0) {
      const activeFile = collectActiveFile();
      if (activeFile) blocks.push(activeFile);
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
    const profile = this.profiles.getActiveProfile();
    if (!profile.model) {
      this.post({
        type: 'error',
        message: `Profile "${profile.name}" has no model configured. Pick one via the status bar or the "Heap Code: Select Model" command.`,
      });
      return;
    }
    if (images && images.length > 0 && !resolveCapabilities(profile).vision) {
      this.post({
        type: 'error',
        message:
          `Profile "${profile.name}" is not marked vision-capable, so images can't be sent. ` +
          'If your model does support images, set "capabilities": {"vision": true} on the profile (heapcode.profiles).',
      });
      return;
    }

    const userMessage = await this.buildUserMessage(text, files);
    if (images && images.length > 0) {
      userMessage.images = images.slice(0, MAX_IMAGES);
      if (!userMessage.content.trim()) userMessage.content = 'See the attached image(s).';
    }
    this.track?.('chat.message.sent');
    this.conversation.messages.push(userMessage);
    if (this.conversation.messages.length === 1) {
      this.conversation.title = (text || 'Image').slice(0, 60);
    }

    this.abortController = new AbortController();
    let assistant = '';
    const activeEditor = getActiveEditor();
    const activeFilePath = activeEditor
      ? vscode.workspace.asRelativePath(activeEditor.document.uri, false)
      : undefined;
    const instructions = await loadProjectInstructions(activeFilePath);

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
    const { window, source: windowSource } = await this.profiles.contextWindowFor(
      profile,
      profile.model,
    );
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
      source: windowSource,
    });

    try {
      const conversationMessages: ChatMessage[] = [systemMessage, ...history];
      // Unset max_tokens defaults to ~1k on some providers (e.g. NVIDIA NIM),
      // which cuts replies off mid-sentence. Capped at a quarter of the
      // window so small local models don't reject the request.
      const maxTokens = profile.maxTokens ?? Math.min(16_384, Math.floor(window / 4));
      const onDelta = (delta: string) => {
        assistant += delta;
        this.post({ type: 'chunk', text: delta });
      };

      // The turn runs server-side; what stays here is the half that needs the
      // workspace (running a read tool, labelling its chip) and the half that
      // needs the webview (rendering). Same split as the agent path.
      const ask = this.askToolSupport(profile);
      const { finishReason } = await this.link.chatSend(
        {
          profileName: profile.name,
          model: profile.model,
          messages: conversationMessages,
          temperature: profile.temperature,
          maxTokens,
          tools: ask?.tools,
        },
        {
          execute: ask ? (call) => ask.execute(call) : undefined,
          onEvent: (event) => {
            switch (event.type) {
              case 'text_delta':
                onDelta(event.text);
                break;
              case 'tool_call': {
                const call = { id: event.id, name: event.name, args: event.args };
                const description = ask?.describe(call) ?? event.name;
                this.log.appendLine(`[ask] tool: ${description}`);
                this.postToWebview({ type: 'agentToolCall', id: event.id, name: event.name, description });
                break;
              }
              case 'tool_result':
                this.postToWebview({
                  type: 'agentToolResult',
                  id: event.id,
                  ok: !event.isError,
                  summary: event.content.slice(0, TOOL_SUMMARY_CHARS),
                  label: resultLabel(event.name, event.content, event.isError),
                });
                break;
              default:
                break; // chat turns emit no other events
            }
          },
        },
        this.abortController.signal,
      );
      this.finishTurn(stripToolCallArtifacts(assistant));
      this.post({ type: 'done' });
      if (finishReason === 'length') {
        this.post({
          type: 'error',
          message:
            'The response was cut off: the model hit its output-token limit. ' +
            `Raise "Max output tokens" on profile "${profile.name}" (settings ⚙) or ask it to continue.`,
        });
      }
    } catch (err) {
      if (isAbortError(err)) {
        this.finishTurn(stripToolCallArtifacts(assistant)); // keep the partial response coherent in history
        this.post({ type: 'done' });
        return;
      }
      // Drop the failed turn — back through any ask-mode tool chips to the user message —
      // so retry doesn't duplicate.
      let lastUser = this.conversation.messages.length - 1;
      while (lastUser >= 0 && this.conversation.messages[lastUser]!.role !== 'user') lastUser--;
      if (lastUser >= 0) this.conversation.messages.splice(lastUser);
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[chat] error: ${message}`);
      this.post({ type: 'error', message });
    } finally {
      this.abortController = undefined;
    }
  }

  /**
   * Host-side half of the ask-mode tool loop: which tools chat may offer, how
   * to run one, and how to label it. The loop itself is core's
   * `runChatTurn` — only the parts that need the workspace live here.
   *
   * Undefined (→ a plain streamed reply) in exactly the three cases the
   * extracted method returned undefined for: the model can't do native tool
   * calls, there's no workspace, or no read tools survive the filter.
   */
  private askToolSupport(profile: ProviderProfileConfig):
    | {
        tools: ToolDefinition[];
        execute(call: ToolCall): Promise<ToolResult>;
        describe(call: ToolCall): string;
      }
    | undefined {
    if (!resolveCapabilities(profile).nativeToolCalls) return undefined;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return undefined;
    // Read-only, so core's loop never needs a permission prompt: runAgent's
    // gate only fires for non-read tools (agent/loop.ts:335, :339). ask_user
    // is excluded by NAME, not by permission — it is `permission: 'read'`
    // (toolDefinitions.ts:200), so filtering on permission alone would
    // silently hand chat a tool that blocks on the user.
    const readOnlyTools = agentToolDefinitions.filter(
      (t) => t.permission === 'read' && t.name !== 'ask_user',
    );
    if (readOnlyTools.length === 0) return undefined;

    // No semanticSearch injection, same as the agent path: chat/send dispatches
    // semantic_search from the server's own index and only hands the call back
    // here when it has nothing. Passing one would make the server ask this host
    // to run a tool whose answer this host would fetch back from the server —
    // the out-and-back docs/phase3-rag-design.md §5.2 exists to avoid.
    const executor = new WorkspaceToolExecutor(root, new SessionCheckpoint(), 60_000);
    return {
      tools: readOnlyTools,
      execute: (call) => executor.execute(call),
      describe: (call) => executor.describe(call),
    };
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
  <title>Heap Code Chat</title>
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
