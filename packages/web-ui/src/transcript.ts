import type { AgentEvent, TodoItem } from '@heapcode/core';
import type { UiMessage } from '@heapcode/web-host/protocol';

/**
 * The transcript the chat pane renders.
 *
 * `AgentEvent` is a *stream*; this is the accumulated shape. Keeping the
 * reduction in one pure function (rather than inside a component) is what lets
 * replay-after-reconnect work: the host hands back the buffered events and the
 * same reducer rebuilds exactly the view the previous tab had (§5.4).
 */

export interface TextItem {
  kind: 'text';
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Still arriving — this one gets the "still writing" marker. */
  streaming?: boolean;
  /**
   * Attached images, as data URLs, on a user turn.
   *
   * Live-only: the host records that images were attached but not the bytes
   * (`persistTurn`), so these are gone after a reload. That is deliberate — a
   * screenshot is megabytes of base64, and conversations.json is read whole.
   */
  images?: string[];
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** The delegate_task call this ran under, if any — drives nesting. */
  parent?: string;
  done: boolean;
}

export interface ReasoningItem {
  kind: 'reasoning';
  id: string;
  text: string;
  /** Still arriving — the block auto-expands so you can watch it think. */
  streaming?: boolean;
}

export interface PlanItem {
  kind: 'plan';
  id: string;
  text: string;
}

/**
 * Something the HOST has to say about the run — that it was cut off at the
 * step limit, interrupted, or ended without ever really acting.
 *
 * Its own kind rather than an assistant note: these read as the model's own
 * words when drawn in a reply bubble, and the whole reason this exists is that
 * a cut-off run's summary already looks like a finished one.
 */
export interface NoticeItem {
  kind: 'notice';
  id: string;
  text: string;
  /** Draws attention (the run did not do what it looks like it did). */
  warn?: boolean;
}

export interface TaskListItem {
  kind: 'tasks';
  id: string;
  todos: TodoItem[];
}

export type Item = TextItem | ToolItem | ReasoningItem | PlanItem | NoticeItem | TaskListItem;

export interface Transcript {
  items: Item[];
  usedTokens?: number;
  windowTokens?: number;
  /** Set when the loop compacted mid-run, so the UI can say so once. */
  compacted?: { before: number; after: number };
  /**
   * Characters of tool-call *arguments* the model has written so far, in whole
   * thousands, while it is still writing them.
   *
   * This belongs to the transcript, not to a tool item, because at the moment
   * these arrive there is no tool item yet: `tool_stream` counts the argument
   * fragments streaming out of the provider (openaiCompatible.ts:449), and the
   * `tool_call` event only exists once that JSON is complete. Hanging it off
   * "the last unfinished tool" — which is what this used to do — attributed the
   * count to the *previous* call and labelled it as that call's output.
   *
   * Quantised to 1k: the event fires per chunk, and a byte-exact counter would
   * re-render the transcript on every one of them.
   */
  writingCallK?: number;
}

export const emptyTranscript: Transcript = { items: [] };

/**
 * History → transcript, rebuilding the same items the live reducer produces.
 *
 * A reloaded conversation has to look like the one you left: tool chips, plans
 * and thinking blocks included. Chips come back with whatever output was
 * persisted — clipped, since the full result was never kept — and their
 * arguments drive the same one-liner `ToolChip` draws during a run.
 *
 * `prefix` keeps ids unique when this is called twice to build one view: once
 * for the stored conversation and once for the turn still in flight
 * (`UiHelloResult.pending`). Without it both halves numbered from zero and
 * React reconciled the pending turn onto the history above it.
 */
export function fromMessages(messages: UiMessage[], prefix = 'h'): Transcript {
  return {
    items: messages.map((m, i): Item => {
      const tool = m.ui?.tool;
      if (tool) {
        return {
          kind: 'tool',
          id: tool.id ?? `${prefix}t${i}`,
          name: tool.name,
          args: tool.args ?? {},
          result: tool.result,
          isError: tool.isError,
          // Only `pending` ever sends `false`; stored history is always done.
          done: tool.done ?? true,
        };
      }
      if (m.ui?.plan) return { kind: 'plan', id: `${prefix}p${i}`, text: m.content };
      if (m.ui?.todos) return { kind: 'tasks', id: `${prefix}d${i}`, todos: m.ui.todos };
      if (m.ui?.reasoning)
        return { kind: 'reasoning', id: `${prefix}r${i}`, text: m.content, streaming: m.ui.streaming };
      return { kind: 'text', id: `${prefix}${i}`, role: m.role, text: m.content, streaming: m.ui?.streaming };
    }),
  };
}

