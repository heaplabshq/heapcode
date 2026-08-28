import { useEffect, useState } from 'react';
import {
  clearHistory,
  deleteTask,
  loadHistory,
  loadTasks,
  markTaskRun,
  renameTask,
  saveTask,
  type RunRecord,
  type SavedTask,
} from '../../shared/tasks.js';
import { Icon } from './Icon.js';

/**
 * Tasks worth repeating, and what has already been run.
 *
 * The two halves of one question — "do that again" — reached from different
 * directions. A saved task is something the user decided to keep; history is
 * everything, and is mostly useful for finding the wording of something that
 * worked last week.
 *
 * Re-running means sending the same request again, not replaying the same
 * clicks. A recorded sequence of actions is worthless a week later on a page
 * that has been redesigned, and worse than worthless on one that has not
 * changed layout but has changed what is in it — the third result is a
 * different product now, and clicking the third result again is precisely the
 * wrong thing. The prompt is the durable part; the actions are not.
 */
export function Tasks({
  currentDraft,
  host,
  onRun,
  onClose,
}: {
  /** Whatever is in the composer, offered as the thing to save. */
  currentDraft: string;
  host?: string;
  onRun: (prompt: string) => void;
  /** Running something closes the pane; the title bar's own close is the sheet's. */
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<SavedTask[]>([]);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [editing, setEditing] = useState<string | undefined>();
  const [name, setName] = useState('');

  useEffect(() => {
    void loadTasks().then(setTasks);
    void loadHistory().then(setHistory);
  }, []);

  const run = async (task: SavedTask) => {
    await markTaskRun(task.id);
    onRun(task.prompt);
    onClose();
  };

  return (
    <div className="pane tasks-pane">
      <div className="pane-head">
        <h3 className="section-title">Saved tasks</h3>
        {currentDraft.trim().length > 0 && (
          <button
            type="button"
            className="ghost"
            onClick={async () => setTasks(await saveTask(currentDraft, undefined, host))}
          >
            Save what you typed
          </button>
        )}
      </div>

      {tasks.length === 0 && (
        <div className="tasks-empty">
          <Icon name="tasks" size={18} className="tasks-empty-icon" />
          <p className="muted">
            Nothing saved yet. Type a request in the box below and save it here to run it again later
            with one click.
          </p>
        </div>
      )}

      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id} className="task-card">
            {editing === task.id ? (
              <input
                className="task-rename"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onBlur={async () => {
                  setTasks(await renameTask(task.id, name));
                  setEditing(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            ) : (
              <button type="button" className="task-run" onClick={() => void run(task)} title={task.prompt}>
                <span className="task-run-name">{task.name}</span>
                {(task.host || task.lastRunAt) && (
                  <span className="task-meta">
                    {task.host && <span className="task-host">{task.host}</span>}
                    {task.lastRunAt && (
                      <span className="task-last">last run {relative(task.lastRunAt)}</span>
                    )}
                  </span>
                )}
              </button>
            )}
            <div className="task-actions">
              <button
                type="button"
                className="icon-button task-action"
                onClick={() => {
                  setEditing(task.id);
                  setName(task.name);
                }}
                aria-label={`Rename ${task.name}`}
                title="Rename"
              >
                <Icon name="sparkle" />
              </button>
              <button
                type="button"
                className="icon-button task-action"
                onClick={async () => setTasks(await deleteTask(task.id))}
                aria-label={`Delete ${task.name}`}
                title="Delete"
              >
                <Icon name="close" />
              </button>
            </div>
          </li>
        ))}
      </ul>

      <hr className="rule" />

      <div className="pane-head">
        <h3 className="section-title">Earlier runs</h3>
        {history.length > 0 && (
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              await clearHistory();
              setHistory([]);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {history.length === 0 && (
        <div className="tasks-empty">
          <Icon name="log" size={18} className="tasks-empty-icon" />
          <p className="muted">No runs recorded yet. Anything you ask will show up here so you can
            find it again later.</p>
        </div>
      )}

      <ul className="history-list">
        {history.map((record) => {
          const done = record.outcome === 'done';
          return (
            <li
              key={record.id}
              className={`history-entry${done ? ' is-done' : ' is-failed'}`}
            >
              <span className="history-node" aria-hidden="true" />
              <div className="history-body">
                <div className="history-line">
                  <span className="history-when" title={new Date(record.at).toLocaleString()}>
                    {relative(record.at)}
                  </span>
                  {record.host && <span className="history-host">{record.host}</span>}
                  {!done && <span className="history-outcome">{record.outcome}</span>}
                </div>
                <p className="history-task">{record.task}</p>
                {record.summary && <p className="muted history-summary">{record.summary}</p>}
                <div className="row history-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      onRun(record.task);
                      onClose();
                    }}
                  >
                    Run again
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={async () =>
                      setTasks(await saveTask(record.task, undefined, record.host))
                    }
                  >
                    Save
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "2h ago", "just now" — enough to tell recent from old without a wall of dates. */
function relative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Saved tasks as one-click chips, on an empty panel.
 *
 * The saved list is only worth having if it is in front of the user at the
 * moment they are deciding what to do, which is a blank conversation — not
 * behind a button they would have to remember to press.
 */
export function SavedTaskChips({ onRun }: { onRun: (prompt: string) => void }) {
  const [tasks, setTasks] = useState<SavedTask[]>([]);

  useEffect(() => {
    void loadTasks().then(setTasks);
  }, []);

  if (tasks.length === 0) return null;

  return (
    <div className="empty-group left">
      <span className="empty-label">Saved</span>
      <div className="pills left">
        {tasks.slice(0, 6).map((task) => (
          <button
            key={task.id}
            type="button"
            className="pill"
            title={task.prompt}
            onClick={async () => {
              await markTaskRun(task.id);
              onRun(task.prompt);
            }}
          >
            {task.name}
          </button>
        ))}
      </div>
    </div>
  );
}