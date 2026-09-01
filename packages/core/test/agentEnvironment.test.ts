import { describe, expect, it } from 'vitest';
import { gatherAgentEnvironment, summarizeStatus } from '../src/agent/environment.js';
import { ENVIRONMENT_SECTION } from '../src/agent/promptSections.js';
import { LEAN_TIER_CONTEXT_WINDOW, buildNativeAgentSystemPrompt, resolvePromptTier } from '../src/agent/prompts.js';

/**
 * The environment block: what the agent is told about where it runs, and the
 * best-effort contract of the code that gathers it. Intent-level throughout —
 * the block's exact wording is a prompt decision that will keep evolving, but
 * "a host with no environment gets the prompt it always had" is a contract.
 */
describe('the environment section', () => {
  it('renders nothing when the host supplies no environment', () => {
    expect(ENVIRONMENT_SECTION.render({})).toBe('');
  });

  it('renders only the fields it was given', () => {
    const out = ENVIRONMENT_SECTION.render({ environment: { platform: 'linux' } });
    expect(out).toContain('Platform: linux');
    expect(out).not.toContain('Working directory');
    expect(out).not.toContain('Git branch');
  });

  it('tells the agent the git state is a snapshot, not live', () => {
    // A model citing the start-of-run status as current, after its own edits,
    // is worse than one that was told nothing.
    const out = ENVIRONMENT_SECTION.render({ environment: { gitBranch: 'main' } });
    expect(out).toMatch(/snapshot from the start of the run/);
  });

  it('is in the composed coding prompt when an environment is present, and absent otherwise', () => {
    expect(buildNativeAgentSystemPrompt('w')).not.toContain('## Environment');
    const withEnv = buildNativeAgentSystemPrompt('w', { environment: { cwd: '/repo', platform: 'darwin' } });
    expect(withEnv).toContain('## Environment');
    expect(withEnv.indexOf('## Environment')).toBeGreaterThan(0);
    expect(withEnv.indexOf('## Environment')).toBeLessThan(withEnv.indexOf('## Answer, or work'));
  });
});

describe('prompt tiers', () => {
  it('keeps the incident rules in the lean tier and drops the craft sections', () => {
    // The lean tier is for models where every token of prompt is a real cost.
    // What must survive is every rule learned from a real failure; what can go
    // is everything that is craft rather than correction.
    const lean = buildNativeAgentSystemPrompt('w', { tier: 'lean' });
    for (const pinned of [
      'Never issue a search, command, or file read you have already issued',
      'is a fabrication, not progress',
      'A reply with no tool call means the task is FINISHED',
      '[untrusted data]',
      'two to five files',
    ]) {
      expect(lean).toContain(pinned);
    }
    for (const dropped of ['requested scope is the deliverable', 'no apology', 'wrap up early']) {
      expect(lean).not.toContain(dropped);
    }
  });

  it('gives the full prompt when the profile says nothing', () => {
    // The default is full, not derived. Quietly shortening the prompt makes
    // the agent behave differently with nothing saying so, and the difference
    // surfaces as a model ignoring an instruction it was never given — which
    // is indistinguishable, from outside, from the model being bad at its job.
    expect(resolvePromptTier({ contextWindow: 8_192, nativeToolCalls: false })).toBe('full');
    expect(resolvePromptTier({ nativeToolCalls: false })).toBe('full');
  });

  it("derives from the model only when asked to, with 'auto'", () => {
    expect(resolvePromptTier({ promptTier: 'auto', contextWindow: LEAN_TIER_CONTEXT_WINDOW - 1, nativeToolCalls: true })).toBe('lean');
    expect(resolvePromptTier({ promptTier: 'auto', contextWindow: LEAN_TIER_CONTEXT_WINDOW, nativeToolCalls: true })).toBe('full');
    // The text protocol usually means a model that could not manage the
    // native one — small, local, or both.
    expect(resolvePromptTier({ promptTier: 'auto', nativeToolCalls: false })).toBe('lean');
  });

  it('lets an explicit tier win over everything', () => {
    // A user pointing a big prompt at a small model, or a small one at a big
    // model, knows something the heuristic doesn't.
    expect(resolvePromptTier({ promptTier: 'full', contextWindow: 8192, nativeToolCalls: false })).toBe('full');
    expect(resolvePromptTier({ promptTier: 'lean', contextWindow: 200_000, nativeToolCalls: true })).toBe('lean');
  });

  it('keeps the full prompt under a budget the biggest window shrugs at', () => {
    // Claude Code's leaked prompt is ~135KB. This one is deliberately two
    // orders smaller; if it grows past this guard, it is growing for reasons
    // that should be argued for, not slipped in.
    expect(buildNativeAgentSystemPrompt('w', { environment: { cwd: '/x', platform: 'linux' } }).length).toBeLessThan(
      12_000,
    );
    // Raised from 5000 (2026-08, docs/PROMPT_GAP_PLAN.md items 1 and 7) for
    // the risky-actions section — a small-context model can take an
    // irreversible step as easily as a frontier one — and the system-reminder
    // declaration the loop's tagged nudges depend on: a lean model is nudged
    // most often and least equipped to read an unmarked nudge as anything
    // but the user's words.
    //
    // This bound is a drift alarm, not a budget to write up against. When a
    // lean rule earns its place, raise the number; never shorten the rule to
    // fit it. Wording trimmed to buy headroom is wording chosen by a
    // threshold rather than by what the model needs to be told, and the
    // sentence that gets cut is always the explanatory half — the part
    // carrying the reason a rule is followed rather than pattern-matched.
    // Hence the deliberate ~1k of slack below.
    expect(buildNativeAgentSystemPrompt('w', { tier: 'lean' }).length).toBeLessThan(7_500);
  });
});

