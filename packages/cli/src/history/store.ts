import { JsonConversationStore as CoreJsonConversationStore, nodeTextFile } from '@heapcode/core';
import { conversationsFile } from '../paths.js';

/**
 * The shared JSON conversation store (@heapcode/core) on Node's filesystem,
 * defaulting to this project's own state directory. Everything but the file
 * access itself lives in core, shared with the extension.
 */
export class JsonConversationStore extends CoreJsonConversationStore {
  constructor(path: string = conversationsFile()) {
    super(nodeTextFile(path));
  }
}
