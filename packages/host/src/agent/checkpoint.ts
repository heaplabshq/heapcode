import { SessionCheckpoint as CoreSessionCheckpoint, nodeFileHandles } from '@heapcode/core';

/**
 * The shared session checkpoint (@heapcode/core) on Node's filesystem,
 * addressed by absolute path and reported relative to the workspace root.
 * The before/after snapshot and the revert/reapply/keep state machine are
 * shared with the extension.
 */
export class SessionCheckpoint extends CoreSessionCheckpoint<string> {
  constructor(root: string) {
    super(nodeFileHandles(root));
  }
}
