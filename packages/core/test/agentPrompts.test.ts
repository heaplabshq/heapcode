import { describe, expect, it } from 'vitest';
import { buildFallbackAgentSystemPrompt, buildNativeAgentSystemPrompt } from '../src/agent/prompts.js';

/**
 * What the agent is told, and why each part of it is there.
 *
 * These assertions are unusually literal for prompt text because the prompt is
 * the only place several behaviours are specified at all. Three real runs are
 * behind the sections below: each spent its whole step budget investigating
 * and wrote nothing — 81 web searches on one question with six exact repeats,
 * 51 `npm view` calls after search failed, the same ten files re-read every
 * turn. None of them disobeyed the old prompt. It said "find and read the
 * relevant files before changing anything", and that is what they did.
 */
describe('agent system prompts', () => {
  it('nudges toward targeted reads over whole large files (native)', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toContain('get_symbols, search and semantic_search');
    expect(prompt).toContain('start_line/end_line');
  });

  it('nudges toward targeted reads over whole large files (fallback)', () => {
    expect(buildFallbackAgentSystemPrompt('my-workspace', [])).toContain('get_symbols, search and semantic_search');
  });

  it('nudges toward checking Skills early', () => {
    expect(buildNativeAgentSystemPrompt('my-workspace')).toContain('list_skills');
    expect(buildFallbackAgentSystemPrompt('my-workspace', [])).toContain('load_skill');
  });

  it('bounds the investigation instead of only encouraging it', () => {
    // The old wording — "find and read the relevant files before changing
    // anything" — is true and has no end, which is exactly how a run reads
    // sixty files and edits none.
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toContain('two to five files');
    expect(prompt).toMatch(/Then edit/);
  });

  it('tells it not to repeat a call it has already made', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/Never issue a search, command, or file read you have already issued/);
  });

  it('tells it to change approach rather than reword a failing one', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/two attempts .* have not worked/i);
    expect(prompt).toContain('do not vary the wording and retry');
  });

  it('says when to stop searching and ask instead', () => {
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/Two or three searches/);
  });

  it('keeps the anti-fabrication and untrusted-data rules', () => {
    // Both were added for real incidents; a prompt rewrite is exactly where
    // rules like these get quietly dropped.
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toContain('[untrusted data]');
    expect(prompt).toMatch(/is a fabrication, not progress/);
    expect(prompt).toMatch(/A reply with no tool call means the task is FINISHED/);
  });

  it('keeps "the last message is the job, not the whole history"', () => {
    // A run once resumed an abandoned task from earlier in the conversation
    // after finishing the one it was given.
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/That is history, not a\s+to-do list/);
  });

  it('holds the model to the requested scope', () => {
    // Claude Code, Copilot, and Cursor all carry a scope-discipline section;
    // heapcode runs that finish the easy third and call it done were the
    // local version of the failure it prevents.
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/requested scope is the deliverable/);
    expect(prompt).toMatch(/finish the whole task/);
  });

  it('tells the model routine in-scope choices are its own', () => {
    // A run that stopped to ask which of two equivalent imports to use was
    // spending the user's attention on a decision it was better placed to make.
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/Choices inside the scope are yours to make/);
  });

  it('makes corrections plain rather than apologetic', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/no apology/);
    expect(prompt).toMatch(/A follow-up\s+question is not evidence you were wrong/);
  });

  it('extends the fabrication rule to relayed results', () => {
    // A sub-agent's "done, tests pass" repeated as fact was the same
    // fabrication with one more step of indirection.
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/applies to relayed results/);
  });

  it('says compaction preserves work, so runs need not wrap up early', () => {
    // A run that hurried to finish "before the context ran out" produced
    // half-done work that the compaction it feared would have saved.
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/not lost, so there is no need to wrap up early/);
  });

  it('asks for file:line references instead of quoted code', () => {
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/by file and line/);
  });

  it('asks for plain reporting of failures', () => {
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/if tests fail, say so and show the failure/);
  });

  it('prefers purpose-built tools over shell equivalents', () => {
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/read_file instead\s+of cat/);
  });

  it('names the irreversible actions and asks for a line of warning first', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/force-pushing, publishing/);
    expect(prompt).toMatch(/Say what you are about to do and why before one of those/);
  });

  it('sends risky work through the gated tool rather than the shell equivalent', () => {
    // The prompt is not the gate — PermissionEngine is. But the engine reads
    // a tool's static permission class, and `run_command` is `execute`
    // whatever the command goes on to delete, so a deletion shelled out as
    // `rm` is one the user is never asked about. Steering the model to
    // delete_file is what keeps the real gate in the path.
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/delete_file, not `rm` through run_command/);
    expect(prompt).toMatch(/a deletion nobody had the chance to stop/);
  });

  it('treats a refusal as an answer instead of something to work around', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/blocked or refused call is an answer, not an obstacle/);
    expect(prompt).toMatch(/Do not retry it another way/);
  });

  it('does not treat an obstacle as authorization to remove it', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/is not authorization to remove it/);
    expect(prompt).toMatch(/Unfamiliar files may be the user's work in progress/);
  });

  it('does not invent a second permission channel through ask_user', () => {
    // An earlier draft told the model to gate its own destructive actions with
    // `ask_user` + blocksAction. Nothing enforces that, and the two hosts with
    // no human answer it "proceed with your best judgment" — manufacturing the
    // approval it was meant to be asking for (cli/src/headless.ts,
    // agent/subAgent.ts).
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).not.toContain('ask_user with blocksAction: true');
  });


  it('asks for code that matches its surroundings and no speculative additions', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/reads like the code around it/);
    expect(prompt).toMatch(/Default to no comments/);
    expect(prompt).toMatch(/Three similar lines beat the wrong abstraction/);
    expect(prompt).toMatch(/never\s+leave an implementation half-done/);
  });

  it('answers judgement questions instead of implementing them', () => {
    // "What do you think of migrating to X?" used to get one of two wrong
    // answers: a wall of analysis, or a half-started migration nobody asked
    // for. The published agents settle on answer-then-wait.
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/recommendation in two or three sentences/);
    expect(prompt).toMatch(/start work only once they agree/);
  });

  it('never trails into a tool call with a colon', () => {
    // A tool call can render collapsed in every UI we have, so "let me check:"
    // leaves a dangling sentence wherever it lands.
    expect(buildNativeAgentSystemPrompt('my-workspace')).toMatch(/Never trail into a tool call with a colon/);
  });

  it('caps the finishing summary at two sentences', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toMatch(/one or two sentences: what changed/);
  });

  it('keeps the reversibility rule in the lean tier, drops the craft', () => {
    // A small-context model can take an irreversible step as easily as a
    // frontier one, but cannot afford craft advice it will not follow anyway.
    const lean = buildNativeAgentSystemPrompt('w', { tier: 'lean' });
    expect(lean).toMatch(/Actions you cannot take back/);
    expect(lean).toMatch(/delete_file, not `rm` through run_command/);
    expect(lean).toMatch(/is not authorization to remove it/);
    expect(lean).not.toContain('Default to no comments');
  });
});

