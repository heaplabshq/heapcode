import type { ConversationMeta } from './history/types.js';

/**
 * Typed message protocol between the VS Code extension host and the webview UI.
 * Single source of truth — both sides import these types.
 */

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SlashCommandInfo {
  command: string;
  title: string;
}

/** Commands the webview may ask the extension to run (allowlist). */
export type WebviewCommand = 'selectProfile' | 'selectModel' | 'setApiKey';

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
  | { type: 'agentStart'; task: string; files?: string[] }
  | { type: 'agentStop' }
  | { type: 'agentRevert' }
  | { type: 'agentDiffFile'; path: string }
  | { type: 'agentRevertFile'; path: string }
  | { type: 'agentKeepFile'; path: string };

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
  | { type: 'history'; items: ConversationMeta[] }
  | { type: 'conversation'; id: string; messages: DisplayMessage[] }
  | { type: 'newChatStarted' }
  | { type: 'contextFiles'; files: string[] }
  | { type: 'agentText'; text: string }
  | { type: 'agentPlan'; text: string }
  | { type: 'agentToolCall'; id: string; name: string; description: string }
  | { type: 'agentToolResult'; id: string; ok: boolean; summary: string; label: string }
  | { type: 'agentStatus'; status: AgentRunStatus; changedFiles: string[] };
