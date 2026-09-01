import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEnvironment } from './promptSections.js';

const execFileAsync = promisify(execFile);

export interface GatherEnvironmentOptions {
  /** The model actually answering, when the caller knows it. */
  modelId?: string;
  /**
   * Git access, injectable so tests need no repository on disk. Defaults to
   * `git` in `root`, killed after `timeoutMs` — a hung git must not hang a run.
   */
  git?: (args: string[]) => Promise<{ stdout: string }>;
  /** Per-command ceiling for the default runner. Default 2s. */
  timeoutMs?: number;
}

/**
 * Collects the environment block for a run, best-effort by contract.
 *
 * Every field is independently optional and every failure simply omits: a
 * directory that is not a git repo, a git that is broken or slow, a web host
 * with a remote root — none of these should cost a run anything. The function
 * never throws; the worst outcome is an environment with no git fields.
 */
export async function gatherAgentEnvironment(
  root: string,
  opts: GatherEnvironmentOptions = {},
): Promise<AgentEnvironment> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const git =
    opts.git ??
    (async (args: string[]) => {
      const { stdout } = await execFileAsync('git', args, { cwd: root, timeout: timeoutMs });
      return { stdout };
    });

  const environment: AgentEnvironment = {
    cwd: root,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
  };
  if (opts.modelId) environment.modelId = opts.modelId;

  // Each git fact stands alone: a repo with no commits still has a branch,
  // and a directory that is not a repo at all must not take the others down.
  const [branch, status, log] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim()).catch(() => undefined),
    git(['status', '--porcelain']).then((r) => r.stdout).catch(() => undefined),
    git(['log', '--oneline', '-5']).then((r) => r.stdout.trim()).catch(() => undefined),
  ]);
  if (branch) environment.gitBranch = branch;
  if (typeof status === 'string') environment.gitStatus = summarizeStatus(status);
  if (log) environment.recentCommits = log;

  return environment;
}

/**
 * `git status --porcelain` output as one line the prompt can spend a glance on.
 *
 * 'clean' carries real information — an agent told only the branch cannot tell
 * a pristine tree from one with the user's uncommitted work in it, and editing
 * over the latter unasked is exactly the mistake the summary prevents.
 */
export function summarizeStatus(porcelain: string): string {
  const lines = porcelain.split('\n').filter(Boolean);
  if (lines.length === 0) return 'clean';
  let modified = 0;
  let untracked = 0;
  let other = 0;
  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code.includes('??')) untracked++;
    else if (code.includes('M') || code.includes('A') || code.includes('D') || code.includes('R')) modified++;
    else other++;
  }
  const parts = [
    modified ? `${modified} modified` : '',
    untracked ? `${untracked} untracked` : '',
    other ? `${other} other` : '',
  ].filter(Boolean);
  return `${lines.length} file${lines.length === 1 ? '' : 's'} changed (${parts.join(', ')})`;
}