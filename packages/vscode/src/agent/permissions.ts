import * as vscode from 'vscode';
import {
  PermissionEngine as CorePermissionEngine,
  type PermissionChoice,
  type PermissionClass,
  type PermissionGrantStore,
  type PermissionMode,
  type PermissionRequest,
} from '@heapcode/core';

const KEY_PREFIX = 'heapcode.perm.';

/**
 * Asks in the chat view (inline card, Copilot-style); a request that arrives
 * while the chat isn't available returns undefined and falls through to the
 * modal dialog below.
 */
export type ChatPermissionRequester = (req: PermissionRequest) => Promise<PermissionChoice | undefined>;

/**
 * The shared permission engine (@heapcode/core) with persisted "Always"
 * grants in workspaceState, Safe Mode read from settings, and the
 * extension's two request channels: the in-chat card first, the modal
 * dialog behind it. The CLI has one channel and no fallback.
 */
export class PermissionEngine extends CorePermissionEngine {
  constructor(
    state: vscode.Memento,
    log?: vscode.OutputChannel,
    track?: (name: string, meta?: Record<string, unknown>) => void,
    /** The chat view's current permission mode — read per request, so the mode chip takes effect mid-run. */
    mode?: () => PermissionMode,
  ) {
    super({
      grants: mementoGrantStore(state),
      mode,
      safeMode: () => vscode.workspace.getConfiguration('heapcode.agent').get<boolean>('safeMode', false),
      log: log ? (message) => log.appendLine(message) : undefined,
      track,
      resetHint: '"Heap Code: Reset Agent Permissions"',
      fallbackRequester: modalRequest,
    });
  }

  attachChatRequester(requester: ChatPermissionRequester): void {
    this.attachRequester(requester);
  }
}

function mementoGrantStore(state: vscode.Memento): PermissionGrantStore {
  return {
    has: (key) => Promise.resolve(state.get<'always'>(KEY_PREFIX + key) === 'always'),
    add: async (key) => {
      await state.update(KEY_PREFIX + key, 'always');
    },
    clear: async () => {
      let cleared = 0;
      for (const key of state.keys()) {
        if (key.startsWith(KEY_PREFIX)) {
          await state.update(key, undefined);
          cleared++;
        }
      }
      return cleared;
    },
  };
}

async function modalRequest({ permission, description, allowPersist }: PermissionRequest): Promise<PermissionChoice> {
  const buttons = allowPersist
    ? (['Allow Once', 'Allow This Session', 'Always Allow'] as const)
    : (['Allow Once'] as const);
  const picked = await vscode.window.showWarningMessage(
    `Heap Code Agent wants to ${permissionLabel(permission)}`,
    { modal: true, detail: description },
    ...buttons,
  );
  switch (picked) {
    case 'Allow Once':
      return 'allow';
    case 'Allow This Session':
      return 'session';
    case 'Always Allow':
      return 'always';
    default:
      return 'deny';
  }
}

function permissionLabel(p: PermissionClass): string {
  switch (p) {
    case 'write':
      return 'modify files';
    case 'execute':
      return 'run a command';
    case 'destructive':
      return 'perform a DESTRUCTIVE action';
    default:
      return p;
  }
}
