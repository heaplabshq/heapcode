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
import { emptyTranscript, reduce, type Transcript } from '../src/transcript.js';
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

  it('names what is happening while it happens', () => {
    const writing = fold([{ type: 'tool_stream', chars: 4_200 }]);
    render(<MessageList transcript={writing} busy runStartedAt={Date.now()} />);
    expect(screen.getByRole('status').textContent).toContain('Writing a tool call… 4k');
    cleanup();

    const running = fold([{ type: 'tool_call', id: 'c', name: 'run_command', args: { command: 'npm test' } }]);
    render(<MessageList transcript={running} busy runStartedAt={Date.now()} />);
    expect(screen.getByRole('status').textContent).toContain('Running run_command…');
  });

  it('is gone the moment the run is not', () => {
    const done = fold([{ type: 'text', text: 'finished' }]);
    render(<MessageList transcript={done} busy={false} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('tool chips', () => {
  it('colourises an edit’s diff and shows its line counts', () => {
    const t = fold([
      { type: 'tool_call', id: 'e', name: 'edit_file', args: { path: 'src/app.ts' } },
      { type: 'tool_result', id: 'e', name: 'edit_file', content: EDIT_DIFF },
    ]);
    const { container } = render(<MessageList transcript={t} />);

    // Open by default — the diff is the point of the call.
    expect(container.querySelector('.diff-add')?.textContent).toBe('+const a = 2;');
    expect(container.querySelector('.diff-del')?.textContent).toBe('-const a = 1;');
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
