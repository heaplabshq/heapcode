import { randomUUID } from 'node:crypto';
import React from 'react';
import { render } from 'ink';
import type { Conversation } from '@heapcode/core';
import { ConfigStore } from './config/store.js';
import { JsonConversationStore } from './history/store.js';
import { conversationsFile } from './paths.js';
import { profileAdd, profileList, profileRemove, profileUse } from './profileCli.js';
import { resolveProvider } from './provider/resolve.js';
import { runHeadless } from './headless.js';
import { App } from './ink/App.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === 'profile') {
    const [, sub, arg] = argv;
    if (sub === 'add') return profileAdd();
    if (sub === 'list') return profileList();
    if (sub === 'use' && arg) return profileUse(arg);
    if (sub === 'remove' && arg) return profileRemove(arg);
    console.log('Usage: heapcode profile <add|list|use NAME|remove NAME>');
    process.exitCode = 1;
    return;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const promptIndex = argv.findIndex((a) => a === '-p' || a === '--prompt');
  const profileFlagIndex = argv.findIndex((a) => a === '--profile');
  const profileName = profileFlagIndex >= 0 ? argv[profileFlagIndex + 1] : undefined;
  const newConversation = argv.includes('--new');

  if (promptIndex >= 0) {
    const prompt = argv[promptIndex + 1];
    if (!prompt) {
      console.error('Usage: heapcode -p "<message>" [--json] [--profile NAME] [--new]');
      process.exitCode = 1;
      return;
    }
    const code = await runHeadless({ prompt, json: argv.includes('--json'), profileName, newConversation });
    process.exitCode = code;
    return;
  }

  // Interactive mode.
  const config = new ConfigStore();
  const profile = profileName ? await config.getProfile(profileName) : await config.getActiveProfile();
  if (!profile) {
    console.log('No provider profile configured yet.\n');
    console.log('Run "heapcode profile add" to set one up (Ollama, OpenAI, OpenRouter, and more).');
    process.exitCode = 1;
    return;
  }

  const { provider } = await resolveProvider(profile);
  const historyStore = new JsonConversationStore(conversationsFile());
  let conversation: Conversation | undefined = newConversation ? undefined : await historyStore.mostRecent();
  conversation ??= { id: randomUUID(), title: 'New conversation', updatedAt: Date.now(), messages: [] };

  render(<App provider={provider} profile={profile} conversation={conversation} historyStore={historyStore} />);
}

function printHelp(): void {
  console.log(`heapcode — model-agnostic AI coding assistant (terminal)

Usage:
  heapcode                          Start an interactive chat session
  heapcode --new                    Start a new conversation (default: continue the most recent one in this directory)
  heapcode --profile NAME           Use a specific provider profile for this session
  heapcode -p "<message>" [--json]  Headless: one message in, one reply out, no TTY required

  heapcode profile add              Configure a new provider profile
  heapcode profile list             List configured profiles
  heapcode profile use NAME         Switch the active profile
  heapcode profile remove NAME      Delete a profile

Config: ~/.heapcode/config.json (profiles)  ·  ~/.heapcode/secrets.json (API keys, chmod 600)
History: <cwd>/.heapcode/conversations.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
