import { statSync } from 'node:fs';
import { reviewCurrentPr, type PrReviewHost, type PrReviewToolExecutor } from '../review/prReview.js';
import type { ToolCall, ToolResult } from '../agent/tools.js';
import type { Session } from './session.js';
import type { ReviewEvent, ReviewRunParams, ReviewRunResult } from './protocol.js';

/**
 * The host-facing half of a review. Deliberately smaller than `RunHost`: the
 * review's toolset is read-only by construction (`prReview.ts:457` filters to
 * `permission === 'read'` minus `ask_user`), so the permission and snapshot
 * callbacks the agent path needs are unreachable here.
 */
export interface ReviewHost {
  emit(event: ReviewEvent): void;
  executeTool(call: ToolCall): Promise<ToolResult>;
  /** The gate before anything posts publicly. No timeout — a human is reading. */
  confirm(confirmation: Parameters<PrReviewHost['confirm']>[0]): Promise<boolean>;
  /** Resolve a profile the session doesn't already hold a key for (`key/request`). */
  requestKey(profileName: string): Promise<void>;
}

/**
 * Runs a PR review server-side.
 *
 * Nothing about the review itself moved: `reviewCurrentPr` was already
 * host-agnostic in core, with both hosts as thin adapters over it, so this is
 * only the wiring — resolve the Provider from **this session's** keys, turn the
 * five `PrReviewHost` callbacks into protocol messages, and route the
 * read-only tool loop back over `tool/execute`.
 *
 * `gh` runs here, against `session.root`. That is a real widening of what the
 * server does — it spawns a subprocess and, on confirmation, posts publicly to
 * GitHub — and it rests on the same colocation rule everything else does
 * (docs/phase3-protocol-design.md §6): the server runs as the same user on the
 * same machine as the workspace, so it has the user's `gh` auth and their repo.
 * The confirmation still happens in the host, in front of the user, with the
 * full preview; only the boolean crosses the socket, and every failure path
 * (cancellation, a dropped connection) resolves to "not posted".
 */
export async function runReviewForSession(
  session: Session,
  params: ReviewRunParams,
  host: ReviewHost,
  signal: AbortSignal,
): Promise<ReviewRunResult> {
  const profileName = params.profileName ?? session.activeProfile;
  const resolved = await session.resolveProfile(profileName, host.requestKey);
  if (!resolved) throw new Error(`Unknown profile "${profileName}" for this session.`);

  if (!localWorkspace(session)) {
    host.emit({
      kind: 'warn',
      message:
        'PR review needs a local checkout — this workspace is not a directory the Heap Code server can read. ' +
        'Open the folder locally and try again.',
    });
    return { status: 'skipped' };
  }

  const executor: PrReviewToolExecutor = {
    // The host's own describe() is synchronous and cannot cross the socket, so
    // this is the same generic rendering the agent path settled on
    // (agentRun.ts:54). It only feeds host.log, which one host writes to an
    // output channel and the other drops.
    describe: (call) => `${call.name}(${Object.keys(call.args).join(', ')})`,
    execute: (call) => host.executeTool(call),
  };

  const reviewHost: PrReviewHost = {
    warn: (message) => host.emit({ kind: 'warn', message }),
    error: (message) => host.emit({ kind: 'error', message }),
    log: (message) => host.emit({ kind: 'log', message }),
    progress: (message) => host.emit({ kind: 'progress', message }),
    confirm: (confirmation) => host.confirm(confirmation),
  };

  return reviewCurrentPr({
    cwd: session.root,
    provider: resolved.provider,
    model: params.model,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    contextWindow: params.contextWindow,
    tools: params.tools,
    executor,
    host: reviewHost,
    client: params.client,
    signal,
    deep: params.deep,
  });
}

/** Same guard RAG uses: `gh` needs a real checkout, not a virtual workspace root. */
function localWorkspace(session: Session): boolean {
  if (session.localRoot === false) return false;
  try {
    return statSync(session.root).isDirectory();
  } catch {
    return false;
  }
}