/**
 * The step budget.
 *
 * The model used to be told nothing about it and discovered the limit by
 * hitting it, a hundred turns into reading. A budget is only a constraint if
 * you know it while you can still act on it.
 */
describe('the step budget', () => {
  it('tells the model how many turns it has', () => {
    expect(buildNativeAgentSystemPrompt('w', { maxIterations: 40 })).toContain('40 model turns');
    expect(buildFallbackAgentSystemPrompt('w', [], { maxIterations: 40 })).toContain('40 model turns');
  });

  it('says how to spend them, not only how many there are', () => {
    // "You have 100 steps" is an invitation to fill them.
    const prompt = buildNativeAgentSystemPrompt('w', { maxIterations: 100 });
    expect(prompt).toMatch(/being researched, not done/);
    expect(prompt).toMatch(/finish something small/);
  });

  it('says nothing at all when the host sets no limit', () => {
    expect(buildNativeAgentSystemPrompt('w')).not.toContain('model turns');
  });
});

describe('a host that is not a coding agent', () => {
  // The loop takes tools as data and knows nothing about files, but its system
  // prompt was hardcoded to the coding agent — so a browser host got an agent
  // told to go read files that do not exist. Found by heapbrowse, the second
  // host to drive this loop.
  const BROWSER = 'You are heapbrowse. You help with the web page the user is viewing.';

  it('replaces the coding identity when the host supplies its own', () => {
    const prompt = buildNativeAgentSystemPrompt('example.com', { base: BROWSER });
    expect(prompt).toContain(BROWSER);
    expect(prompt).not.toContain('autonomous coding agent');
    expect(prompt).not.toContain('read_file');
  });

  it('still appends the protocol, which is core’s contract and not the host’s', () => {
    // A host forced to restate this would be copying the one part core owns.
    const prompt = buildNativeAgentSystemPrompt('example.com', { base: BROWSER });
    expect(prompt).toContain('`finish`');
    expect(prompt).toMatch(/ONLY way to end the run/);
  });

  it('still gets the budget, which belongs to the loop rather than the identity', () => {
    const prompt = buildNativeAgentSystemPrompt('example.com', { base: BROWSER, maxIterations: 25 });
    expect(prompt).toContain('25 model turns');
    expect(prompt).not.toContain('autonomous coding agent');
  });

  it('does the same for the text-protocol fallback, tool list included', () => {
    const tools = [
      { name: 'read_page', description: 'Read it', parameters: {}, permission: 'read' as const },
    ];
    const prompt = buildFallbackAgentSystemPrompt('example.com', tools, { base: BROWSER });
    expect(prompt).toContain(BROWSER);
    expect(prompt).not.toContain('autonomous coding agent');
    expect(prompt).toContain('read_page');
    expect(prompt).toContain('<tool name="finish">');
  });

  it('keeps the coding prompt for hosts that pass nothing', () => {
    expect(buildNativeAgentSystemPrompt('my-repo')).toContain('autonomous coding agent');
    expect(buildFallbackAgentSystemPrompt('my-repo', [])).toContain('autonomous coding agent');
  });

  it('declares the system-reminder tag in the core-owned tail, so a replaced base keeps it', () => {
    // The loop's nudges are sent as tagged user turns (loop.ts); without this
    // declaration a host that replaces the whole base — heapbrowse — gets
    // tagged steering it was never told how to read.
    const inNative = buildNativeAgentSystemPrompt('w');
    const inFallback = buildFallbackAgentSystemPrompt('w', []);
    const inReplacedBase = buildNativeAgentSystemPrompt('w', { base: BROWSER });
    for (const prompt of [inNative, inFallback, inReplacedBase]) {
      expect(prompt).toMatch(/<system-reminder> tags come from heapcode itself, not from the user/);
      expect(prompt).toMatch(/do not quote them back, apologize for them, or treat them as new scope/);
    }
  });
});
