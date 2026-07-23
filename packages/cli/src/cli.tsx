import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { configureAstChunker, resolveCapabilities, type Conversation } from '@heapcode/core';
import { ConfigStore } from './config/store.js';
import { JsonConversationStore } from './history/store.js';
import { canonicalize, conversationsFile, permissionsFile, shadowGitDir } from './paths.js';
import { profileAdd, profileList, profileRemove, profileUse } from './profileCli.js';
import { resolveProvider } from './provider/resolve.js';
import { runHeadless } from './headless.js';
import { agentToolDefinitions, WorkspaceToolExecutor } from './agent/workspaceTools.js';
import { SessionCheckpoint } from './agent/checkpoint.js';
import { PermissionEngine } from './agent/permissions.js';
import { ShadowGit } from './agent/shadowGit.js';
import { App } from './ink/App.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
configureAstChunker((filename) => join(__dirname, 'wasm', filename));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === 'profile') {
    const [, sub, arg] = argv;
    if (sub === 'add') {
      await profileAdd();
      return;
    }
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
  let profile = profileName ? await config.getProfile(profileName) : await config.getActiveProfile();
  if (!profile) {
    if (profileName) {
      // An explicit --profile NAME that doesn't exist is a mistake worth surfacing
      // clearly, not something to silently paper over with a fresh setup wizard.
      console.error(`No profile named "${profileName}". Run "heapcode profile list" to see configured profiles.`);
      process.exitCode = 1;
      return;
    }
    // No profile configured — walk straight into onboarding instead of erroring
    // out and telling the user to run a separate command (Setup's own banner
    // explains what's happening; no extra console.log needed here).
    profile = await profileAdd();
  }

  const { provider, contextWindow } = await resolveProvider(profile);
  // Canonicalized once here and threaded through every root-taking class below —
  // see paths.ts's canonicalize() for why they'd otherwise silently disagree.
  const root = canonicalize(process.cwd());
  const historyStore = new JsonConversationStore(conversationsFile(root));
  let conversation: Conversation | undefined = newConversation ? undefined : await historyStore.mostRecent();
  conversation ??= { id: randomUUID(), title: 'New conversation', updatedAt: Date.now(), messages: [] };

  const safeMode = argv.includes('--safe-mode');
  const checkpoint = new SessionCheckpoint(root);
  const executor = new WorkspaceToolExecutor(root, checkpoint, 60_000);
  const permissions = new PermissionEngine(permissionsFile(root), () => safeMode);
  const shadowGit = new ShadowGit(root, shadowGitDir(root));
  const capabilities = resolveCapabilities(profile);

  render(
    <App
      provider={provider}
      profile={profile}
      conversation={conversation}
      historyStore={historyStore}
      executor={executor}
      checkpoint={checkpoint}
      permissions={permissions}
      shadowGit={shadowGit}
      tools={agentToolDefinitions}
      nativeToolCalls={capabilities.nativeToolCalls}
      workspaceName={basename(root)}
      contextWindow={contextWindow}
    />,
  );
}

function printHelp(): void {
  console.log(`heapcode — model-agnostic AI coding assistant (terminal)

Usage:
  heapcode                          Start an interactive agent session in the current directory
  heapcode --new                    Start a new conversation (default: continue the most recent one in this directory)
  heapcode --profile NAME           Use a specific provider profile for this session
  heapcode --safe-mode              Ask for permission on every action, even ones with a persisted "Always allow" grant
  heapcode -p "<message>" [--json]  Headless: one message in, one reply out, no TTY required (chat only — CLI-M4 adds tools)

  heapcode profile add              Configure a new provider profile
  heapcode profile list             List configured profiles
  heapcode profile use NAME         Switch the active profile
  heapcode profile remove NAME      Delete a profile

In-session commands:
  /rewind [n]                       Undo the last n tool calls (default 1) via their shadow-git checkpoints
  /revert                           Restore every file this session touched to its pre-agent content
  /checkpoints                      List this session's tool-call checkpoints

Config: ~/.heapcode/config.json (profiles)  ·  ~/.heapcode/secrets.json (API keys, chmod 600)
Per-project: <cwd>/.heapcode/{conversations.json, permissions.json, shadow-git/}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
