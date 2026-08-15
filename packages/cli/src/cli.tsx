import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import fg from 'fast-glob';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  configureAstChunker,
  formatAuditDashboard,
  isPermissionMode,
  parseIdleTimeout,
  type Conversation,
  type PermissionMode,
} from '@heapcode/core';
import {
  ConfigStore,
  JsonConversationStore,
  PermissionEngine,
  SecretsStore,
  auditFile,
  buildAgentSession,
  canonicalize,
  conversationsFile,
  loadIgnoreMatcher,
  permissionsFile,
  profileContextWindow,
} from '@heapcode/host';
import {
  PROFILE_FIELDS,
  isProfileField,
  profileAdd,
  profileList,
  profileRemove,
  profileSet,
  profileUse,
} from './profileCli.js';
import { runHeadless } from './headless.js';
import { runWeb } from './webCli.js';
import { AuditLog } from './audit.js';
import { checkForUpdate } from './updateCheck.js';
import { App } from './ink/App.js';
import { cliVersion } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
configureAstChunker((filename) => join(__dirname, 'wasm', filename));

/**
 * Coalesces the terminal's native `resize` events so the app only reacts
 * once a live window drag has settled, instead of on every intermediate
 * tick. A real drag fires `resize` far faster than the terminal can reflow,
 * and each reaction repaints the entire UI (App.tsx clears the screen and
 * re-emits the whole transcript on this event — see its resize effect), so
 * reacting per-tick would both flicker and race the terminal's own reflow.
 * After the debounce, `stream.columns` reflects the drag's final width and
 * a single full repaint covers it.
 */
