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
  /** Truncated tool output for the expandable chip; persisted so history reloads keep it. */
  summary?: string;
  fileEdit?: FileEditInfo;
  /** Shadow-git commit taken just before this tool call ran — lets the user rewind to this exact step (PLAN.md M8). */
  checkpoint?: string;
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
  /** Attached images (data: URLs) shown as thumbnails on user turns. */
  images?: string[];
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

/** How the effective context window was determined (shown in the meter popup). */
export type ContextWindowSource = 'profile' | 'model' | 'preset' | 'default';

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
  | { type: 'send'; text: string; files?: string[]; images?: string[] }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'listHistory' }
  | { type: 'openConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'runCommand'; command: WebviewCommand }
  | { type: 'insertCode'; code: string }
  | { type: 'applyCode'; code: string }
  | { type: 'pickContextFiles' }
  /** OS file dialog (+ button): images become vision attachments, other files context. */
  | { type: 'pickUpload' }
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
  /** Toggles `heapcode.agent.subAgents` — surfaced here so the opt-in isn't only discoverable via native VS Code settings. */
  | { type: 'settingsSetSubAgents'; enabled: boolean }
  /**
   * Fetch the model list for the profile being edited (not necessarily saved
   * yet) so its "Chat model" and role fields can offer a dropdown. `apiKey`:
   * a freshly-typed key to try, else falls back to `originalName`'s saved key.
   */
  | {
      type: 'settingsTestConnection';
      profile: ProviderProfileConfig;
      apiKey?: string;
      originalName?: string;
    }
  /** Open the native VS Code settings UI filtered to this extension. */
  | { type: 'openNativeSettings' }
  /** Tools picker: list agent tools with their enabled state. */
  | { type: 'listTools' }
  | { type: 'setToolEnabled'; name: string; enabled: boolean }
  | { type: 'openInTerminal'; command: string }
  | { type: 'openReference'; text: string }
  /** `persona` selects a built-in tool-scoped persona (see agent/personas.ts); omit for full access. */
  | { type: 'agentStart'; task: string; files?: string[]; images?: string[]; persona?: string }
  | { type: 'agentStop' }
  | { type: 'agentRevert' }
  | { type: 'agentKeepAll' }
  | { type: 'agentDiffFile'; path: string }
  | { type: 'agentRevertFile'; path: string }
  | { type: 'agentReapplyFile'; path: string }
  | { type: 'agentKeepFile'; path: string }
  /** Approve a pending plan (agentStatus status 'planned') and let the agent execute it. */
  | { type: 'agentApprovePlan' }
  /**
   * Edit the Nth user message (0-based, counting user turns): truncates the
   * conversation there, restores the workspace to that turn's checkpoint,
   * and resends the new text.
   */
  | {
      type: 'editUserMessage';
      ordinal: number;
      text: string;
      files?: string[];
      mode: 'chat' | 'agent';
      persona?: string;
    }
  /**
   * Restore the workspace files to the checkpoint taken before the Nth user
   * turn (0-based) ran, without touching the conversation.
   */
  | { type: 'restoreCheckpoint'; ordinal: number }
  /** Restore the workspace to the shadow-git commit taken before one specific tool call (PLAN.md M8). */
  | { type: 'restoreToolCheckpoint'; hash: string };

export type AgentRunStatus = 'running' | 'done' | 'stopped' | 'max-iterations' | 'error' | 'planned' | 'incomplete';

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
  /** Dropped image files, read by the extension and converted to data: URLs. */
  | { type: 'imageAttachments'; images: string[] }
  /** Agent tools grouped by source (built-in category, MCP server, or contributing VS Code extension), for the composer's tools picker. */
  | {
      type: 'toolsList';
      groups: Array<{
        id: string;
        label: string;
        tools: Array<{ name: string; label: string; description: string; enabled: boolean }>;
      }>;
    }
  /** Active editor file; `selection` (1-based lines) present while text is selected. */
  | { type: 'activeFile'; path: string | null; selection?: { start: number; end: number } }
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
      /** Current value of `heapcode.agent.subAgents` (default false — an opt-in, autonomy-increasing capability). */
      subAgentsEnabled: boolean;
    }
  /** Result of 'settingsTestConnection' — empty `models` + `error` set means the test failed. */
  | { type: 'settingsModels'; models: string[]; error?: string }
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
      /**
       * Set when a sub-agent made this call: the id of the delegate_task call
       * that spawned it. The chat indents these — which is the whole of what
       * sub-agent rendering is, now that recursion happens server-side
       * (docs/phase3-protocol-design.md §2).
       */
      parent?: string;
    }
  | {
      type: 'agentToolResult';
      id: string;
      ok: boolean;
      summary: string;
      label: string;
      fileEdit?: FileEditInfo;
      /** Shadow-git commit taken just before this call ran, if it wasn't read-only (PLAN.md M8). */
      checkpoint?: string;
      /** See agentToolCall.parent. */
      parent?: string;
    }
  | { type: 'agentStatus'; status: AgentRunStatus; changedFiles: ChangedFile[] }
  /** Estimated prompt tokens vs the model's context window (chat + agent). */
  | { type: 'contextUsage'; used: number; window: number; source?: ContextWindowSource }
  /** Older turns were summarized to fit the context window. */
  | { type: 'compacted'; before: number; after: number };
