import * as vscode from 'vscode';
import type { Conversation, ConversationMeta, ConversationStore } from '@heapcode/core';

const FILE_NAME = 'conversations.json';
const MAX_CONVERSATIONS = 200;

/**
 * Conversation history as a JSON file in extension storage (workspace-scoped
 * when a folder is open, global otherwise). SQLite lands with RAG in M5 —
 * guardrail #5 says no native modules without need.
 */
export class JsonConversationStore implements ConversationStore {
  private cache?: Conversation[];

  constructor(private readonly storageDir: vscode.Uri) {}

  private get fileUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageDir, FILE_NAME);
  }

  private async load(): Promise<Conversation[]> {
    if (this.cache) return this.cache;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      this.cache = JSON.parse(new TextDecoder().decode(bytes)) as Conversation[];
    } catch {
      this.cache = []; // first run or corrupt file
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.storageDir);
    await vscode.workspace.fs.writeFile(
      this.fileUri,
      new TextEncoder().encode(JSON.stringify(this.cache ?? [])),
    );
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
