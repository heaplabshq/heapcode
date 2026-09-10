import type {
  UiArtifactMeta,
  UiArtifactResult,
  UiArtifactsResult,
  UiBrowseFoldersResult,
  UiFileTreeResult,
  UiReadFileResult,
  UiSaveArtifactResult,
  UiTreeEntry,
  UiConnectionModelsResult,
  UiConversationMeta,
  UiEventParams,
  UiMcpSignInResult,
  UiMessage,
  UiProbeProviderParams,
  UiProbeProviderResult,
  UiSaveProfileParams,
  UiSetRoleParams,
  UiSettings,
  UiWorkspacesResult,
} from '@heapcode/web-host/protocol';

/**
 * Heap Chat's browser protocol.
 *
 * A separate method namespace (`chat/…`) rather than a subset of `ui/…`,
 * because the two products' surfaces are allowed to diverge and a shared
 * namespace would make every divergence look like a version skew. The
 * *message shapes* are reused from `@heapcode/web-host/protocol` wherever they
 * are genuinely neutral — a transcript entry and a streamed agent event have
 * no product opinion in them, and two descriptions of the same shape would
 * drift.
 *
 * Absent here, and deliberately: everything the workspace panel needs
 * (`changes`, `diff`, `checkpoints`, `rewind`, `revert*`, `fileTree`,
 * `readFile`), `review`, `repoMap`, `runCommand`, and `restoreTurn`/
 * `editMessage`. Those are checkpoint- and code-shaped; this host takes no
 * snapshots because it changes nothing.
 */
export const CHAT_PROTOCOL_VERSION = 1;

export const CHAT_METHODS = {
  // browser → host
  hello: 'chat/hello',
  state: 'chat/state',
  sendMessage: 'chat/sendMessage',
  cancel: 'chat/cancel',
  conversations: 'chat/conversations',
  openConversation: 'chat/openConversation',
  newConversation: 'chat/newConversation',
  listModels: 'chat/listModels',
  setModel: 'chat/setModel',
  settings: 'chat/settings',
  /** Folders opened before, for the picker. */
  recentFolders: 'chat/recentFolders',
  browseFolders: 'chat/browseFolders',
  setFolder: 'chat/setFolder',
  indexStatus: 'chat/indexStatus',
  reindex: 'chat/reindex',
  /** What the assistant has been told to remember about this person. */
  memory: 'chat/memory',
  forget: 'chat/forget',

  // The folder, and what the assistant has produced from it.
  fileTree: 'chat/fileTree',
  readFile: 'chat/readFile',
  artifacts: 'chat/artifacts',
  artifact: 'chat/artifact',
  saveArtifact: 'chat/saveArtifact',
  // MCP servers — the same connectors Heap Code registers, from the same config.
  saveMcpServer: 'chat/saveMcpServer',
  deleteMcpServer: 'chat/deleteMcpServer',
  signInMcpServer: 'chat/signInMcpServer',
  signOutMcpServer: 'chat/signOutMcpServer',

  // settings — the same surface Heap Code's dialog drives, because the things
  // it edits (connections, the model role table, web search) are global
  // config shared by both products. A second, smaller settings screen would
  // have meant two places to add a provider.
  saveProfile: 'chat/saveProfile',
  deleteProfile: 'chat/deleteProfile',
  useProfile: 'chat/useProfile',
  setRole: 'chat/setRole',
  listConnectionModels: 'chat/listConnectionModels',
  probeProvider: 'chat/probeProvider',
  setWebSearch: 'chat/setWebSearch',

  // host → browser (requests)
  askUser: 'chat/askUser',
  permission: 'chat/permission',

  // host → browser (notifications)
  event: 'chat/event',
  /** What the finished answer stands on: sources, traced numbers, a verdict. */
  grounding: 'chat/grounding',
  stateChanged: 'chat/stateChanged',
  /** An artifact was created or got a new version. */
  artifactChanged: 'chat/artifactChanged',
  indexChanged: 'chat/indexChanged',
} as const;

export interface ChatHelloParams {
  protocolVersion: number;
  client?: { name: string; version?: string };
  resumeRunId?: string;
}

export interface ChatHelloResult {
  protocolVersion: number;
  state: ChatState;
  messages: UiMessage[];
  activeRunId?: string;
  replay?: UiEventParams[];
  pending?: UiMessage[];
}

/**
 * What the page needs to render its chrome.
 *
 * Compare `UiState`: no `persona` (Heap Chat has one identity and no picker
 * for it) and no `permissionMode` (its roster is read-only, so there is
 * nothing to gate). `folder` rather than `root`/`workspaceName` — the noun
 * this product uses with the person is a folder, not a workspace.
 */
export interface ChatState {
  folder: string;
  folderName: string;
  profile: string;
  model: string;
  contextWindow?: number;
  profiles: Array<{ name: string; model: string; hasKey: boolean }>;
  daemon: 'up' | 'down';
  runId?: string;
  lan?: boolean;
}

