import { useCallback, useRef, useState } from 'react';
import type { AgentOutcome, ToolCall } from '@heapcode/core/agent';
import type { ChatMessage } from '@heapcode/core/providers';
import { resolveContextWindow } from '@heapcode/core/providers';
import type { StoredProfile } from '../shared/settings.js';
import { runBrowserAgent } from '../agent/run.js';

/** One tool call and what came back, as the transcript shows it. */
export interface ToolActivity {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Set when the turn ended badly; rendered differently from model prose. */
  error?: string;
  /** True while the run behind this turn is still going. */
  streaming?: boolean;
  tools?: ToolActivity[];
}

/**
 * How a run that did not simply finish should be described.
 *
 * A run that hit the step limit or was stopped has produced real work and a
 * partial answer; presenting that as a plain reply would misrepresent it as
 * complete, and presenting it as an error would throw the work away. Both are
 * failures the CLI already ran into.
 */
function outcomeNote(outcome: AgentOutcome): string | undefined {
  switch (outcome) {
    case 'done':
    case 'planned':
      return undefined;
    case 'stopped':
      return 'Stopped.';
    case 'max-iterations':
      return 'Reached the step limit for this run. Ask again to continue from here.';
    case 'incomplete':
      return 'The model stopped without finishing the task.';
    case 'error':
      return 'The run ended with an error.';
  }
}

/**
 * The agent run behind the panel.
 *
 * Everything here drives core's loop; there is no chat path any more. A
 * question that needs no page is handled by the loop itself, which finishes
 * immediately for conversational messages rather than exploring.
 */
export function useChat(profile: StoredProfile) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState(0);
  const abort = useRef<AbortController | undefined>(undefined);

  const stop = useCallback(() => {
    abort.current?.abort();
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (busy || text.trim().length === 0) return;

      // Only completed prose turns become history. Tool traffic belongs to the
      // run that produced it -- replaying it into the next run would spend the
      // context window on stale snapshots whose handles no longer resolve.
      const history: ChatMessage[] = turns
        .filter((t) => !t.error && t.content.trim().length > 0)
        .map((t) => ({ role: t.role, content: t.content }) satisfies ChatMessage);

      setTurns((prev) => [
        ...prev,
        { role: 'user', content: text },
        { role: 'assistant', content: '', streaming: true, tools: [] },
      ]);
      setBusy(true);

      const controller = new AbortController();
      abort.current = controller;

      /** Patch the trailing assistant turn -- the one this run is writing into. */
      const patch = (fn: (turn: Turn) => Turn) =>
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last) next[next.length - 1] = fn(last);
          return next;
        });

      let content = '';
      try {
        const outcome = await runBrowserAgent({
          profile,
          task: text,
          history,
          signal: controller.signal,
          events: {
            onTextDelta: (delta) => {
              content += delta;
              patch((turn) => ({ ...turn, content }));
            },
            onTextEnd: () => {},
            onToolCall: (call: ToolCall) => {
              patch((turn) => ({
                ...turn,
                tools: [...(turn.tools ?? []), { id: call.id, name: call.name, args: call.args }],
              }));
            },
            onToolResult: (result) => {
              patch((turn) => ({
                ...turn,
                tools: (turn.tools ?? []).map((t) =>
                  t.id === result.id
                    ? { ...t, result: result.content, isError: result.isError }
                    : t,
                ),
              }));
            },
            onContextUsage: (used) => setTokens(used),
            onCompaction: () => {},
          },
        });

        patch((turn) => ({ ...turn, streaming: false, error: outcomeNote(outcome) }));
      } catch (error) {
        const message = controller.signal.aborted
          ? 'Stopped.'
          : error instanceof Error
            ? error.message
            : String(error);
        patch((turn) => ({ ...turn, streaming: false, error: message }));
      } finally {
        abort.current = undefined;
        setBusy(false);
      }
    },
    [busy, profile, turns],
  );

  const clear = useCallback(() => {
    setTurns([]);
    setTokens(0);
  }, []);

  return { turns, busy, send, stop, clear, tokens, contextWindow: resolveContextWindow(profile) };
}
