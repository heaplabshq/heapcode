import type { ConversationMeta } from './history/types.js';
import type { ProviderProfileConfig } from './config/profiles.js';

/**
 * Typed message protocol between the VS Code extension host and the webview UI.
 * Single source of truth — both sides import these types.
 */

export interface ToolDisplay {
  name: string;
  description: string;
  ok: boolean;
  label?: string;
  fileEdit?: FileEditInfo;
}

export interface FileEditInfo {
  path: string;
  added: number;
  removed: number;
}

/** A file the agent changed this session, with its Keep/Revert/Reapply state. */
export interface ChangedFile {
  path: string;
  /** Currently showing the pre-agent content (user clicked Revert). */
  reverted: boolean;
}

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  plan?: boolean;
  tool?: ToolDisplay;
  status?: { state: string };
}

export type PermissionChoice = 'allow' | 'session' | 'always' | 'deny';

export interface SlashCommandInfo {
  command: string;
  title: string;
}

/** Commands the webview may ask the extension to run (allowlist). */
export type WebviewCommand = 'selectProfile' | 'selectModel' | 'setApiKey' | 'addProfile';

/** Provider preset info the settings panel needs (subset of ProviderPreset). */
export interface SettingsPresetInfo {
  id: string;
  label: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  local: boolean;
}

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'send'; text: string; files?: string[] }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'listHistory' }
  | { type: 'openConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'runCommand'; command: WebviewCommand }
  | { type: 'insertCode'; code: string }
  | { type: 'applyCode'; code: string }
  | { type: 'pickContextFiles' }
  /** URIs dropped onto the composer (files or folders) — resolve to attachments. */
  | { type: 'resolveDropped'; uris: string[] }
  | { type: 'listModels' }
  | { type: 'setModel'; model: string }
  | { type: 'setProfile'; name: string }
  | { type: 'permissionResponse'; id: string; choice: PermissionChoice }
  | { type: 'agentQuestionResponse'; id: string; answer: string }
  | { type: 'settingsLoad' }
  /**
   * Create or update a profile. `original` is the pre-edit name (absent for a
   * new profile). `apiKey`: undefined = leave unchanged, '' = clear, else set.
   */
  | { type: 'settingsSaveProfile'; original?: string; profile: ProviderProfileConfig; apiKey?: string }
  | { type: 'settingsDeleteProfile'; name: string }
  | { type: 'settingsActivateProfile'; name: string }
  /** Open the native VS Code settings UI filtered to this extension. */
  | { type: 'openNativeSettings' }
  | { type: 'openInTerminal'; command: string }
  | { type: 'openReference'; text: string }
  | { type: 'agentStart'; task: string; files?: string[] }
  | { type: 'agentStop' }
  | { type: 'agentRevert' }
  | { type: 'agentDiffFile'; path: string }
  | { type: 'agentRevertFile'; path: string }
  | { type: 'agentReapplyFile'; path: string }
  | { type: 'agentKeepFile'; path: string }
  /**
   * Edit the Nth user message (0-based, counting user turns): truncates the
   * conversation there, restores the workspace to that turn's checkpoint,
   * and resends the new text.
   */
  | { type: 'editUserMessage'; ordinal: number; text: string; files?: string[]; mode: 'chat' | 'agent' };

export type AgentRunStatus = 'running' | 'done' | 'stopped' | 'max-iterations' | 'error';

export type ExtensionToWebview =
  | {
      type: 'config';
      profile: string;
      model: string;
      slashCommands: SlashCommandInfo[];
    }
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /** A user turn initiated from the extension (context menu, code action). */
  | { type: 'userMessage'; text: string }
  /** Display-only user turn (no assistant placeholder) — used when resending an edited prompt in agent mode. */
  | { type: 'userTurn'; text: string; files?: string[] }
  | { type: 'history'; items: ConversationMeta[] }
  | { type: 'conversation'; id: string; messages: DisplayMessage[] }
  | { type: 'newChatStarted' }
  | { type: 'contextFiles'; files: string[] }
  | { type: 'activeFile'; path: string | null }
  | { type: 'models'; profiles: Array<{ name: string; active: boolean }>; models: string[] }
  | {
      type: 'permissionRequest';
      id: string;
      description: string;
      permission: string;
      allowPersist: boolean;
    }
  /** The agent's ask_user tool: a question card in the chat. */
  | { type: 'agentQuestion'; id: string; question: string; options?: string[] }
  /** Everything the settings panel renders. `keySaved[name]` = an API key exists for that profile. */
  | {
      type: 'settingsData';
      profiles: ProviderProfileConfig[];
      active: string;
      presets: SettingsPresetInfo[];
      keySaved: Record<string, boolean>;
    }
  | { type: 'agentText'; text: string }
  | { type: 'agentTextDelta'; text: string }
  | { type: 'agentTextEnd' }
  | { type: 'agentReasoningDelta'; text: string }
  | { type: 'agentReasoningEnd' }
  | { type: 'agentToolStream'; chars: number }
  | { type: 'agentPlan'; text: string }
  | {
      type: 'agentToolCall';
      id: string;
      name: string;
      description: string;
      /** For run_command: the shell command, so the UI can offer "run in terminal". */
      terminalCommand?: string;
    }
  | {
      type: 'agentToolResult';
      id: string;
      ok: boolean;
      summary: string;
      label: string;
      fileEdit?: FileEditInfo;
    }
  | { type: 'agentStatus'; status: AgentRunStatus; changedFiles: ChangedFile[] }
  /** Estimated prompt tokens vs the model's context window (chat + agent). */
  | { type: 'contextUsage'; used: number; window: number }
  /** Older turns were summarized to fit the context window. */
  | { type: 'compacted'; before: number; after: number };
