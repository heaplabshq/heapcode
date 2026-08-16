/**
 * @heapcode/host — the Node-side runtime a *host* needs on top of
 * @heapcode/core.
 *
 * Core is deliberately host-agnostic: it runs the agent loop, talks to
 * providers, and (as the daemon) asks a host to do anything that touches the
 * machine — execute a tool, take a snapshot, resolve a key, decide a
 * permission (packages/core/src/server/protocol.ts:458-511). This package is
 * the answer to those requests: a real filesystem, a real shell, real config
 * and secret storage, real shadow-git.
 *
 * It exists because that runtime was CLI-local, and the web host
 * (docs/WEB_APP_PLAN.md §4) needs exactly the same thing. Duplicating it is
 * how two hosts silently drift apart — the extension already carries its own
 * `WorkspaceToolExecutor`, and keeping *that* in sync has been its own cost.
 *
 * What belongs here: anything a host must do that is pure Node and carries no
 * opinion about how the user is talking to it.
 *
 * What does NOT belong here: rendering, key bindings, slash commands, and
 * anything that reads *this* package's location on disk — see `cliVersion()`
 * in packages/cli/src/version.ts for why that one has to stay with its host.
 */

export * from './paths.js';
export * from './agent/checkpoint.js';
export * from './agent/shadowGit.js';
export * from './agent/permissions.js';
export * from './agent/ignoreFiles.js';
export * from './agent/skills.js';
export * from './agent/delegate.js';
export * from './agent/historyWindow.js';
export * from './provider/resolve.js';
export * from './config/secrets.js';
export * from './config/store.js';
export * from './history/store.js';
export * from './agent/mcpConfig.js';
export * from './agent/workspaceTools.js';
export * from './rag/repoMapIndexer.js';
export * from './agentSession.js';
