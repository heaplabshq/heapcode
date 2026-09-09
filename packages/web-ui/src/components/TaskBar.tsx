import { useState } from 'react';
import type { TodoItem } from '@heapcode/core';

export interface TaskBarProps {
  todos: TodoItem[];
}

/**
 * The agent's task list, pinned above the transcript instead of scrolling away
 * inside it.
 *
 * The list answers one question — what is left — and it answers it about the
 * run happening *now*. Drawn as an ordinary transcript card it went out of
 * view the moment the run produced two more tool chips, which is exactly when
 * it starts being worth reading. So it moves out of the scroller and sits with
 * the banners, above `.messages`: a flex row in normal flow, which is why it
 * cannot overlap the transcript, the composer, or the workspace panel the way
 * a floating overlay would.
 *
 * Collapsed to one line by default. A pinned region earns its space by being
 * small: "Tasks 3/7 · wiring the history window" is the whole answer most of
 * the time, and the full list is one click away for the times it is not. The
 * card stays in the transcript for every *earlier* run, so the history of what
 * each turn set out to do is not lost — only the live one is lifted out
 * (MessageList skips it to avoid drawing the same list twice).
 */
export function TaskBar({ todos }: TaskBarProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  // What the run is on. Falls back to the next unstarted item, because a list
  // between steps has nothing in progress and "Tasks 3/7" alone reads as
  // stalled.
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status !== 'completed');

  return (
    <div className="taskbar">
      <button
        type="button"
        className="taskbar-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="taskbar-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="taskbar-label">Tasks</span>
        <span className="taskbar-count">
          {done}/{todos.length}
        </span>
        {!open && current && <span className="taskbar-current">{current.content}</span>}
      </button>
      {open && (
        <ul className="tasks-list taskbar-list">
          {todos.map((t, i) => (
            // `key` by index, not content: the list is replaced whole, so an
            // item's identity is its position, not what it says.
            <li key={i} className={`task task-${t.status}`}>
              <span className="task-mark" aria-hidden>
                {t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▸' : '·'}
              </span>
              <span className="task-text">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
