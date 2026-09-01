import { describe, expect, it } from 'vitest';
import { buildAgentTask } from '../src/agent/task.js';

/**
 * The shape of the agent's user turn, built in one place.
 *
 * Every host used to assemble this by hand; these tests pin the contract the
 * five hand-rolled copies agreed on, so a drift in one host is a bug here
 * rather than a difference between surfaces.
 */
describe('buildAgentTask', () => {
  it('is just the task when nothing precedes it', () => {
    expect(buildAgentTask({ task: 'fix the bug' })).toBe('fix the bug');
  });

  it('separates each part with --- and labels the task', () => {
    const full = buildAgentTask({ personaAddendum: 'stay read-only', instructions: 'use pnpm', task: 'fix the bug' });
    expect(full).toBe('stay read-only\n\n---\n\nuse pnpm\n\n---\n\nTask: fix the bug');
  });

  it('skips absent parts entirely rather than leaving empty separators', () => {
    const full = buildAgentTask({ instructions: '', workspaceContext: undefined, task: 'fix the bug' });
    expect(full).toBe('fix the bug');
  });

  it('puts the sub-agent scope addendum before the persona constraints', () => {
    // A sub-agent that reads a persona relaxation after its scope notice
    // could read the relaxation as widening the scope.
    const full = buildAgentTask({ scopeAddendum: 'stay in scope', personaAddendum: 'be terse', task: 'go' });
    expect(full.indexOf('stay in scope')).toBeLessThan(full.indexOf('be terse'));
    expect(full).toMatch(/Task: go$/);
  });
});