/**
 * The whole state, every time — not a patch.
 *
 * A partial update cannot clear a field: `runId: undefined` does not survive
 * JSON, so a client merging patches keeps the last run id forever and the
 * composer sits on "Stop" after the run has ended. Sending the full object
 * makes the notification authoritative and the client a replace, not a merge.
 */
export type ChatStateChangedParams = ChatState;

export interface ChatSendMessageParams {
  text: string;
  runId?: string;
  /** Pasted or dropped images, as `data:` URLs. Bounded host-side. */
  images?: string[];
}

export interface ChatSendMessageResult {
  runId: string;
  outcome: unknown;
  maxIterations: number;
}

/** Host → browser once a turn's grounding has been computed. */
export interface ChatGroundingParams {
  runId: string;
  grounding: import('./grounding.js').Grounding;
}

export interface ChatCancelParams {
  runId: string;
}

export interface ChatOpenConversationParams {
  id: string;
}

export interface ChatOpenConversationResult {
  id: string;
  messages: UiMessage[];
}

export interface ChatListModelsParams {
  profileName?: string;
}

export interface ChatListModelsResult {
  models: Array<{ id: string; contextLength?: number }>;
}

export interface ChatSetModelParams {
  model: string;
}

export interface ChatBrowseFoldersParams {
  path?: string;
}

/** Identical to Heap Code's, so `WorkspacePicker` drives both unchanged. */
export type ChatBrowseFoldersResult = UiBrowseFoldersResult;
export type ChatRecentFoldersResult = UiWorkspacesResult;

export interface ChatSetFolderParams {
  path: string;
}

export interface ChatSetFolderResult {
  state: ChatState;
  messages: UiMessage[];
}

/**
 * The index, as the page shows it.
 *
 * Narrower than `UiIndexStatus`: no repo map, because there is no repo. What a
 * person wants to know here is whether their documents are searchable yet.
 */
export interface ChatIndexStatus {
  state: 'idle' | 'indexing' | 'ready' | 'error' | 'unconfigured';
  files: number;
  chunks: number;
  message?: string;
  progress?: { embedded: number; total: number };
  /**
   * Optional parsers that are not installed, so the page can say which file
   * types are being skipped. Absent when everything Heap Chat claims to read
   * is actually readable.
   */
  missingParsers?: string[];
}

/**
 * The same settings payload Heap Code sends.
 *
 * Not a narrower shape of its own: the dialog that renders it is
 * `@heapcode/web-ui`'s, and a second shape would have meant a second dialog.
 * The fields this product has no concept of — personas, permission mode,
 * sub-agents, MCP servers, permission grants — are sent empty, and the pages
 * that would show them are not offered.
 */
export type ChatSettings = UiSettings;

export interface ChatMemoryResult {
  entries: Array<{ id: string; text: string; at: string }>;
}

export interface ChatForgetParams {
  id: string;
}

export interface ChatAskUserParams {
  runId: string;
  callId: string;
  question: string;
  options?: string[];
  blocksAction?: boolean;
}

export interface ChatAskUserResult {
  answer: string;
}

/**
 * `chat/permission` — an MCP server's tool wants to run.
 *
 * Only ever raised for those. Heap Chat's own roster cannot change anything,
 * which is what lets it run without asking; a connector's tools are ordinary
 * third-party code and may do whatever they were written to do.
 */
export interface ChatPermissionParams {
  runId: string;
  callId: string;
  /** Prefixed name, as the model called it. */
  tool: string;
  /** The connector it belongs to, for a sentence a person can act on. */
  server: string;
  /** Arguments, rendered for review. */
  args: Record<string, unknown>;
}

export interface ChatPermissionResult {
  granted: boolean;
  /** Stop asking for this tool for the rest of this conversation. */
  remember?: boolean;
}

export type {
  UiArtifactMeta as ChatArtifactMeta,
  UiArtifactResult as ChatArtifactResult,
  UiArtifactsResult as ChatArtifactsResult,
  UiFileTreeResult as ChatFileTreeResult,
  UiReadFileResult as ChatReadFileResult,
  UiSaveArtifactResult as ChatSaveArtifactResult,
  UiTreeEntry as ChatTreeEntry,
  UiConversationMeta as ChatConversationMeta,
  UiEventParams as ChatEventParams,
  UiMcpSignInResult as ChatMcpSignInResult,
  UiMessage as ChatMessageEntry,
  UiConnectionModelsResult as ChatConnectionModelsResult,
  UiProbeProviderParams as ChatProbeProviderParams,
  UiProbeProviderResult as ChatProbeProviderResult,
  UiSaveProfileParams as ChatSaveProfileParams,
  UiSetRoleParams as ChatSetRoleParams,
};