function debounceResizeEvents(stream: NodeJS.WriteStream, waitMs = 100): void {
  const originalEmit = stream.emit.bind(stream);
  let pending: NodeJS.Timeout | undefined;
  stream.emit = ((event: string, ...args: unknown[]) => {
    if (event !== 'resize') return originalEmit(event, ...args);
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      originalEmit('resize');
    }, waitMs);
    return true;
  }) as typeof stream.emit;
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
    if (sub === 'set') {
      const [, , name, field, ...rest] = argv;
      if (!name || !field || !isProfileField(field)) {
        console.log('Usage: heapcode profile set NAME FIELD [VALUE]   (omit VALUE to clear)');
        console.log(`Fields: ${PROFILE_FIELDS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      // Joined rather than taking one token: a base URL or a model id with
      // spaces should not be silently truncated to its first word.
      return profileSet(name, field, rest.join(' ') || undefined);
    }
    console.log('Usage: heapcode profile <add|list|use NAME|remove NAME|set NAME FIELD [VALUE]>');
    process.exitCode = 1;
    return;
  }

  if (argv[0] === 'audit') {
    const audit = new AuditLog(auditFile());
    console.log(formatAuditDashboard(await audit.history()));
    return;
  }

  if (argv[0] === 'web') {
    const portFlag = argv.findIndex((a) => a === '--port');
    const hostFlag = argv.findIndex((a) => a === '--host');
    const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : undefined;
    if (port !== undefined && !Number.isInteger(port)) {
      console.error('--port takes a number, e.g. `heapcode web --port 7412`');
      process.exitCode = 1;
      return;
    }
    process.exitCode = await runWeb({
      port,
      // `--host` with no value is the common way to mean "expose it"; 0.0.0.0
      // is what that has to mean, and runWeb warns loudly about it.
      host: hostFlag >= 0 ? (argv[hostFlag + 1] ?? '0.0.0.0') : undefined,
    });
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
  const resumeFlagIndex = argv.findIndex((a) => a === '--resume');
  const resumeId = resumeFlagIndex >= 0 ? argv[resumeFlagIndex + 1] : undefined;
  if (resumeFlagIndex >= 0 && !resumeId) {
    console.error('Usage: heapcode --resume <session-id-or-prefix>  (the id is printed when a session exits, or run /resume in-session to pick from a list)');
    process.exitCode = 1;
    return;
  }
  const newConversation = !continueLatest && !resumeId;
  // Local-only audit log (see audit.ts) — opt out with --no-telemetry or
  // { "telemetryEnabled": false } in ~/.heapcode/config.json. There is no
  // remote sending to opt out of; this flag controls local recording only.
  const telemetryFlag = argv.includes('--no-telemetry') ? false : undefined;

  // Parsed for both paths: headless resolves every decision from it, and an
  // interactive session uses it as the mode Shift+Tab starts cycling from.
  const modeFlagIndex = argv.findIndex((a) => a === '--permission-mode');
  const modeArg = modeFlagIndex >= 0 ? argv[modeFlagIndex + 1] : undefined;
  if (modeArg !== undefined && !isPermissionMode(modeArg)) {
    console.error(`Invalid --permission-mode "${modeArg}". Must be one of: ${PERMISSION_MODES.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  const startingMode = modeArg;

  if (promptIndex >= 0) {
    const prompt = argv[promptIndex + 1];
    if (!prompt) {
      console.error('Usage: heapcode -p "<task>" [--json] [--profile NAME] [--persona NAME] [--permission-mode MODE] [--sub-agents] [--reindex] [--continue | --resume <id>]');
      process.exitCode = 1;
      return;
    }
    const personaFlagIndex = argv.findIndex((a) => a === '--persona');
    const personaId = personaFlagIndex >= 0 ? argv[personaFlagIndex + 1] : undefined;
    const code = await runHeadless({
      prompt,
      json: argv.includes('--json'),
      profileName,
      newConversation,
      resumeId,
      personaId,
      permissionMode: startingMode,
      subAgents: argv.includes('--sub-agents'),
      reindex: argv.includes('--reindex'),
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
  const contextWindow = profileContextWindow(profile);
  // Canonicalized once here and threaded through every root-taking class below —
  // see paths.ts's canonicalize() for why they'd otherwise silently disagree.
  const root = canonicalize(process.cwd());
  const historyStore = new JsonConversationStore(conversationsFile(root));
  const priorConversations = (await historyStore.list()).length;
  let conversation: Conversation | undefined;
  if (resumeId) {
    conversation = await historyStore.findByIdOrPrefix(resumeId);
    if (!conversation) {
      console.error(`No saved conversation matching "${resumeId}" in this project (or the prefix is ambiguous). Run "heapcode" and use /resume to see what's available.`);
      process.exitCode = 1;
      return;
    }
  } else if (!newConversation) {
    conversation = await historyStore.mostRecent();
  }
  conversation ??= { id: randomUUID(), title: 'New conversation', updatedAt: Date.now(), messages: [] };

  const safeMode = argv.includes('--safe-mode');
  /**
   * The live permission mode for this session. App owns the UI state and
   * reports changes back here, because the engine is built before App renders
   * and reads the mode per request — Shift+Tab has to affect a run already in
   * flight, not just the next one.
   */
  let permissionMode: PermissionMode = startingMode ?? DEFAULT_PERMISSION_MODE;
  // Opt out with --no-update-check or { "updateCheckEnabled": false } in
  // ~/.heapcode/config.json — see updateCheck.ts; never phones anything but
  // npm's own registry, never blocks, renders as one dim line under the banner.
  const updateCheckEnabled = !argv.includes('--no-update-check') && (await config.load()).updateCheckEnabled !== false;
  const telemetryEnabled = telemetryFlag ?? (await config.load()).telemetryEnabled ?? true;
  // Unset by default, which means an ask_user question waits indefinitely.
  const askUserIdleMs = parseIdleTimeout((await config.load()).askUserQuestionTimeout);
  const audit = new AuditLog(auditFile(), () => telemetryEnabled);
  /**
   * Set by App once it renders, so the engine's auto-allow lines land in the
   * transcript. They used to go to a no-op: an action approved by a saved
   * grant simply happened, with nothing on screen explaining why it had not
   * asked — which is how a stale grant reads as a broken permission system.
   */
  let logPermission: (message: string) => void = () => {};
  const permissions = new PermissionEngine(
    permissionsFile(root),
    () => safeMode,
    (message) => logPermission(message),
    (name, meta) => void audit.track(name, meta),
    () => permissionMode,
  );

  // Everything else (executor, checkpoint, shadow-git, RAG/repo-map
  // indexers, MCP) is built by the same shared path headless.ts uses — see
  // agentSession.ts's own comment on why (guardrail #8: headless is a
  // first-class peer of the interactive UI, not a bolted-on shortcut).
  const { checkpoint, executor, shadowGit, repoMapIndexer, mcpManager, tools } = buildAgentSession(
    root,
    config,
    secrets,
    cliVersion(),
  );

  // Tracks the active conversation id across /new and /resume so it can be
  // printed on exit — App owns the actual conversation object (including
  // swapping it out entirely on /new/resume), so this is the one thing it
  // reports back up rather than cli.tsx reading its internal state.
  let sessionId = conversation.id;

  debounceResizeEvents(process.stdout);

  // exitOnCtrlC: false — Ink's built-in handler would unmount the UI on the
  // first Ctrl+C even mid-agent-run, leaving the terminal in a broken state.
  // The App owns the whole protocol instead: Esc interrupts, Ctrl+C clears
  // typed input, Ctrl+C twice exits.
  const instance = render(
    <App
      profile={profile}
      conversation={conversation}
      historyStore={historyStore}
      executor={executor}
      checkpoint={checkpoint}
      permissions={permissions}
      shadowGit={shadowGit}
      tools={tools}
      workspaceName={basename(root)}
      contextWindow={contextWindow}
      configStore={config}
      secretsStore={secrets}
      switchProvider={(p) => Promise.resolve({ contextWindow: profileContextWindow(p) })}
      askUserIdleMs={askUserIdleMs}
      version={cliVersion()}
      checkUpdate={updateCheckEnabled ? () => checkForUpdate('@heaplabs/heapcode-cli', cliVersion() ?? '0.0.0') : undefined}
      cwd={root}
      safeMode={safeMode}
      permissionMode={permissionMode}
      onPermissionModeChange={(mode) => {
        permissionMode = mode;
      }}
      onPermissionLogReady={(log) => {
        logPermission = log;
      }}
      canResume={priorConversations > 0}
      repoMapIndexer={repoMapIndexer}
      mcpManager={mcpManager}
      onTrack={(name, meta) => void audit.track(name, meta)}
      onSessionChange={(id) => {
        sessionId = id;
      }}
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
  // Printed after Ink has fully unmounted (not while it's still managing
  // the screen) so it survives in real scrollback instead of being erased
  // by the next redraw.
  console.log(`Session: ${sessionId}\nResume with: heapcode --resume ${sessionId.slice(0, 8)}  (or --continue for the most recent, /resume to pick from a list)`);
  // In-flight provider sockets or timers can keep the event loop alive after
  // the UI is gone — end the process explicitly once Ink has cleaned up.
  process.exit(process.exitCode ?? 0);
}

function printHelp(): void {
  console.log(`heapcode — model-agnostic AI coding assistant (terminal)

Usage:
  heapcode                          Start an interactive agent session (fresh conversation) in the current directory
  heapcode --continue | -c          Continue this directory's most recent conversation (in-session: /resume picks any)
  heapcode --resume <id>            Continue a specific past conversation by id or unambiguous prefix — printed when a session exits, or shown in /settings and /resume's picker
  heapcode --profile NAME           Use a specific provider profile for this session
  heapcode --safe-mode              Ask for permission on every action, even ones with a persisted "Always allow" grant
  heapcode --permission-mode MODE   Start in a permission mode (see below); Shift+Tab cycles it in-session
  heapcode --no-update-check        Skip the startup check against npm for a newer published version (see "Config" below)
  heapcode -p "<task>" [flags]      Headless: runs the full agent loop (tools, RAG, MCP) with no TTY required — see below

  heapcode profile <add|list|use|remove>   Scriptable profile management (all of it is also available in-session via /profile)
  heapcode audit                            Local usage/audit dashboard — event names + coarse metadata only, never code/prompts/paths; nothing leaves this machine
  heapcode web [--port N] [--host H]        Serve the browser UI for this workspace on 127.0.0.1 (--host exposes it to your network — see the warning it prints)

Headless (-p) flags:
  --json                            Stream newline-delimited JSON events (tool_call, tool_result, text_delta, plan, result) instead of plain text
  --persona NAME                    agent (default), architect (read-only), debug (no edits), reviewer
  --permission-mode MODE            plan | default | auto-edit | full-auto — see below; default: "default"
  --sub-agents                      Let delegate_task actually run (always visible to the model; without this flag calls return a "disabled" notice)
  --reindex                         Rebuild the semantic search + repo map indexes before running the task (headless never auto-indexes)
  --continue | -c                   Continue this directory's most recent conversation instead of starting fresh
  --resume <id>                     Continue a specific conversation by id or unambiguous prefix instead of the most recent
  --no-telemetry                    Skip the local audit-log entry for this run (see "heapcode audit" — no remote sending exists to opt out of)

Permission modes — how much runs without asking. Shift+Tab cycles them in-session (or /mode <name>);
the current one shows bottom-left. Not persisted: every session starts at "default" unless
--permission-mode says otherwise, so an auto mode is never silently inherited by a later run.
  plan        Read-only — only read tools are offered, so nothing can be changed
  default     Ask before every write, command, and destructive action
  auto-edit   File edits apply without asking; commands and destructive actions still ask
  full-auto   Edits and commands run without asking; destructive actions still ask

Headless (-p) has no one to prompt, so it resolves each mode on its own: plan/default deny
everything but reads, auto-edit allows writes, and full-auto — the mode meant to finish a task
unattended in CI — allows everything, destructive actions included.

In-session commands (type / for the autocomplete menu):
  /help                             Show available commands
  /model [id]                       Switch the model (fetches the provider's model list)
  /profile [add|list|remove|name]   Switch, add, list, or remove provider profiles
  /persona [name]                   Switch persona: agent, architect (read-only), debug (no edits), reviewer
  /mode [name]                      Permission mode: plan, default, auto-edit, full-auto (Shift+Tab cycles)
  /nativetools [on|off]             Native tool calling vs the text protocol — turn off for models that reject tools
  /permissions [reset]              Show or clear saved "Always allow" grants for this project
  /settings                         Show current configuration
  /init                             Set up .heapcode/HEAPCODE.md & memory.md for this project (runs as an agent task)
  /memory                           Show project instructions & memory (.heapcode/HEAPCODE.md, memory.md, AGENTS.md)
  /skills                           List available Skills (.claude/skills/)
  /explain /fix /refactor /review /security-review /test /docs /optimize <input>   Prompt templates run as agent tasks
  /search <query>                   Search the workspace (semantic if indexed, plain text otherwise)
  /index                            Rebuild the semantic search + repo map indexes
  /mcp                              List configured MCP servers and their connection status
  /subagents [on|off]               Toggle sub-agent delegation — delegate_task calls are refused while off (the default)
  /clear, /new                      Clear the screen and start a new conversation
  /resume                           Pick an earlier conversation to continue
  /rewind [n]                       Undo the last n tool-call checkpoints (default 1) — persists across /new, /resume, even a restart
  /revert                           Restore every file this session touched to its pre-agent content
  /checkpoints                      List recent checkpoints for this project (shadow-git history, not just this session)
  /exit                             Quit (also: Ctrl+C twice)

Keys: Esc interrupts the running agent · Ctrl+C clears typed input · Ctrl+C twice exits
      Up/Down recall input history (or move within a multi-line message, line by line) · Tab completes a slash command
      \\ then Enter inserts a newline instead of submitting · pasting multi-line text keeps it as one message
      @ mentions a file/folder · @workspace pulls in whole-repo context (semantic search, or a structural outline without an embeddings model)

Config: ~/.heapcode/config.json (profiles)  ·  ~/.heapcode/secrets.json (API keys, chmod 600)  ·  ~/.heapcode/audit.json (local usage log)
Per-project session state (history, checkpoints, search index — never in your repo, never at risk of being committed):
  ~/.heapcode/projects/<name>-<hash>/{conversations.json, permissions.json, shadow-git/, rag-index.json, repo-map.json}
Per-project CONFIG (meant to live alongside your code, safe to commit and share with a team):
  <cwd>/.heapcode/{HEAPCODE.md, memory.md, instructions/*.md, mcp.json}
Semantic search needs an embeddings model on the active profile (embeddingsModel, e.g. nomic-embed-text on Ollama) — /settings shows whether one is configured.
MCP servers: ~/.heapcode/config.json's "mcpServers", or <cwd>/.heapcode/mcp.json for project-scoped servers.
Update check: a one-line startup check against npm's registry for a newer published version — never phones anything else, never blocks. Opt out with --no-update-check or { "updateCheckEnabled": false } in ~/.heapcode/config.json.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