/** Concatenates two rebuilt halves — stored history, then the turn in flight. */
export function concat(a: Transcript, b: Transcript): Transcript {
  return { ...a, ...b, items: [...a.items, ...b.items] };
}

/**
 * Appends host-produced prose (a command's output: `/memory`, `/skills`,
 * `/search`) as an assistant message.
 *
 * Local to the view on purpose — it is NOT persisted to the conversation and
 * never becomes context for the next turn. Command output is something the
 * user asked to see, not something the model said.
 */
export function withAssistantNote(t: Transcript, text: string): Transcript {
  return {
    ...t,
    items: [...t.items, { kind: 'text', id: `n${t.items.length}`, role: 'assistant', text }],
  };
}

/** Appends a host notice about the run that just ended — see NoticeItem. */
export function withNotice(t: Transcript, text: string, warn = false): Transcript {
  return {
    ...t,
    items: [...t.items, { kind: 'notice', id: `x${t.items.length}`, text, warn }],
  };
}

/** Appends a user turn immediately, so the UI never feels like it dropped input. */
export function withUserMessage(t: Transcript, text: string, images?: string[]): Transcript {
  return {
    ...t,
    items: [...t.items, { kind: 'text', id: `u${t.items.length}`, role: 'user', text, images }],
  };
}

/**
 * Closes a message that is still marked as streaming.
 *
 * `text_end` is the normal way that happens, but the loop only emits it when
 * it actually streamed text deltas (agent/loop.ts:362) — and even then, a
 * model that narrates and then calls a tool moves on without ever ending the
 * message. So anything that starts a *new* kind of entry closes the prose
 * before it: whatever the model is doing now, it is no longer typing that.
 *
 * Left open, the message kept its "still arriving" marker for the entire
 * duration of the tool call, which is exactly where a caret blinking beside
 * finished text came from.
 */
function closeOpenText(t: Transcript): Transcript {
  const last = t.items[t.items.length - 1];
  if (last?.kind !== 'text' || !last.streaming) return t;
  return { ...t, items: [...t.items.slice(0, -1), { ...last, streaming: false }] };
}

/**
 * Fold one event into the transcript.
 *
 * Returns the same object when nothing changed, so React can skip re-rendering
 * a long transcript on events it does not draw (`tool_stream`, for one, which
 * fires per chunk of tool output).
 */
export function reduce(t: Transcript, event: AgentEvent, seq: number): Transcript {
  switch (event.type) {
    case 'text_delta': {
      const last = t.items[t.items.length - 1];
      if (last?.kind === 'text' && last.role === 'assistant' && last.streaming) {
        const updated = { ...last, text: last.text + event.text };
        return { ...t, items: [...t.items.slice(0, -1), updated] };
      }
      return {
        ...t,
        items: [...t.items, { kind: 'text', id: `a${seq}`, role: 'assistant', text: event.text, streaming: true }],
      };
    }

    case 'text_end': {
      const last = t.items[t.items.length - 1];
      if (last?.kind !== 'text' || !last.streaming) return t;
      return { ...t, items: [...t.items.slice(0, -1), { ...last, streaming: false }] };
    }

    case 'text': {
      // The non-streamed path: a complete message at once. If a streamed
      // message is open, this replaces it rather than duplicating the text.
      const last = t.items[t.items.length - 1];
      if (last?.kind === 'text' && last.role === 'assistant' && last.streaming) {
        return { ...t, items: [...t.items.slice(0, -1), { ...last, text: event.text, streaming: false }] };
      }
      return { ...t, items: [...t.items, { kind: 'text', id: `a${seq}`, role: 'assistant', text: event.text }] };
    }

    case 'plan': {
      const base = closeOpenText(t);
      return { ...base, items: [...base.items, { kind: 'plan', id: `p${seq}`, text: event.text }] };
    }

    case 'todo_update': {
      // One card per run, updated in place: the list answers "what is left",
      // and a stack of stale copies would answer it five times, all wrong but
      // the last. Scoped to the current turn — the scan stops at the last
      // user message — so a new run gets its own card instead of rewriting
      // the previous run's, which is what a reload shows (fromMessages builds
      // one item per stored turn).
      const base = closeOpenText(t);
      let existing = -1;
      for (let i = base.items.length - 1; i >= 0; i--) {
        const item = base.items[i]!;
        if (item.kind === 'text' && item.role === 'user') break;
        if (item.kind === 'tasks') {
          existing = i;
          break;
        }
      }
      if (existing >= 0) {
        const items = [...base.items];
        const current = items[existing] as TaskListItem;
        items[existing] = { ...current, todos: event.todos };
        return { ...base, items };
      }
      return { ...base, items: [...base.items, { kind: 'tasks', id: `d${seq}`, todos: event.todos }] };
    }

    case 'reasoning_delta': {
      const last = t.items[t.items.length - 1];
      if (last?.kind === 'reasoning' && last.streaming) {
        return { ...t, items: [...t.items.slice(0, -1), { ...last, text: last.text + event.text }] };
      }
      const base = closeOpenText(t);
      return {
        ...base,
        items: [...base.items, { kind: 'reasoning', id: `r${seq}`, text: event.text, streaming: true }],
      };
    }

    case 'reasoning_end': {
      const last = t.items[t.items.length - 1];
      if (last?.kind !== 'reasoning' || !last.streaming) return t;
      // Collapses once finished: useful to watch live, noise to keep open.
      return { ...t, items: [...t.items.slice(0, -1), { ...last, streaming: false }] };
    }

    case 'tool_call': {
      const base = closeOpenText(t);
      return {
        ...base,
        // The call is written; the counter that was tracking it writing has
        // nothing left to describe.
        writingCallK: undefined,
        items: [
          ...base.items,
          {
            kind: 'tool',
            id: event.id,
            name: event.name,
            args: event.args,
            parent: event.parent,
            done: false,
          },
        ],
      };
    }

    case 'tool_stream': {
      // The model is writing a tool call's arguments. See
      // `Transcript.writingCallK` for why this is transcript state and not a
      // property of any tool item.
      const k = Math.floor(event.chars / 1000);
      // `?? 0`, so the first sub-1k chunk doesn't count as a change from
      // "unset" to zero and re-render the transcript to display nothing.
      if ((t.writingCallK ?? 0) === k) return t;
      return { ...t, writingCallK: k };
    }

    case 'tool_result': {
      const index = t.items.findIndex((i) => i.kind === 'tool' && i.id === event.id);
      if (index === -1) return t;
      const tool = t.items[index] as ToolItem;
      const updated: ToolItem = { ...tool, result: event.content, isError: event.isError, done: true };
      const items = [...t.items];
      items[index] = updated;
      return { ...t, items };
    }

    case 'context_usage':
      return { ...t, usedTokens: event.usedTokens, windowTokens: event.windowTokens };

    case 'compaction':
      return { ...t, compacted: { before: event.beforeTokens, after: event.afterTokens } };

    // tool_stream / memory_candidate: nothing to draw yet.
    default:
      return t;
  }
}

