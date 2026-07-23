import { randomUUID } from 'node:crypto';
import type { Conversation, StoredMessage } from '@heapcode/core';
import { ConfigStore } from './config/store.js';
import { JsonConversationStore } from './history/store.js';
import { conversationsFile } from './paths.js';
import { resolveProvider } from './provider/resolve.js';
import { sendMessage } from './session.js';

export interface HeadlessOptions {
  prompt: string;
  json: boolean;
  profileName?: string;
  newConversation?: boolean;
  cwd?: string;
}

interface HeadlessResult {
  response: string;
  model: string;
  profile: string;
}

/**
 * The `-p`/`--json` non-interactive path. Never mounts Ink — see
 * docs/CLI_PLAN.md's architecture decision: headless is a thin front end
 * over the same `sendMessage` runner the interactive UI uses, not a
 * stripped-down copy of it, so it can't silently drift from the real
 * chat behavior.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const config = new ConfigStore();
  const profile = opts.profileName ? await config.getProfile(opts.profileName) : await config.getActiveProfile();

  if (!profile) {
    printError(opts.json, 'No provider profile configured. Run "heapcode profile add" first.');
    return 1;
  }

  try {
    const { provider } = await resolveProvider(profile);
    const historyStore = new JsonConversationStore(conversationsFile(opts.cwd));
    let conversation = opts.newConversation ? undefined : await historyStore.mostRecent();
    conversation ??= { id: randomUUID(), title: opts.prompt.slice(0, 60), updatedAt: Date.now(), messages: [] };

    const { userMessage, assistantMessage } = await sendMessage({
      provider,
      profile,
      history: conversation.messages,
      userText: opts.prompt,
    });

    conversation.messages.push(userMessage as StoredMessage, assistantMessage as StoredMessage);
    conversation.updatedAt = Date.now();
    await historyStore.save(conversation as Conversation);

    const result: HeadlessResult = { response: assistantMessage.content, model: profile.model, profile: profile.name };
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      process.stdout.write(result.response + '\n');
    }
    return 0;
  } catch (err) {
    printError(opts.json, err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function printError(json: boolean, message: string): void {
  if (json) {
    process.stderr.write(JSON.stringify({ error: message }) + '\n');
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
}
