import type {
  UiConversationMeta,
  UiEventParams,
  UiFolderEntry,
  UiMessage,
  UiRecentWorkspace,
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

  // host → browser (requests)
  askUser: 'chat/askUser',

  // host → browser (notifications)
  event: 'chat/event',
  stateChanged: 'chat/stateChanged',
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

export interface ChatBrowseFoldersResult {
  path: string;
  parent?: string;
  entries: UiFolderEntry[];
}

export interface ChatRecentFoldersResult {
  current: string;
  recent: UiRecentWorkspace[];
  home: string;
}

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

export interface ChatSettings {
  profiles: Array<{ name: string; model: string; hasKey: boolean; baseUrl?: string; preset?: string }>;
  activeProfile: string;
  webSearch: boolean;
  embeddingsConfigured: boolean;
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

export type { UiConversationMeta as ChatConversationMeta, UiEventParams as ChatEventParams, UiMessage as ChatMessageEntry };
