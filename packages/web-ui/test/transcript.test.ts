import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@heapcode/core';
import {
  activityOf,
  concat,
  emptyTranscript,
  fromMessages,
  reduce,
  settle,
  type ToolItem,
} from '../src/transcript.js';

/**
 * The event stream → what the user sees.
 *
 * Worth testing directly because it is also the replay path: after a browser
 * refresh the host hands back buffered events and this same reducer has to
 * rebuild the previous tab's view exactly (§5.4). A bug here shows up as a
 * transcript that renders correctly live and wrongly after a reload.
 */

let n = 0;
const fold = (events: AgentEvent[], start = emptyTranscript) =>
  events.reduce((t, e) => reduce(t, e, n++), start);

describe('transcript reducer', () => {
  it('accumulates deltas into one streaming message, then settles it', () => {
    const t = fold([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo ' },
      { type: 'text_delta', text: 'world' },
      { type: 'text_end' },
    ]);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: 'text', role: 'assistant', text: 'Hello world', streaming: false });
  });

  it('starts a NEW message after a tool call, rather than appending to the old one', () => {
    // The bug this guards: narration, a tool call, then a summary must read as
    // two assistant messages around a chip — not one run-on paragraph.
    const t = fold([
      { type: 'text_delta', text: 'Looking…' },
      { type: 'text_end' },
      { type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'a.ts' } },
      { type: 'tool_result', id: 't1', name: 'read_file', content: 'contents' },
      { type: 'text_delta', text: 'Found it.' },
      { type: 'text_end' },
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(['text', 'tool', 'text']);
    expect((t.items[0] as { text: string }).text).toBe('Looking…');
    expect((t.items[2] as { text: string }).text).toBe('Found it.');
  });

  it('attaches a result to its own call, not the most recent one', () => {
    // Out-of-order completion is normal with sub-agents.
    const t = fold([
      { type: 'tool_call', id: 'a', name: 'search', args: {} },
      { type: 'tool_call', id: 'b', name: 'read_file', args: {} },
      { type: 'tool_result', id: 'a', name: 'search', content: 'A-RESULT' },
    ]);
    const [a, b] = t.items as ToolItem[];
    expect(a.result).toBe('A-RESULT');
    expect(a.done).toBe(true);
    expect(b.done).toBe(false);
  });

  it('marks an errored tool so the chip can show it', () => {
    const t = fold([
      { type: 'tool_call', id: 'x', name: 'run_command', args: { command: 'false' } },
      { type: 'tool_result', id: 'x', name: 'run_command', content: 'exit 1', isError: true },
    ]);
    expect((t.items[0] as ToolItem).isError).toBe(true);
  });

  it('keeps sub-agent calls linked to their parent, for nesting', () => {
    const t = fold([
      { type: 'tool_call', id: 'p', name: 'delegate_task', args: { task: 'investigate' } },
      { type: 'tool_call', id: 'c', name: 'read_file', args: { path: 'x.ts' }, parent: 'p' },
    ]);
    expect((t.items[1] as ToolItem).parent).toBe('p');
  });

  it('a complete `text` event replaces an open streamed message instead of duplicating it', () => {
    const t = fold([
      { type: 'text_delta', text: 'partial' },
      { type: 'text', text: 'the whole message' },
    ]);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ text: 'the whole message', streaming: false });
  });

  it('tracks context usage and compaction for the header', () => {
    const t = fold([
      { type: 'context_usage', usedTokens: 1200, windowTokens: 8000 },
      { type: 'compaction', beforeTokens: 7000, afterTokens: 2000 },
    ]);
    expect(t.usedTokens).toBe(1200);
    expect(t.windowTokens).toBe(8000);
    expect(t.compacted).toEqual({ before: 7000, after: 2000 });
  });

  it('opens reasoning while it streams and closes it when it ends', () => {
    // Collapsed-by-default meant nothing appeared on screen during a run,
    // which reads as a hang. Streaming state drives the default open state.
    const mid = fold([
      { type: 'reasoning_delta', text: 'Let me ' },
      { type: 'reasoning_delta', text: 'check…' },
    ]);
    expect(mid.items[0]).toMatchObject({ kind: 'reasoning', text: 'Let me check…', streaming: true });

    const done = fold([{ type: 'reasoning_end' }], mid);
    expect(done.items[0]).toMatchObject({ streaming: false });
  });

  it('starts a new reasoning block after the previous one ended', () => {
    const t = fold([
      { type: 'reasoning_delta', text: 'first' },
      { type: 'reasoning_end' },
      { type: 'reasoning_delta', text: 'second' },
    ]);
    expect(t.items).toHaveLength(2);
    expect((t.items[1] as { text: string }).text).toBe('second');
  });

  it('ignores events it does not draw, without disturbing the transcript', () => {
    const before = fold([{ type: 'text', text: 'hi' }]);
    const after = fold(
      [
        { type: 'tool_stream', chars: 100 },
        { type: 'memory_candidate', note: 'remember this' },
      ],
      before,
    );
    // Same object back — React can skip the re-render entirely.
    expect(after).toBe(before);
  });

  it('settle() closes a stream left open by a cancelled run', () => {
    const open = fold([{ type: 'text_delta', text: 'interrupted' }]);
    expect((open.items[0] as { streaming?: boolean }).streaming).toBe(true);
    expect((settle(open).items[0] as { streaming?: boolean }).streaming).toBe(false);
  });

  it('rebuilds a prior conversation from stored messages', () => {
    const t = fromMessages([
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(t.items.map((i) => (i as { role: string }).role)).toEqual(['user', 'assistant']);
  });

  it('rebuilds tool chips and plans from history, not just prose', () => {
    const t = fromMessages([
      { role: 'user', content: 'reset the workspace' },
      { role: 'assistant', content: 'Here is the plan', ui: { plan: true } },
      {
        role: 'assistant',
        content: '',
        ui: {
          tool: {
            id: 't1',
            name: 'run_command',
            description: 'run_command: npm test',
            args: { command: 'npm test' },
            result: '7 passing',
          },
        },
      },
      { role: 'assistant', content: 'all green' },
    ]);

    expect(t.items.map((i) => i.kind)).toEqual(['text', 'plan', 'tool', 'text']);
    const tool = t.items[2] as ToolItem;
    // Finished, with its output and the args the chip renders its summary from.
    expect(tool).toMatchObject({ name: 'run_command', done: true, result: '7 passing' });
    expect(tool.args).toEqual({ command: 'npm test' });
    expect(tool.isError).toBeFalsy();
  });

  it('survives a stored tool call that predates argument persistence', () => {
    const t = fromMessages([
      { role: 'assistant', content: '', ui: { tool: { name: 'read_file', description: 'read_file: a.ts' } } },
    ]);
    expect((t.items[0] as ToolItem).args).toEqual({});
  });

  it('rebuilds thinking blocks from history, collapsed', () => {
    // Reasoning used to be dropped on the way into history, so a reloaded
    // conversation lost every thinking block it had shown live.
    const t = fromMessages([
      { role: 'user', content: 'why?' },
      { role: 'assistant', content: 'because of X', ui: { reasoning: true } },
      { role: 'assistant', content: 'Because of X.' },
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(['text', 'reasoning', 'text']);
    expect(t.items[1]).toMatchObject({ text: 'because of X', streaming: undefined });
  });

  it('restores an in-flight turn: unfinished chip, still-streaming tail', () => {
    // What the host sends as `UiHelloResult.pending` after a mid-run reload.
    const t = fromMessages(
      [
        { role: 'user', content: 'run the tests' },
        {
          role: 'assistant',
          content: '',
          ui: { tool: { name: 'run_command', description: '', args: { command: 'npm test' }, done: false } },
        },
        { role: 'assistant', content: 'Half a th', ui: { streaming: true } },
      ],
      'live',
    );
    expect((t.items[1] as ToolItem).done).toBe(false);
    expect(t.items[2]).toMatchObject({ kind: 'text', streaming: true });

    // And the live stream keeps appending to that tail rather than opening a
    // second message beside it.
    const next = reduce(t, { type: 'text_delta', text: 'ought.' }, 99);
    expect(next.items).toHaveLength(3);
    expect(next.items[2]).toMatchObject({ text: 'Half a thought.' });
  });

  it('keeps history and the in-flight turn from colliding on React keys', () => {
    const history = fromMessages([{ role: 'user', content: 'first' }]);
    const pending = fromMessages([{ role: 'user', content: 'second' }], 'live');
    const ids = concat(history, pending).items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tracks tool-call arguments as the model writes them, quantised to 1k', () => {
    // `tool_stream` counts ARGUMENT fragments streaming out of the provider
    // (openaiCompatible.ts:449) and fires BEFORE any `tool_call` event exists.
    // Attaching it to "the last unfinished tool" — which this used to do —
    // credited the count to the previous call and called it that call's output.
    const empty = fold([{ type: 'tool_stream', chars: 400 }]);
    // Under 1k is not worth a re-render — same object back.
    expect(empty).toBe(emptyTranscript);

    const writing = fold([{ type: 'tool_stream', chars: 2_400 }]);
    expect(writing.writingCallK).toBe(2);
    expect(writing.items).toHaveLength(0);
    // Within the same 1k step, still no re-render.
    expect(fold([{ type: 'tool_stream', chars: 2_900 }], writing)).toBe(writing);

    // The call arrives; there is nothing left to count.
    const called = fold([{ type: 'tool_call', id: 'c', name: 'edit_file', args: {} }], writing);
    expect(called.writingCallK).toBeUndefined();
  });

  it('settle() also closes an unfinished tool and an open thought', () => {
    // Cancel mid-tool used to leave the chip spinning forever: `tool_result`
    // is the only thing that ever cleared it, and a cancelled run sends none.
    const open = fold([
      { type: 'reasoning_delta', text: 'hmm' },
      { type: 'tool_call', id: 'c', name: 'run_command', args: {} },
    ]);
    const done = settle(open);
    expect(done.items[0]).toMatchObject({ kind: 'reasoning', streaming: false });
    expect((done.items[1] as ToolItem).done).toBe(true);
    // Nothing to close means nothing to re-render.
    expect(settle(done)).toBe(done);
    // A cancel mid-call also drops the counter for arguments that will never
    // finish arriving.
    expect(settle(fold([{ type: 'tool_stream', chars: 2_000 }])).writingCallK).toBeUndefined();
  });
});

describe('activityOf — what the working indicator says', () => {
  it('reports a call being written before it exists, then the tool running', () => {
    const writing = fold([{ type: 'tool_stream', chars: 3_100 }]);
    expect(activityOf(writing)).toEqual({ phase: 'writing-call', writingCallK: 3 });

    const running = fold([{ type: 'tool_call', id: 'c', name: 'run_command', args: {} }], writing);
    expect(activityOf(running)).toEqual({ phase: 'tool', tool: 'run_command' });
  });

  it('distinguishes thinking from responding', () => {
    expect(activityOf(fold([{ type: 'reasoning_delta', text: 'hm' }])).phase).toBe('thinking');
    expect(activityOf(fold([{ type: 'text_delta', text: 'ok' }])).phase).toBe('responding');
  });

  it('falls back to "working" between steps — the gap that used to show nothing', () => {
    // Tool finished, next token not yet arrived. Before the indicator existed
    // this stretch had no spinner, no text and no chip: a model taking twenty
    // seconds to decide looked exactly like a hung page.
    const t = fold([
      { type: 'tool_call', id: 'c', name: 'read_file', args: {} },
      { type: 'tool_result', id: 'c', name: 'read_file', content: 'x' },
    ]);
    expect(activityOf(t).phase).toBe('working');
    expect(activityOf(emptyTranscript).phase).toBe('working');
  });
});
