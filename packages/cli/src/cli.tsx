import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import fg from 'fast-glob';
import { configureAstChunker, formatAuditDashboard, resolveCapabilities, type Conversation } from '@heapcode/core';
import { ConfigStore } from './config/store.js';
import { SecretsStore } from './config/secrets.js';
import { JsonConversationStore } from './history/store.js';
import { canonicalize, auditFile, conversationsFile, permissionsFile } from './paths.js';
import { profileAdd, profileList, profileRemove, profileUse } from './profileCli.js';
import { resolveProvider } from './provider/resolve.js';
import { runHeadless } from './headless.js';
import { loadIgnoreMatcher } from './agent/ignoreFiles.js';
import { PermissionEngine } from './agent/permissions.js';
import { buildAgentSession } from './agentSession.js';
import { AuditLog } from './audit.js';
import { App } from './ink/App.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
configureAstChunker((filename) => join(__dirname, 'wasm', filename));

/** Best-effort version for the banner — dist/cli.js sits next to ../package.json. */
function cliVersion(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

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

  if (argv[0] === 'audit') {
    const audit = new AuditLog(auditFile());
    console.log(formatAuditDashboard(await audit.history()));
    return;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  const promptIndex = argv.findIndex((a) => a === '-p' || a === '--prompt');
  const profileFlagIndex = argv.findIndex((a) => a === '--profile');
  const profileName = profileFlagIndex >= 0 ? argv[profileFlagIndex + 1] : undefined;
  // Fresh conversation is the launch default (matching Claude Code) —
  // continuing is an explicit choice: --continue here, /resume in-session.
  // --new is accepted silently for back-compat with the old default.
  const continueLatest = argv.includes('--continue') || argv.includes('-c');
  const newConversation = !continueLatest;
  // Local-only audit log (see audit.ts) — opt out with --no-telemetry or
  // { "telemetryEnabled": false } in ~/.heapcode/config.json. There is no
  // remote sending to opt out of; this flag controls local recording only.
  const telemetryFlag = argv.includes('--no-telemetry') ? false : undefined;

  if (promptIndex >= 0) {
    const prompt = argv[promptIndex + 1];
    if (!prompt) {
      console.error('Usage: heapcode -p "<task>" [--json] [--profile NAME] [--persona NAME] [--permission-mode MODE] [--sub-agents] [--continue]');
      process.exitCode = 1;
      return;
    }
    const personaFlagIndex = argv.findIndex((a) => a === '--persona');
    const personaId = personaFlagIndex >= 0 ? argv[personaFlagIndex + 1] : undefined;
    const modeFlagIndex = argv.findIndex((a) => a === '--permission-mode');
    const modeArg = modeFlagIndex >= 0 ? argv[modeFlagIndex + 1] : undefined;
    const PERMISSION_MODES = ['plan', 'default', 'auto-edit', 'full-auto'] as const;
    if (modeArg !== undefined && !(PERMISSION_MODES as readonly string[]).includes(modeArg)) {
      console.error(`Invalid --permission-mode "${modeArg}". Must be one of: ${PERMISSION_MODES.join(', ')}.`);
      process.exitCode = 1;
      return;
    }
    const code = await runHeadless({
      prompt,
      json: argv.includes('--json'),
      profileName,
      newConversation,
      personaId,
      permissionMode: modeArg as (typeof PERMISSION_MODES)[number] | undefined,
      subAgents: argv.includes('--sub-agents'),
      telemetryEnabled: telemetryFlag,
    });
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

  const secrets = new SecretsStore();
  const { provider, contextWindow } = await resolveProvider(profile, secrets);
  // Canonicalized once here and threaded through every root-taking class below —
  // see paths.ts's canonicalize() for why they'd otherwise silently disagree.
  const root = canonicalize(process.cwd());
  const historyStore = new JsonConversationStore(conversationsFile(root));
  const priorConversations = (await historyStore.list()).length;
  let conversation: Conversation | undefined = newConversation ? undefined : await historyStore.mostRecent();
  conversation ??= { id: randomUUID(), title: 'New conversation', updatedAt: Date.now(), messages: [] };

  const safeMode = argv.includes('--safe-mode');
  const telemetryEnabled = telemetryFlag ?? (await config.load()).telemetryEnabled ?? true;
  const audit = new AuditLog(auditFile(), () => telemetryEnabled);
  const permissions = new PermissionEngine(
    permissionsFile(root),
    () => safeMode,
    () => {},
    (name, meta) => void audit.track(name, meta),
  );
  const capabilities = resolveCapabilities(profile);

  // Everything else (executor, checkpoint, shadow-git, RAG/repo-map
  // indexers, MCP) is built by the same shared path headless.ts uses — see
  // agentSession.ts's own comment on why (guardrail #8: headless is a
  // first-class peer of the interactive UI, not a bolted-on shortcut).
  const { checkpoint, executor, shadowGit, ragIndexer, repoMapIndexer, mcpManager, tools } = buildAgentSession(
    root,
    profile,
    config,
    secrets,
  );

  // exitOnCtrlC: false — Ink's built-in handler would unmount the UI on the
  // first Ctrl+C even mid-agent-run, leaving the terminal in a broken state.
  // The App owns the whole protocol instead: Esc interrupts, Ctrl+C clears
  // typed input, Ctrl+C twice exits.
  const instance = render(
    <App
      provider={provider}
      profile={profile}
      conversation={conversation}
      historyStore={historyStore}
      executor={executor}
      checkpoint={checkpoint}
      permissions={permissions}
      shadowGit={shadowGit}
      tools={tools}
      nativeToolCalls={capabilities.nativeToolCalls}
      workspaceName={basename(root)}
      contextWindow={contextWindow}
      configStore={config}
      secretsStore={secrets}
      switchProvider={async (p) => {
        const resolved = await resolveProvider(p, secrets);
        return { provider: resolved.provider, contextWindow: resolved.contextWindow };
      }}
      version={cliVersion()}
      cwd={root}
      safeMode={safeMode}
      canResume={priorConversations > 0}
      ragIndexer={ragIndexer}
      repoMapIndexer={repoMapIndexer}
      mcpManager={mcpManager}
      onTrack={(name, meta) => void audit.track(name, meta)}
      listWorkspaceFiles={async () => {
        const entries = await fg(['**/*'], {
          cwd: root,
          dot: false,
          onlyFiles: false,
          markDirectories: true,
          ignore: ['**/node_modules/**', '**/.git/**', '**/.heapcode/**'],
          suppressErrors: true,
          deep: 8,
        });
        const matcher = await loadIgnoreMatcher(root);
        const kept = matcher ? entries.filter((f) => !matcher.ignores(f.endsWith('/') ? f.slice(0, -1) : f)) : entries;
        return kept.sort().slice(0, 2_000);
      }}
    />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  mcpManager.dispose();
  // In-flight provider sockets or timers can keep the event loop alive after
  // the UI is gone — end the process explicitly once Ink has cleaned up.
  process.exit(process.exitCode ?? 0);
}

function printHelp(): void {
  console.log(`heapcode — model-agnostic AI coding assistant (terminal)

Usage:
  heapcode                          Start an interactive agent session (fresh conversation) in the current directory
  heapcode --continue | -c          Continue this directory's most recent conversation (in-session: /resume picks any)
  heapcode --profile NAME           Use a specific provider profile for this session
  heapcode --safe-mode              Ask for permission on every action, even ones with a persisted "Always allow" grant
  heapcode -p "<task>" [flags]      Headless: runs the full agent loop (tools, RAG, MCP) with no TTY required — see below

  heapcode profile <add|list|use|remove>   Scriptable profile management (all of it is also available in-session via /profile)
  heapcode audit                            Local usage/audit dashboard — event names + coarse metadata only, never code/prompts/paths; nothing leaves this machine

Headless (-p) flags:
  --json                            Stream newline-delimited JSON events (tool_call, tool_result, text_delta, plan, result) instead of plain text
  --persona NAME                    agent (default), architect (read-only), debug (no edits), reviewer
  --permission-mode MODE            plan | default | auto-edit | full-auto — see below; default: "default"
  --sub-agents                      Offer delegate_task (off by default, same as interactive's /subagents)
  --continue | -c                   Continue this directory's most recent conversation instead of starting fresh
  --no-telemetry                    Skip the local audit-log entry for this run (see "heapcode audit" — no remote sending exists to opt out of)

Permission modes (headless has no one to prompt, so every mode resolves permissions on its own):
  plan        Read-only tools only — nothing offered that could mutate anything
  default     Every tool is visible, but writes/commands are denied — the agent adapts or reports what it would need
  auto-edit   File edits auto-approved; shell commands still denied
  full-auto   Everything auto-approved — for CI automation that should actually finish the task unattended

In-session commands (type / for the autocomplete menu):
  /help                             Show available commands
  /model [id]                       Switch the model (fetches the provider's model list)
  /profile [add|list|remove|name]   Switch, add, list, or remove provider profiles
  /persona [name]                   Switch persona: agent, architect (read-only), debug (no edits), reviewer
  /settings                         Show current configuration
  /memory                           Show project instructions & memory (.heapcode/HEAPCODE.md, memory.md, AGENTS.md)
  /skills                           List available Skills (.claude/skills/)
  /explain /fix /refactor /review /security-review /test /docs /optimize <input>   Prompt templates run as agent tasks
  /search <query>                   Search the workspace (semantic if indexed, plain text otherwise)
  /index                            Rebuild the semantic search + repo map indexes
  /mcp                              List configured MCP servers and their connection status
  /subagents [on|off]               Toggle delegate_task — lets the agent hand off self-contained sub-tasks (off by default)
  /clear, /new                      Clear the screen and start a new conversation
  /resume                           Pick an earlier conversation to continue
  /rewind [n]                       Undo the last n tool-call checkpoints (default 1) — persists across /new, /resume, even a restart
  /revert                           Restore every file this session touched to its pre-agent content
  /checkpoints                      List recent checkpoints for this project (shadow-git history, not just this session)
  /exit                             Quit (also: Ctrl+C twice)

Keys: Esc interrupts the running agent · Ctrl+C clears typed input · Ctrl+C twice exits
      Up/Down recall input history · Tab completes a slash command
      @ mentions a file/folder · @workspace pulls in whole-repo context (semantic search, or a structural outline without an embeddings model)

Config: ~/.heapcode/config.json (profiles)  ·  ~/.heapcode/secrets.json (API keys, chmod 600)
Per-project: <cwd>/.heapcode/{conversations.json, permissions.json, shadow-git/, rag-index.json, repo-map.json, mcp.json}
Semantic search needs an embeddings model on the active profile (embeddingsModel, e.g. nomic-embed-text on Ollama) — /settings shows whether one is configured.
MCP servers: ~/.heapcode/config.json's "mcpServers", or <cwd>/.heapcode/mcp.json for project-scoped servers.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
