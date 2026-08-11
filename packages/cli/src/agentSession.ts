import { McpManager, WEB_SEARCH_SECRET_NAME, type ToolDefinition } from '@heapcode/core';
import type { ConfigStore } from './config/store.js';
import type { SecretsStore } from './config/secrets.js';
import { WorkspaceToolExecutor, agentToolDefinitions } from './agent/workspaceTools.js';
import { SessionCheckpoint } from './agent/checkpoint.js';
import { ShadowGit } from './agent/shadowGit.js';
import { loadMcpServers } from './agent/mcpConfig.js';
import { createRepoMapIndexer, type RepoMapIndexer } from './rag/repoMapIndexer.js';
import { projectStateDir, shadowGitDir } from './paths.js';
import { cliVersion } from './version.js';

export interface AgentSession {
  checkpoint: SessionCheckpoint;
  executor: WorkspaceToolExecutor;
  shadowGit: ShadowGit;
  repoMapIndexer: RepoMapIndexer;
  mcpManager: McpManager;
  tools: ToolDefinition[];
}

/**
 * Everything an agent run needs beyond the provider/profile — one shared
 * construction path for both the interactive Ink UI (cli.tsx) and headless
 * mode (headless.ts), so the two can't silently drift apart (guardrail #8:
 * headless is a first-class peer of the interactive UI, not a bolted-on
 * shortcut). `root` must already be canonicalized (see paths.ts).
 */
export function buildAgentSession(root: string, config: ConfigStore, secrets?: SecretsStore): AgentSession {
  const checkpoint = new SessionCheckpoint(root);
  const shadowGit = new ShadowGit(root, shadowGitDir(root));

  // Caches, not project config — live in the global per-project state dir
  // alongside conversations/checkpoints, not inside the project itself.
  const stateDir = projectStateDir(root);
  const repoMapIndexer = createRepoMapIndexer(root, stateDir);
  // No semanticSearch injection: the server dispatches semantic_search from
  // its own index and only hands the call back here when it has nothing, at
  // which point this executor's word-based text search is exactly the
  // fallback it always was (docs/phase3-rag-design.md §5.2).
  const executor = new WorkspaceToolExecutor(
    root,
    checkpoint,
    60_000,
    undefined,
    (pathPrefix) => (repoMapIndexer.ready ? repoMapIndexer.format(pathPrefix) : ''),
    undefined,
    // Resolved per call rather than captured: turning search on with
    // /websearch has to affect the run in progress, not just the next one.
    async () => ({
      config: (await config.load()).webSearch ?? {},
      apiKey: await secrets?.getApiKey(WEB_SEARCH_SECRET_NAME),
    }),
  );

  // MCP servers — global (~/.heapcode/config.json's mcpServers) merged with
  // project-scoped (<cwd>/.heapcode/mcp.json), project wins name collisions.
  // Reconnected (idempotent) at the start of every task by the caller.
  const mcpManager = new McpManager(() => loadMcpServers(root, config), undefined, cliVersion());

  return { checkpoint, executor, shadowGit, repoMapIndexer, mcpManager, tools: agentToolDefinitions };
}
