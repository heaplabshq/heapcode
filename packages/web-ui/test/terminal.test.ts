import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@heapcode/core';
import { terminalEntries } from '../src/terminal.js';
import { emptyTranscript, reduce } from '../src/transcript.js';

/**
 * The Terminal tab is derived from the transcript rather than accumulated
 * separately — which is what makes it correct after a reconnect for free.
 * These cases pin that derivation.
 */

let n = 0;
const fold = (events: AgentEvent[]) => events.reduce((t, e) => reduce(t, e, n++), emptyTranscript);

describe('terminalEntries', () => {
  it('picks out command tools and pairs them with their output', () => {
    const t = fold([
      { type: 'tool_call', id: 'c1', name: 'run_command', args: { command: 'npm test' } },
      { type: 'tool_result', id: 'c1', name: 'run_command', content: '5 passing' },
    ]);
    const entries = terminalEntries(t.items);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ command: 'npm test', output: '5 passing', done: true, isError: undefined });
  });

  it('ignores non-command tools — a file read is not terminal output', () => {
    const t = fold([
      { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'a.ts' } },
      { type: 'tool_result', id: 'r1', name: 'read_file', content: 'contents' },
      { type: 'tool_call', id: 'c1', name: 'run_tests', args: { command: 'vitest' } },
    ]);
    const entries = terminalEntries(t.items);
    expect(entries.map((e) => e.command)).toEqual(['vitest']);
  });

  it('marks a still-running command as not done', () => {
    const t = fold([{ type: 'tool_call', id: 'c1', name: 'run_command', args: { command: 'sleep 10' } }]);
    expect(terminalEntries(t.items)[0]).toMatchObject({ done: false, output: undefined });
  });

  it('carries the error flag so a failed command reads as failed', () => {
    const t = fold([
      { type: 'tool_call', id: 'c1', name: 'run_command', args: { command: 'false' } },
      { type: 'tool_result', id: 'c1', name: 'run_command', content: 'exit 1', isError: true },
    ]);
    expect(terminalEntries(t.items)[0]?.isError).toBe(true);
  });

  it('falls back to the tool name when no command argument is present', () => {
    const t = fold([{ type: 'tool_call', id: 'c1', name: 'run_tests', args: {} }]);
    expect(terminalEntries(t.items)[0]?.command).toBe('run_tests');
  });

  it('is empty for a transcript with no commands', () => {
    const t = fold([{ type: 'text', text: 'hello' }]);
    expect(terminalEntries(t.items)).toEqual([]);
  });
});
