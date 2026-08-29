// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RunSteps } from '../src/sidepanel/components/RunSteps.js';
import type { Step } from '../src/sidepanel/useChat.js';

/**
 * The run, behind one line.
 *
 * The rule has two halves and they pull in opposite directions: while a run is
 * going the user wants to watch it, and once it has finished they want the
 * answer, not thirty steps of how it got there. So the fold opens itself and
 * then closes itself -- except once the user has touched it, after which it is
 * theirs. That last part is the one worth pinning down: a fold that reverts to
 * its automatic behaviour on the next render is the panel arguing with the
 * person using it.
 */

function tool(id: string, name: string): Step {
  return { kind: 'tool', tool: { id, name, args: {}, result: 'ok' } };
}

afterEach(cleanup);

describe('a run in progress', () => {
  it('is open, so the user can watch it', () => {
    render(<RunSteps steps={[tool('1', 'read_page')]} streaming />);
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
  });

  /**
   * The panel and the page say the same thing about the same moment: both take
   * the present-tense name from `shared/toolLabels`.
   */
  it('names the step in flight rather than counting them', () => {
    render(<RunSteps steps={[tool('1', 'read_page'), tool('2', 'click')]} streaming />);
    expect(screen.getByText('Clicking')).toBeTruthy();
  });
});

describe('a run that has finished', () => {
  it('is closed, so the answer is what is on screen', () => {
    render(<RunSteps steps={[tool('1', 'read_page')]} />);
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
  });

  it('says what it did and how much of it', () => {
    render(<RunSteps steps={[tool('1', 'read_page'), tool('2', 'click')]} />);
    expect(screen.getByText('Worked on the page · 2 actions')).toBeTruthy();
  });

  it('counts one action as one', () => {
    render(<RunSteps steps={[tool('1', 'read_page')]} />);
    expect(screen.getByText('Worked on the page · 1 action')).toBeTruthy();
  });

  /**
   * A turn where the model only thought and then answered. Reporting that as
   * "0 actions" would be true and useless.
   */
  it('does not claim actions it did not take', () => {
    render(<RunSteps steps={[{ kind: 'thinking', text: 'hmm' }]} />);
    expect(screen.getByText('Thought about it')).toBeTruthy();
  });

  it('is nothing at all when there were no steps', () => {
    const { container } = render(<RunSteps steps={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('once the user has touched it', () => {
  it('stays open on a finished run', () => {
    render(<RunSteps steps={[tool('1', 'read_page')]} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
  });

  /**
   * The half that a `useEffect` on `streaming` would get wrong: closing a run
   * you are watching has to survive the run continuing to stream.
   */
  it('stays closed while a run is still streaming', () => {
    const { rerender } = render(<RunSteps steps={[tool('1', 'read_page')]} streaming />);
    fireEvent.click(screen.getByRole('button', { expanded: true }));

    rerender(<RunSteps steps={[tool('1', 'read_page'), tool('2', 'click')]} streaming />);

    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
  });
});

describe('what is behind the fold', () => {
  it('holds the steps, and only once it is opened', () => {
    render(<RunSteps steps={[tool('1', 'read_page'), { kind: 'note', text: 'Looking now.' }]} />);
    expect(screen.queryByText('Looking now.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('Looking now.')).toBeTruthy();
    expect(screen.getByText('Read the page')).toBeTruthy();
  });

  /**
   * A screenshot is a step like any other. Loose in the transcript it made a
   * run mostly pictures of a page the user already has open in front of them.
   */
  it('keeps a screenshot collapsed until it is asked for', () => {
    render(<RunSteps steps={[{ kind: 'view', dataUrl: 'data:image/png;base64,AAA' }]} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByText('Took a picture'));
    expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAA');
  });
});
