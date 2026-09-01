import type { ToolDefinition } from './tools.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * The upper bound on one list — a list longer than this is not a plan, it is
 * the investigation loop wearing a todo costume.
 */
export const MAX_TODOS = 20;

/**
 * The agent's own task list.
 *
 * Claude Code, Copilot, and Cursor all give their agent a todo tool, and for
 * the same reason: a multi-step task drifts because nothing in the transcript
 * *counts*. A list the model writes to and reads back gives the run a place to
 * be honest about what is left — and gives the finish gate something to check
 * against (see TODO_NUDGE in loop.ts), so "done" has to survive the model's
 * own list, not just its phrasing.
 *
 * Like TodoWrite in Claude Code, the call carries the FULL list every time
 * rather than a delta: no ids to manage, no ordering to reconcile, and a
 * malformed update can only lose what the model failed to restate — which it
 * is looking at when it writes the call.
 */
export const TODO_TOOL: ToolDefinition = {
  name: 'todo_write',
  description:
    'Track the steps of a multi-step task. Send the FULL list every call — it replaces the previous ' +
    'one. Use it for work with three or more steps; for shorter work it is overhead, skip it. Mark a ' +
    'step in_progress when you start it and completed the moment it is; strike an item that turned ' +
    'out unnecessary rather than leaving it pending. You are expected not to finish while the list ' +
    'still has pending items — the run will ask you about them.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What the step is, one line.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'pending = not started, in_progress = underway, completed = done.',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  permission: 'read',
};

export interface ParsedTodos {
  todos: TodoItem[];
  /** Set when the input was malformed enough to reject; the list is unchanged. */
  error?: string;
}

/**
 * Tolerant parsing of a todo_write call.
 *
 * Local models mis-shape tool arguments in every way this accommodates: a bare
 * array instead of `{todos: [...]}`, a status of "done" or "in-progress",
 * entries that are strings rather than objects. Rejecting the call over any of
 * that turns a bookkeeping slip into a dead turn; repairing it keeps the run
 * moving and the finish gate fed with something truthful.
 */
export function parseTodos(args: Record<string, unknown>): ParsedTodos {
  const raw = Array.isArray(args.todos) ? args.todos : Array.isArray(args) ? args : undefined;
  if (!raw) {
    return { todos: [], error: 'Missing "todos" array. Call todo_write with {"todos": [{"content": "...", "status": "..."}]}.' };
  }
  if (raw.length > MAX_TODOS) {
    return { todos: [], error: `A todo list longer than ${MAX_TODOS} items is a plan nobody can follow. Send the ${MAX_TODOS} that matter.` };
  }
  const todos: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const content = entry.trim();
      if (content) todos.push({ content, status: 'pending' });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const content = String(record.content ?? record.task ?? '').trim();
    if (!content) continue;
    todos.push({ content, status: normalizeStatus(record.status) });
  }
  if (todos.length === 0) {
    return { todos: [], error: 'No usable items in "todos". Each needs a non-empty "content".' };
  }
  return { todos };
}

function normalizeStatus(value: unknown): TodoStatus {
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (STATUSES.includes(text as TodoStatus)) return text as TodoStatus;
  if (/^(done|complete|completed|finished|ok|yes)$/i.test(text)) return 'completed';
  if (/(progress|current|working|active|started)/i.test(text)) return 'in_progress';
  return 'pending';
}

/** The list as it should be shown back to the model in a tool result. */
export function renderTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'Todo list is empty.';
  const lines = todos.map((t, i) => {
    const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
    return `${i + 1}. [${mark}] ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`;
  });
  const remaining = todos.filter((t) => t.status !== 'completed').length;
  return `Todo list (${todos.length - remaining} of ${todos.length} done):\n${lines.join('\n')}`;
}