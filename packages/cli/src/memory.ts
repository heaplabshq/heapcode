import {
  appendMemoryNote as appendMemoryNoteIn,
  loadProjectInstructions as loadProjectInstructionsIn,
  nodeFileTree,
} from '@heapcode/core';

export { MEMORY_TEMPLATE } from '@heapcode/core';

/**
 * Project instructions & memory (@heapcode/core) on Node's filesystem,
 * rooted at the workspace. Nothing in the CLI has an "active file" to pass,
 * so in practice only globally-scoped (`**`) instruction files apply.
 */
export function loadProjectInstructions(root: string, activeFilePath?: string): Promise<string> {
  return loadProjectInstructionsIn(nodeFileTree(root), activeFilePath);
}

export function appendMemoryNote(root: string, note: string): Promise<void> {
  return appendMemoryNoteIn(nodeFileTree(root), note);
}
