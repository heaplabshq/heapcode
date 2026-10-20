import { useState } from 'react';
import type { TodoItem } from '@heapcode/core';

export interface TaskBarProps {
  todos: TodoItem[];
}

/**
 * The agent's task list during a run, as a card just above the input box.
 *
 * Above the input rather than above the transcript: that is where the eye is
 * while a run is going — on the newest output and the box it will answer in —
 * and it is where the Claude app keeps its own plan. It sits in normal flow
 * between the transcript and the composer, so it cannot overlap either, and
 * it is only here while the run is: when the run ends the card drops back
 * into the transcript, where the record of that turn belongs (MessageList
 * skips the live one meanwhile, so it is never drawn twice).
 *
 * Open by default, because the list is the point — what is done, what is
 * happening, what is left, at a glance. The header folds it to one line for
 * anyone who wants the room; the list scrolls past a cap so twenty tasks
 * cannot push the conversation away.
 */
export function TaskBar({ todos }: TaskBarProps): JSX.Element | null {
  const [open, setOpen] = useState(true);
  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  // What the run is on. Falls back to the next unstarted item, because a list
  // between steps has nothing in progress and "Tasks 3/7" alone reads as
  // stalled.
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status !== 'completed');

  return (
    <div className="taskbar">
      <button type="button" className="taskbar-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="taskbar-label">Tasks</span>
        <span className="taskbar-count">
          {done}/{todos.length}
        </span>
        {!open && current && <span className="taskbar-current">{current.content}</span>}
        <span className={open ? 'taskbar-caret taskbar-caret-open' : 'taskbar-caret'} aria-hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <ul className="taskbar-list">
          {todos.map((t, i) => (
            // `key` by index, not content: the list is replaced whole, so an
            // item's identity is its position, not what it says.
            <li key={i} className={`task task-${t.status}`}>
              <span className="taskbar-mark" aria-label={STATUS[t.status]} role="img" />
              <span className="task-text">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS: Record<TodoItem['status'], string> = {
  completed: 'Done',
  in_progress: 'In progress',
  pending: 'Not started',
};
