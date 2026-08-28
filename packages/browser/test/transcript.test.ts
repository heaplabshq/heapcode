import { describe, expect, it } from 'vitest';
import { answerFrom, type Step, type Turn } from '../src/sidepanel/useChat.js';

/**
 * How a run reads back once it is over.
 *
 * The shape here is the fix for a real defect: narration was accumulated into
 * one string across every iteration of the run, so a three-step task rendered
 * as the model saying almost the same thing three times in a row, and the
 * finish summary -- the answer the model actually meant to give -- was dropped
 * entirely because the host stubbed core's `onText`.
 */

function assistant(steps: Step[], content = ''): Turn {
  return { role: 'assistant', content, steps };
}

/** What the transcript renders, in order. */
function render(turn: Turn): string[] {
  const out = (turn.steps ?? []).map((step) => {
    if (step.kind === 'tool') return `[tool ${step.tool.name}]`;
    if (step.kind === 'view') return '[view]';
    if (step.kind === 'data') return `[data ${step.dataset.rows.length} rows]`;
    return step.text;
  });
  if (turn.content) out.push(`ANSWER: ${turn.content}`);
  return out;
}

const tool = (id: string, name: string): Step => ({
  kind: 'tool',
  tool: { id, name, args: {} },
});

describe('a finished run', () => {
  it('keeps narration attached to the step it belongs to', () => {
    const turn = assistant(
      [
        { kind: 'note', text: 'Let me look at the page.' },
        tool('1', 'read_page'),
        { kind: 'note', text: 'It is below the fold.' },
        tool('2', 'scroll'),
      ],
      'The cheapest is the Wakewell at 499.',
    );

    expect(render(turn)).toEqual([
      'Let me look at the page.',
      '[tool read_page]',
      'It is below the fold.',
      '[tool scroll]',
      'ANSWER: The cheapest is the Wakewell at 499.',
    ]);
  });

  it('shows the finish summary as the answer, not the running commentary', () => {
    // Core sends the summary through `onText`, separately from the narration it
    // streams. Stubbing that out left the user reading the commentary instead.
    const turn = assistant(
      [{ kind: 'note', text: 'Searching for Cloth Fusion.' }],
      'Cloth Fusion is [167], 979 rupees.',
    );
    expect(render(turn).at(-1)).toBe('ANSWER: Cloth Fusion is [167], 979 rupees.');
  });

  it('never runs two iterations of narration together as one block', () => {
    // The bug, precisely: three separate notes concatenated into one string is
    // indistinguishable from a model that repeated itself.
    const turn = assistant([
      { kind: 'note', text: 'I found the product.' },
      tool('1', 'get_elements'),
      { kind: 'note', text: 'I found the product.' },
    ]);
    const notes = (turn.steps ?? []).filter((s) => s.kind === 'note');
    expect(notes).toHaveLength(2);
    expect(render(turn)).not.toContain('I found the product.I found the product.');
  });

  it('promotes narration to the answer when the run never called finish', () => {
    // A stopped or step-limited run still said something, and that is the only
    // answer there is -- showing an empty reply throws the work away.
    const turn = assistant([
      { kind: 'note', text: 'Partway through the list.' },
      tool('1', 'scroll'),
      { kind: 'note', text: 'Three of five so far.' },
    ]);
    expect(answerFrom(turn)).toBe('Partway through the list.\n\nThree of five so far.');
  });

  it('prefers the finish summary over narration when there is one', () => {
    const turn = assistant([{ kind: 'note', text: 'Looking…' }], 'The cheapest is 499.');
    expect(answerFrom(turn)).toBe('The cheapest is 499.');
  });

  it('is empty when the run said nothing at all', () => {
    expect(answerFrom(assistant([]))).toBe('');
  });
});

describe('what the agent is looking at', () => {
  it('sits in the timeline alongside the narration and the tools', () => {
    const turn = assistant([
      { kind: 'note', text: 'Opening the orders page.' },
      tool('1', 'read_page'),
      { kind: 'view', dataUrl: 'data:image/jpeg;base64,AAA' },
    ]);
    expect(render(turn)).toEqual(['Opening the orders page.', '[tool read_page]', '[view]']);
  });

  it('is never part of the answer text', () => {
    // The picture is for the user. Sending one to the model would put a few
    // hundred kilobytes in the context for every remaining turn of the run.
    const turn = assistant(
      [{ kind: 'view', dataUrl: 'data:image/jpeg;base64,AAA' }],
      'The cushions are 24 x 24 inches.',
    );
    expect(answerFrom(turn)).toBe('The cushions are 24 x 24 inches.');
    expect(answerFrom(turn)).not.toContain('base64');
  });

  it('contributes nothing when a run ends without an answer', () => {
    const turn = assistant([{ kind: 'view', dataUrl: 'data:image/jpeg;base64,AAA' }]);
    expect(answerFrom(turn)).toBe('');
  });
});
