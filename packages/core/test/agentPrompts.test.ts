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
