import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Conversation, ConversationMeta, ConversationStore } from '@heapcode/core';
import { conversationsFile } from '../paths.js';

const MAX_CONVERSATIONS = 200;

/**
 * Node-native port of packages/vscode/src/historyStore.ts's
 * JsonConversationStore — same JSON-file-in-storage-dir design (fs/promises
 * instead of vscode.workspace.fs), same 200-conversation cap. Stored at
 * <cwd>/.heapcode/conversations.json, matching the extension's
 * workspace-scoped default and the project's existing .heapcode/ convention.
 */
export class JsonConversationStore implements ConversationStore {
  private cache?: Conversation[];

  constructor(private readonly path: string = conversationsFile()) {}

  private async load(): Promise<Conversation[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, 'utf8')) as Conversation[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.cache ?? []), 'utf8');
  }

  async list(): Promise<ConversationMeta[]> {
    const all = await this.load();
    return all.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Conversation | undefined> {
    return (await this.load()).find((c) => c.id === id);
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
