/**
 * Tasks worth doing more than once, and a record of the ones already done.
 *
 * Two stores, deliberately separate. A saved task is something the user chose
 * to keep; history is everything, kept automatically. Mixing them turns the
 * saved list into a graveyard of one-off questions within a day.
 *
 * Both live in `chrome.storage.local` and go nowhere. History in particular is a
 * record of the user's own browsing, which makes it more sensitive than the
 * pages it describes, not less — the same reasoning as the audit log.
 */

/**
 * How a task was carried out, the last time it worked.
 *
 * Written after the fact from a run the user chose to keep, and written in
 * terms of meaning rather than coordinates: "find the search box", never
 * "click [12]". A handle belongs to one snapshot of one page and is dead
 * seconds later, so a saved plan that named handles would be a plan that never
 * worked twice -- which is exactly why replaying recorded clicks is not what
 * this is.
 *
 * It is guidance for the next run, not a script it executes. The agent still
 * looks at the page and still checks each step against what is actually there;
 * what it saves is the deciding, which is where a repeat run spends its turns.
 */
export interface Workflow {
  /** What it did, in order, one line each. */
  steps: string[];
  /**
   * What changes between runs, named for a person.
   *
   * The hard part of learning a workflow automatically is guessing which parts
   * were incidental -- and guessing wrong produces a workflow that quietly
   * always searches for "mac mini". Here it is not guessed: the user says what
   * varies when they invoke it, and this is only the label telling them what to
   * type.
   */
  varies?: string;
  learnedAt: number;
}

export interface SavedTask {
  id: string;
  /** What the user calls it. Defaults to the prompt, trimmed. */
  name: string;
  prompt: string;
  createdAt: number;
  lastRunAt?: number;
  /** Where it was saved from, as a hint about where it is meant to be run. */
  host?: string;
  /** Present once a successful run has been kept as a workflow. */
  workflow?: Workflow;
  /** What it is invoked as: the name, lowercased and hyphenated. */
  slug?: string;
}

export interface RunRecord {
  id: string;
  task: string;
  host?: string;
  at: number;
  /** How it ended, in core's own vocabulary. */
  outcome: string;
  /** The answer, truncated — enough to recognise the run, not to replace it. */
  summary?: string;
}

const TASKS_KEY = 'heapbrowse.tasks';
const HISTORY_KEY = 'heapbrowse.history';
const MAX_TASKS = 50;
const MAX_HISTORY = 100;

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadTasks(): Promise<SavedTask[]> {
  const stored = await chrome.storage.local.get(TASKS_KEY);
  const tasks = stored[TASKS_KEY];
  return Array.isArray(tasks) ? (tasks as SavedTask[]) : [];
}

export async function saveTask(prompt: string, name?: string, host?: string): Promise<SavedTask[]> {
  const trimmed = prompt.trim();
  if (!trimmed) return loadTasks();

  const tasks = await loadTasks();
  // Saving the same thing twice is a mis-click, not a second task. The existing
  // one is kept, so a name the user gave it earlier is not overwritten.
  if (tasks.some((task) => task.prompt.trim() === trimmed)) return tasks;

  const next: SavedTask[] = [
    {
      id: newId(),
      name: (name?.trim() || trimmed).slice(0, 80),
      prompt: trimmed,
      createdAt: Date.now(),
      host,
    },
    ...tasks,
  ].slice(0, MAX_TASKS);

  await chrome.storage.local.set({ [TASKS_KEY]: next });
  return next;
}

export async function renameTask(id: string, name: string): Promise<SavedTask[]> {
  const tasks = await loadTasks();
  const next = tasks.map((task) => (task.id === id ? { ...task, name: name.trim().slice(0, 80) } : task));
  await chrome.storage.local.set({ [TASKS_KEY]: next });
  return next;
}

export async function deleteTask(id: string): Promise<SavedTask[]> {
  const tasks = (await loadTasks()).filter((task) => task.id !== id);
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
  return tasks;
}

export async function markTaskRun(id: string): Promise<void> {
  const tasks = await loadTasks();
  const next = tasks.map((task) => (task.id === id ? { ...task, lastRunAt: Date.now() } : task));
  await chrome.storage.local.set({ [TASKS_KEY]: next });
}

export async function loadHistory(): Promise<RunRecord[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = stored[HISTORY_KEY];
  return Array.isArray(history) ? (history as RunRecord[]) : [];
}

export async function recordRun(record: Omit<RunRecord, 'id'>): Promise<void> {
  const history = await loadHistory();
  const next = [
    { ...record, id: newId(), summary: record.summary?.slice(0, 300) },
    ...history,
  ].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
}

/**
 * The name a workflow is invoked by.
 *
 * Lowercase, hyphenated, no punctuation -- because it is typed after a slash
 * and anything else makes it awkward to type and ambiguous to match. Truncated
 * hard: a workflow you cannot type in full is one nobody invokes.
 */
export function slugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'workflow'
  );
}

/** Keep a run as a workflow, under a name that is unique among them. */
export async function saveWorkflow(
  entry: { name: string; prompt: string; host?: string; workflow: Workflow },
): Promise<SavedTask[]> {
  const tasks = await loadTasks();
  const taken = new Set(tasks.map((task) => task.slug).filter(Boolean) as string[]);

  let slug = slugFor(entry.name);
  if (taken.has(slug)) {
    let n = 2;
    while (taken.has(`${slug}-${n}`)) n += 1;
    slug = `${slug}-${n}`;
  }

  const next: SavedTask[] = [
    {
      id: newId(),
      name: entry.name.slice(0, 80),
      prompt: entry.prompt.trim(),
      createdAt: Date.now(),
      host: entry.host,
      workflow: entry.workflow,
      slug,
    },
    ...tasks,
  ].slice(0, MAX_TASKS);

  await chrome.storage.local.set({ [TASKS_KEY]: next });
  return next;
}

/** The workflows, which are the saved tasks that have one. */
export async function loadWorkflows(): Promise<SavedTask[]> {
  return (await loadTasks()).filter((task) => task.workflow && task.slug);
}
