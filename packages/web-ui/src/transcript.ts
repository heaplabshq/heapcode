import type { AgentEvent } from '@heapcode/core';
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
  /** Still streaming — the caret renders on this one. */
  streaming?: boolean;
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
  /**
   * Output bytes streamed so far, rounded down to the nearest 1k.
   *
   * Quantised on purpose. `tool_stream` fires per chunk — hundreds of times
   * during one `npm test` — and a byte-exact counter would re-render the whole
   * transcript on every one of them. A 1k step is still enough to see that a
   * long command is producing output rather than hanging, which is the only
   * question this answers.
   */
  streamedK?: number;
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

export type Item = TextItem | ToolItem | ReasoningItem | PlanItem;

export interface Transcript {
  items: Item[];
  usedTokens?: number;
  windowTokens?: number;
  /** Set when the loop compacted mid-run, so the UI can say so once. */
  compacted?: { before: number; after: number };
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

/** Appends a user turn immediately, so the UI never feels like it dropped input. */
export function withUserMessage(t: Transcript, text: string): Transcript {
  return { ...t, items: [...t.items, { kind: 'text', id: `u${t.items.length}`, role: 'user', text }] };
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

    case 'plan':
      return { ...t, items: [...t.items, { kind: 'plan', id: `p${seq}`, text: event.text }] };

    case 'reasoning_delta': {
      const last = t.items[t.items.length - 1];
      if (last?.kind === 'reasoning' && last.streaming) {
        return { ...t, items: [...t.items.slice(0, -1), { ...last, text: last.text + event.text }] };
      }
      return { ...t, items: [...t.items, { kind: 'reasoning', id: `r${seq}`, text: event.text, streaming: true }] };
    }

    case 'reasoning_end': {
      const last = t.items[t.items.length - 1];
      if (last?.kind !== 'reasoning' || !last.streaming) return t;
      // Collapses once finished: useful to watch live, noise to keep open.
      return { ...t, items: [...t.items.slice(0, -1), { ...last, streaming: false }] };
    }

    case 'tool_call':
      return {
        ...t,
        items: [
          ...t.items,
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

    case 'tool_stream': {
      // The event carries only a char count, no call id (server/protocol.ts),
      // so it belongs to whichever call is still open — there is at most one
      // producing output at a time. Quantised to 1k so a chatty command
      // doesn't re-render the transcript per chunk; see `ToolItem.streamedK`.
      const k = Math.floor(event.chars / 1000);
      let index = -1;
      for (let i = t.items.length - 1; i >= 0; i--) {
        const item = t.items[i]!;
        if (item.kind === 'tool' && !item.done) {
          index = i;
          break;
        }
      }
      if (index === -1) return t;
      const tool = t.items[index] as ToolItem;
      // `?? 0`, so the first sub-1k chunk doesn't count as a change from
      // "unset" to zero and re-render the transcript to display nothing.
      if ((tool.streamedK ?? 0) === k) return t;
      const items = [...t.items];
      items[index] = { ...tool, streamedK: k };
      return { ...t, items };
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
  phase: 'thinking' | 'tool' | 'responding' | 'working';
  /** The running tool's name, when `phase` is 'tool'. */
  tool?: string;
  /** Its streamed output so far, in whole thousands of chars. */
  streamedK?: number;
}

export function activityOf(t: Transcript): Activity {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const item = t.items[i]!;
    if (item.kind === 'tool' && !item.done)
      return { phase: 'tool', tool: item.name, streamedK: item.streamedK };
    if (item.kind === 'reasoning' && item.streaming) return { phase: 'thinking' };
    if (item.kind === 'text' && item.streaming) return { phase: 'responding' };
    // Anything settled means the last thing on screen is finished and the
    // agent is between steps — waiting on the model. That gap is exactly the
    // stretch that used to show nothing at all.
    if (item.kind === 'tool' || item.kind === 'text' || item.kind === 'plan') break;
  }
  return { phase: 'working' };
}
