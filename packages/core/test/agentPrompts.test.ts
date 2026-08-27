import { describe, expect, it } from 'vitest';
import { buildFallbackAgentSystemPrompt, buildNativeAgentSystemPrompt } from '../src/agent/prompts.js';

describe('agent system prompts', () => {
  it('nudges toward targeted reads over whole large files (native)', () => {
    const prompt = buildNativeAgentSystemPrompt('my-workspace');
    expect(prompt).toContain('get_symbols/search/semantic_search');
    expect(prompt).toContain('start_line/end_line');
  });

  it('nudges toward targeted reads over whole large files (fallback)', () => {
    const prompt = buildFallbackAgentSystemPrompt('my-workspace', []);
    expect(prompt).toContain('get_symbols/search/semantic_search');
  });

  it('nudges toward checking Skills early', () => {
    expect(buildNativeAgentSystemPrompt('my-workspace')).toContain('list_skills');
    expect(buildFallbackAgentSystemPrompt('my-workspace', [])).toContain('load_skill');
  });
});

describe('a host that is not a coding agent', () => {
  // The loop takes tools as data and knows nothing about files, but its system
  // prompt was hardcoded to the coding agent — so a browser host got an agent
  // told to go read files that do not exist. Found by heapbrowse, the second
  // host to drive this loop.
  const BROWSER = 'You are heapbrowse. You help with the web page the user is viewing.';

  it('replaces the coding identity when the host supplies its own', () => {
    const prompt = buildNativeAgentSystemPrompt('example.com', BROWSER);
    expect(prompt).toContain(BROWSER);
    expect(prompt).not.toContain('autonomous coding agent');
    expect(prompt).not.toContain('read_file');
  });

  it('still appends the protocol, which is core’s contract and not the host’s', () => {
    // A host forced to restate this would be copying the one part core owns.
    const prompt = buildNativeAgentSystemPrompt('example.com', BROWSER);
    expect(prompt).toContain('`finish`');
    expect(prompt).toMatch(/ONLY way to end the session/);
  });

  it('does the same for the text-protocol fallback, tool list included', () => {
    const tools = [
      { name: 'read_page', description: 'Read it', parameters: {}, permission: 'read' as const },
    ];
    const prompt = buildFallbackAgentSystemPrompt('example.com', tools, BROWSER);
    expect(prompt).toContain(BROWSER);
    expect(prompt).not.toContain('autonomous coding agent');
    expect(prompt).toContain('read_page');
    expect(prompt).toContain('<tool name="finish">');
  });

  it('keeps the coding prompt for hosts that pass nothing', () => {
    expect(buildNativeAgentSystemPrompt('my-repo')).toContain('autonomous coding agent');
    expect(buildFallbackAgentSystemPrompt('my-repo', [])).toContain('autonomous coding agent');
  });
});