/**
 * Marks everything still in flight finished — used when a run ends or is
 * cancelled.
 *
 * Covers reasoning and unfinished tool calls, not just the trailing message. A
 * run cancelled mid-tool used to leave its chip spinning on `◌` forever, and a
 * run cancelled mid-thought left the thinking block pinned open, because both
 * are only ever closed by an event that a cancelled run never sends.
 */
export function settle(t: Transcript): Transcript {
  // A run cancelled while the model was mid-call leaves a counter describing
  // something that will never arrive.
  if (t.writingCallK) t = { ...t, writingCallK: undefined };
  let changed = false;
  const items = t.items.map((item): Item => {
    if ((item.kind === 'text' || item.kind === 'reasoning') && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    if (item.kind === 'tool' && !item.done) {
      changed = true;
      return { ...item, done: true };
    }
    return item;
  });
  return changed ? { ...t, items } : t;
}

/**
 * What the agent is doing right now, for the working indicator.
 *
 * Derived from the transcript rather than tracked separately: the transcript
 * already knows whether a tool is open or text is streaming, and a second
 * source of truth for "is it thinking or running something" would drift from
 * what the user can see on screen.
 */
export interface Activity {
  phase: 'thinking' | 'writing-call' | 'tool' | 'responding' | 'working';
  /** The running tool's name, when `phase` is 'tool'. */
  tool?: string;
  /** Arguments written so far, in whole thousands, when 'writing-call'. */
  writingCallK?: number;
}

export function activityOf(t: Transcript): Activity {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const item = t.items[i]!;
    // A call that has been issued but not returned outranks everything: the
    // tool is running now, whatever the model was doing a moment ago.
    if (item.kind === 'tool' && !item.done) return { phase: 'tool', tool: item.name };
    if (item.kind === 'reasoning' && item.streaming) return { phase: 'thinking' };
    if (item.kind === 'text' && item.streaming) return { phase: 'responding' };
    // Anything settled means the last thing on screen is finished and the
    // agent is between steps — waiting on the model. That gap is exactly the
    // stretch that used to show nothing at all.
    if (item.kind === 'tool' || item.kind === 'text' || item.kind === 'plan') break;
  }
  // Nothing on screen is moving, but arguments are still streaming: the model
  // is mid-way through writing a call that has no item yet.
  if (t.writingCallK) return { phase: 'writing-call', writingCallK: t.writingCallK };
  return { phase: 'working' };
}
