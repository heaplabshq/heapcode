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
    <div className="pane">
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
        <p className="muted">
          Nothing saved yet. Type a request in the box below and save it here to run it again later
          with one click.
        </p>
      )}

      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id}>
            {editing === task.id ? (
              <input
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
                {task.name}
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setEditing(task.id);
                setName(task.name);
              }}
              aria-label={`Rename ${task.name}`}
            >
              Rename
            </button>
            <button
              type="button"
              className="ghost"
              onClick={async () => setTasks(await deleteTask(task.id))}
              aria-label={`Delete ${task.name}`}
            >
              Delete
            </button>
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

      {history.length === 0 && <p className="muted">No runs recorded yet.</p>}

      <ul className="history-list">
        {history.map((record) => (
          <li key={record.id}>
            <div className="history-line">
              <span className="history-when">{new Date(record.at).toLocaleString()}</span>
              {record.host && <span className="history-host">{record.host}</span>}
              {record.outcome !== 'done' && <span className="history-outcome">{record.outcome}</span>}
            </div>
            <p className="history-task">{record.task}</p>
            {record.summary && <p className="muted history-summary">{record.summary}</p>}
            <div className="row">
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
                onClick={async () => setTasks(await saveTask(record.task, undefined, record.host))}
              >
                Save
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
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
    <div className="empty-group">
      <span className="empty-label">Saved</span>
      <div className="pills">
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
