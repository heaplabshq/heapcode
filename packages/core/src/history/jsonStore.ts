import type { TextFileStore } from '../fs.js';
import type { Conversation, ConversationMeta, ConversationStore } from './types.js';

const MAX_CONVERSATIONS = 200;

/**
 * Conversation history as a single JSON file, cached in memory and rewritten
 * whole on every change. Deliberately not a database: guardrail #5 says no
 * native modules without need, and 200 conversations of chat text is not a
 * need.
 *
 * Where that file lives is the host's business — the extension puts it in
 * extension storage (workspace-scoped when a folder is open, global
 * otherwise), the CLI under the project's own state directory — so it
 * arrives as a TextFileStore rather than a path.
 */
export class JsonConversationStore implements ConversationStore {
  private cache?: Conversation[];

  constructor(private readonly file: TextFileStore) {}

  private async load(): Promise<Conversation[]> {
    if (this.cache) return this.cache;
    const text = await this.file.read();
    try {
      this.cache = text ? (JSON.parse(text) as Conversation[]) : [];
    } catch {
      this.cache = []; // corrupt file — start over rather than crash the session
    }
    return this.cache;
  }

  private persist(): Promise<void> {
    return this.file.write(JSON.stringify(this.cache ?? []));
  }

  async list(): Promise<ConversationMeta[]> {
    const all = await this.load();
    return all
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Conversation | undefined> {
    return (await this.load()).find((c) => c.id === id);
  }

  /**
   * Resolves an exact id or an unambiguous short prefix (same convenience as
   * a git short hash) — what `heapcode --resume <id>` and its headless
   * equivalent take, matching the short id printed on exit. Returns
   * undefined for no match OR an ambiguous prefix (multiple conversations
   * share it) — callers should treat both the same: ask for more characters.
   */
  async findByIdOrPrefix(idOrPrefix: string): Promise<Conversation | undefined> {
    const all = await this.load();
    const exact = all.find((c) => c.id === idOrPrefix);
    if (exact) return exact;
    const matches = all.filter((c) => c.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  async mostRecent(): Promise<Conversation | undefined> {
    const all = await this.load();
    return all.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  async save(conversation: Conversation): Promise<void> {
    const all = await this.load();
    const index = all.findIndex((c) => c.id === conversation.id);
    if (index >= 0) all[index] = conversation;
    else all.push(conversation);
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    this.cache = all.slice(0, MAX_CONVERSATIONS);
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    this.cache = (await this.load()).filter((c) => c.id !== id);
    await this.persist();
  }
}