describe('summarizeStatus', () => {
  it('reads empty porcelain as clean', () => {
    expect(summarizeStatus('')).toBe('clean');
  });

  it('counts modified and untracked files', () => {
    expect(summarizeStatus(' M a.ts\n?? b.ts\nA  c.ts')).toBe('3 files changed (2 modified, 1 untracked)');
  });
});

describe('gatherAgentEnvironment', () => {
  /** A git double that answers each requested command once. */
  const fakeGit = (answers: Record<string, string>) => async (args: string[]) => {
    const key = args.join(' ');
    const stdout = answers[key];
    if (stdout === undefined) throw new Error(`unexpected git ${key}`);
    return { stdout };
  };

  it('fills the git fields from the repository', async () => {
    const env = await gatherAgentEnvironment('/repo', {
      git: fakeGit({
        'rev-parse --abbrev-ref HEAD': 'feat/x\n',
        'status --porcelain': ' M a.ts\n?? b.ts\n',
        'log --oneline -5': 'abc123 fix\n',
      }),
    });
    expect(env.gitBranch).toBe('feat/x');
    expect(env.gitStatus).toBe('2 files changed (1 modified, 1 untracked)');
    expect(env.recentCommits).toBe('abc123 fix');
    expect(env.cwd).toBe('/repo');
    expect(env.platform).toBeTruthy();
    expect(env.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('survives a directory that is not a git repository', async () => {
    const env = await gatherAgentEnvironment('/plain', {
      git: async () => {
        throw new Error('not a git repository');
      },
    });
    expect(env.cwd).toBe('/plain');
    expect(env.gitBranch).toBeUndefined();
    expect(env.gitStatus).toBeUndefined();
    expect(env.recentCommits).toBeUndefined();
  });

  it('keeps the branch when the log is unavailable (a repo with no commits)', async () => {
    const env = await gatherAgentEnvironment('/fresh', {
      git: fakeGit({
        'rev-parse --abbrev-ref HEAD': 'main\n',
        'status --porcelain': '',
        'log --oneline -5': '',
      }),
    });
    expect(env.gitBranch).toBe('main');
    expect(env.gitStatus).toBe('clean');
    expect(env.recentCommits).toBeUndefined();
  });

  it('carries the model id when the caller knows it', async () => {
    const env = await gatherAgentEnvironment('/repo', { modelId: 'qwen3:14b', git: fakeGit({}) });
    expect(env.modelId).toBe('qwen3:14b');
  });
});