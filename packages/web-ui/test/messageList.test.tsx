// @vitest-environment jsdom
/**
 * What the chat pane actually puts on screen.
 *
 * The reducer tests next door prove the transcript is right; they say nothing
 * about whether any of it is rendered, which is where all three of these bugs
 * lived. A run with nothing streaming drew an empty pane. An edit's diff was
 * rendered as undifferentiated `<pre>` text while the CLI coloured the same
 * string. Both look fine in a reducer snapshot.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageList } from '../src/components/MessageList.js';
import { emptyTranscript, reduce, withNotice, type Transcript } from '../src/transcript.js';
import type { AgentEvent } from '@heapcode/core';

// jsdom has no layout, so it has no scrollIntoView — the list's follow-the-
// stream effect calls it on every render.
beforeEach(() => {
  Element.prototype.scrollIntoView = (): void => {};
});
afterEach(cleanup);

let n = 0;
const fold = (events: AgentEvent[], start: Transcript = emptyTranscript): Transcript =>
  events.reduce((t, e) => reduce(t, e, n++), start);

const EDIT_DIFF = [
  'Edited src/app.ts.',
  '@@ -1,3 +1,3 @@',
  ' const keep = 1;',
  '-const a = 1;',
  '+const a = 2;',
].join('\n');

describe('the working indicator', () => {
  it('is on screen for the whole run, including the gap between steps', () => {
    // The reported bug: after a tool returned and before the next token
    // arrived, nothing at all was drawn and the page read as hung.
    const between = fold([
      { type: 'tool_call', id: 'c', name: 'read_file', args: { path: 'a.ts' } },
      { type: 'tool_result', id: 'c', name: 'read_file', content: 'contents' },
    ]);
    render(<MessageList transcript={between} busy runStartedAt={Date.now()} />);
    expect(screen.getByRole('status').textContent).toContain('Working…');
  });

  it('covers the other invisible stretch: a call being written', () => {
    // Arguments stream before the tool_call event exists, so there is no chip
    // yet — a large edit is a long silence with nothing on screen.
    const writing = fold([{ type: 'tool_stream', chars: 4_200 }]);
    render(<MessageList transcript={writing} busy runStartedAt={Date.now()} />);
    expect(screen.getByRole('status').textContent).toContain('Writing a tool call… 4k');
  });

  it('stays out of the way when the transcript is already showing the answer', () => {
    // Narrating "Running run_command…" beside a chip that says so, or
    // "Thinking…" above an open reasoning block, is telling the user what they
    // are looking at. The CLI makes the same call (ink/App.tsx:1787-1796).
    const cases: AgentEvent[][] = [
      [{ type: 'tool_call', id: 'c', name: 'run_command', args: { command: 'npm test' } }],
      [{ type: 'reasoning_delta', text: 'hmm' }],
      [{ type: 'text_delta', text: 'Here is' }],
    ];
    for (const events of cases) {
      render(<MessageList transcript={fold(events)} busy runStartedAt={Date.now()} />);
      expect(screen.queryByRole('status')).toBeNull();
      cleanup();
    }
  });

  it('is gone the moment the run is not', () => {
    const done = fold([{ type: 'text', text: 'finished' }]);
    render(<MessageList transcript={done} busy={false} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the still-writing marker', () => {
  it('is dots, not a text caret, and only on the message being written', () => {
    // A blinking accent-blue block is an editor cursor; in a read-only
    // transcript it reads as "type here".
    const t = fold([{ type: 'text_delta', text: 'Working on it' }]);
    const { container } = render(<MessageList transcript={t} busy />);
    expect(container.querySelector('.typing')).not.toBeNull();
    expect(container.querySelector('.caret')).toBeNull();
  });

  it('goes away the moment the model starts doing something else', () => {
    const t = fold([
      { type: 'text_delta', text: 'Let me check' },
      { type: 'tool_call', id: 'c', name: 'read_file', args: { path: 'a.ts' } },
    ]);
    const { container } = render(<MessageList transcript={t} busy />);
    expect(container.querySelector('.typing')).toBeNull();
  });
});

describe('tool chips', () => {
  it('colourises an edit’s diff and shows its line counts', () => {
    const t = fold([
      { type: 'tool_call', id: 'e', name: 'edit_file', args: { path: 'src/app.ts' } },
      { type: 'tool_result', id: 'e', name: 'edit_file', content: EDIT_DIFF },
    ]);
    const { container } = render(<MessageList transcript={t} />);

    // Open by default — the diff is the point of the call. The marker lives
    // in the gutter now, so the text cell is the code and nothing else.
    expect(container.querySelector('.diff-add .diff-text')?.textContent).toBe('const a = 2;');
    expect(container.querySelector('.diff-del .diff-text')?.textContent).toBe('const a = 1;');
    expect(container.querySelector('.diff-add .diff-sign')?.textContent).toBe('+');
    expect(container.querySelector('.diff-hunk')).not.toBeNull();
    // The context line stays uncoloured.
    expect(container.querySelector('.diff-line.diff-add ~ .diff-add')).toBeNull();

    const stats = container.querySelector('.chip-stats');
    expect(stats?.textContent).toBe('+1−1');
  });

  it('leaves non-diff output as plain preformatted text', () => {
    // The guard against over-eager colouring: a log full of `-` lines must not
    // render as a wall of deletions.
    const t = fold([
      { type: 'tool_call', id: 'r', name: 'run_command', args: { command: 'npm test' } },
      { type: 'tool_result', id: 'r', name: 'run_command', content: '- 3 passing\n- 1 failing' },
    ]);
    const { container } = render(<MessageList transcript={t} />);
    expect(container.querySelector('.diff-del')).toBeNull();
    // And it stays collapsed, as ordinary output always did.
    expect(container.querySelector('.chip-body')).toBeNull();
  });
});

describe('a host notice about how the run ended', () => {
  it('is drawn in the transcript, not as something the model said', () => {
    const t = withNotice(
      fold([{ type: 'text', text: 'Progress so far: three of ten files.' }]),
      'Cut off at the 100-step limit for one run, mid-task — the summary above is not a finished job.',
      true,
    );
    const { container } = render(<MessageList transcript={t} />);

    const notice = container.querySelector('.notice-warn');
    expect(notice?.textContent).toContain('100-step limit');
    // The assistant bubble holds the model's words and nothing else — the
    // whole point is that a cut-off run cannot pose as a finished one.
    expect(container.querySelector('.msg-assistant')?.textContent).not.toContain('100-step limit');
  });
});

describe('task lists in the transcript', () => {
  const twoRuns = (): Transcript => {
    const first = fold([
      { type: 'todo_update', todos: [{ content: 'old plan', status: 'completed' }] },
    ]);
    return fold(
      [{ type: 'todo_update', todos: [{ content: 'live plan', status: 'in_progress' }] }],
      { ...first, items: [...first.items, { kind: 'text', id: 'u1', role: 'user', text: 'again' }] },
    );
  };

  it('leaves the pinned list to the bar, and keeps every other one', () => {
    // Drawing it in both places is the bug this dedup exists to prevent: the
    // same list twice, one of them scrolling away. Earlier runs keep their
    // card, because that is the record of what each turn set out to do.
    const t = twoRuns();
    const live = t.items.find((i) => i.kind === 'tasks' && i.id !== t.items[0]!.id)!;

    const { container } = render(<MessageList transcript={t} hideTaskId={live.id} />);
    expect(container.querySelectorAll('.tasks')).toHaveLength(1);
    expect(container.textContent).toContain('old plan');
    expect(container.textContent).not.toContain('live plan');
  });

  it('draws every list once the run ends and nothing is pinned any more', () => {
    // The bar only exists while a run is in flight. When it goes, the card it
    // was standing in for has to come back — otherwise the finished turn has
    // no record of what it set out to do.
    const { container } = render(<MessageList transcript={twoRuns()} />);
    expect(container.querySelectorAll('.tasks')).toHaveLength(2);
    expect(container.textContent).toContain('live plan');
  });
});

describe('the empty state', () => {
  it('centres itself instead of hanging from the top of the pane', () => {
    // `margin: auto` needs a flex parent to centre against, and the populated
    // scroller stays a plain block — so the modifier is the whole mechanism.
    const { container } = render(<MessageList transcript={emptyTranscript} />);
    expect(container.querySelector('.messages-empty')).toBeTruthy();
    expect(container.querySelector('.empty')).toBeTruthy();
  });

  it('breaks the hint at its clauses rather than wherever the measure runs out', () => {
    const { container } = render(<MessageList transcript={emptyTranscript} />);
    const hint = container.querySelector('.empty-hint')!;

    // Three clauses, two separators — and the separators are decoration a
    // reader already hears in the phrasing, so they stay out of the a11y tree.
    expect(hint.querySelectorAll('span:not(.empty-sep)')).toHaveLength(3);
    hint.querySelectorAll('.empty-sep').forEach((sep) => {
      expect(sep.getAttribute('aria-hidden')).toBe('true');
    });
    expect(hint.textContent).toContain('Paste a screenshot straight into the box');
  });

  it('goes away as soon as there is a conversation', () => {
    const { container } = render(<MessageList transcript={fold([{ type: 'text', text: 'hello' }])} />);
    expect(container.querySelector('.empty')).toBeNull();
    expect(container.querySelector('.messages-empty')).toBeNull();
  });
});
