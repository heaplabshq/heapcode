import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Conversation } from '@heapcode/core';
import { SessionCheckpoint } from '../src/agent/checkpoint.js';
import { WorkspaceToolExecutor, agentToolDefinitions } from '../src/agent/workspaceTools.js';

/**
 * The tool is only useful if it is actually offered and actually dispatched —
 * the algorithm being right in core says nothing about either.
 */

async function executorWith(history?: (id?: string) => Promise<Conversation | undefined>) {
  const root = await mkdtemp(join(tmpdir(), 'hist-tool-'));
  return new WorkspaceToolExecutor(
    root,
    new SessionCheckpoint(root),
    1_000,
    undefined,
    undefined,
    undefined,
    undefined,
    history,
  );
}

const conversation: Conversation = {
  id: 'c1',
  title: 'Migration',
  updatedAt: 1,
  messages: [
    { role: 'user', content: 'Which port does staging use?' },
    { role: 'assistant', content: 'Staging is on port 5433.' },
  ],
};

describe('search_history', () => {
  it('is on the roster, so the model can reach for it', () => {
    expect(agentToolDefinitions.map((t) => t.name)).toContain('search_history');
  });

  it('needs no approval, being a read of what was already said here', () => {
    expect(agentToolDefinitions.find((t) => t.name === 'search_history')?.permission).toBe('read');
  });

  it('returns the turn that said it', async () => {
    const executor = await executorWith(async () => conversation);
    const result = await executor.execute({ id: '1', name: 'search_history', args: { query: 'staging port' } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('5433');
    expect(result.content).toContain('turn 2 of 2');
  });

  it('asks for a query rather than returning everything', async () => {
    const executor = await executorWith(async () => conversation);
    const result = await executor.execute({ id: '1', name: 'search_history', args: { query: '  ' } });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Missing "query"/);
  });

  it('says so when the host wired no record, rather than answering emptily', async () => {
    const executor = await executorWith(undefined);
    const result = await executor.execute({ id: '1', name: 'search_history', args: { query: 'anything' } });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no conversation record/i);
  });

  it('reports a named conversation that does not exist', async () => {
    const executor = await executorWith(async (id) => (id === 'c1' ? conversation : undefined));
    const result = await executor.execute({
      id: '1',
      name: 'search_history',
      args: { query: 'staging', conversation_id: 'nope' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No conversation "nope"');
  });

  it('searches a named conversation when asked', async () => {
    const other: Conversation = {
      id: 'c2',
      title: 'Earlier',
      updatedAt: 0,
      messages: [{ role: 'assistant', content: 'The old port was 5432.' }],
    };
    const executor = await executorWith(async (id) => (id === 'c2' ? other : conversation));
    const result = await executor.execute({
      id: '1',
      name: 'search_history',
      args: { query: 'port', conversation_id: 'c2' },
    });
    expect(result.content).toContain('5432');
  });

  it('describes itself for the tool chip', async () => {
    const executor = await executorWith(async () => conversation);
    expect(executor.describe({ id: '1', name: 'search_history', args: { query: 'staging port' } })).toBe(
      'Search the conversation for "staging port"',
    );
  });
});
