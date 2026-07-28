import { describe, expect, it } from 'vitest';
import { agentToolDefinitions } from '../src/agent/workspaceTools.js';
import { DELEGATE_TASK_TOOL } from '../src/agent/delegate.js';

/**
 * The sub-agent runner itself moved to @heapcode/core and its tests with it
 * (packages/core/test/subAgent.test.ts) — delegation runs server-side now.
 * What stays here is the tool *definition* the CLI offers, which is still the
 * CLI's own: the extension advertises a differently-worded one.
 */
describe('DELEGATE_TASK_TOOL', () => {
  it('is declared execute-permission and is not part of the default tool list', () => {
    expect(DELEGATE_TASK_TOOL.name).toBe('delegate_task');
    expect(DELEGATE_TASK_TOOL.permission).toBe('execute');
    // App.tsx and headless.ts add it explicitly and gate execution behind
    // /subagents and --sub-agents respectively.
    expect(agentToolDefinitions.some((t) => t.name === 'delegate_task')).toBe(false);
  });
});
