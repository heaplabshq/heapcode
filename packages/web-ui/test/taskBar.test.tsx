// @vitest-environment jsdom
/**
 * The pinned task list.
 *
 * It exists because the list scrolled out of view exactly when it started
 * being worth reading: two tool chips into a run, the card the model had just
 * written was already above the fold. So what these check is the pinned
 * behaviour, not the list's contents — that the collapsed line answers "what
 * is left" on its own, and that nothing is drawn when there is nothing to say.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TodoItem } from '@heapcode/core';
import { TaskBar } from '../src/components/TaskBar.js';

afterEach(cleanup);

const TODOS: TodoItem[] = [
  { content: 'read the history window', status: 'completed' },
  { content: 'wire the context budget', status: 'in_progress' },
  { content: 'update the extension', status: 'pending' },
];

describe('pinned task bar', () => {
  it('shows the whole list at once, with how far along the run is', () => {
    render(<TaskBar todos={TODOS} />);
    expect(screen.getByText('1/3')).toBeTruthy();
    for (const t of TODOS) expect(screen.getByText(t.content)).toBeTruthy();
    // Each state is said, not only drawn.
    expect(screen.getByRole('img', { name: 'Done' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'In progress' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Not started' })).toBeTruthy();
  });

  it('folds to one line saying what it is on, and opens again', () => {
    render(<TaskBar todos={TODOS} />);
    const head = screen.getByRole('button');
    expect(head.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('wire the context budget')).toBeTruthy();
    expect(screen.queryByText('update the extension')).toBeNull();

    fireEvent.click(head);
    expect(screen.getByText('update the extension')).toBeTruthy();
  });

  it('falls back to the next unstarted task between steps', () => {
    // A list the model has just written has nothing in progress yet, and
    // "Tasks 0/2" on its own reads as stalled.
    render(
      <TaskBar
        todos={[
          { content: 'first thing', status: 'pending' },
          { content: 'second thing', status: 'pending' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('first thing')).toBeTruthy();
    expect(screen.queryByText('second thing')).toBeNull();
  });

  it('wraps a task in the element its finished styling needs', () => {
    // `.task-completed .task-text` is what strikes a done item through. The
    // transcript card rendered the text bare for a while, so the rule had
    // nothing to match and finished tasks never looked finished.
    render(<TaskBar todos={TODOS} />);
    const done = screen.getByText('read the history window');
    expect(done.className).toBe('task-text');
    expect(done.closest('li')?.className).toContain('task-completed');
  });

  it('draws nothing at all when the run has no list', () => {
    const { container } = render(<TaskBar todos={[]} />);
    // Not an empty bar taking up a strip of the window: no list, no region.
    expect(container.firstChild).toBeNull();
  });
});
