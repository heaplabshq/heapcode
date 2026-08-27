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

/**
 * A run is a sequence of things the agent said and did, in order.
 *
 * Narration and tool calls have to interleave, because that is the order they
 * happened in and the narration usually explains the call that follows it.
 * Accumulating all narration into one string instead produced a turn that read
 * as the model repeating itself three times -- each iteration's "let me look
 * for X" ran straight into the next with nothing between them.
 */
export type Step =
  | { kind: 'note'; text: string }
  | { kind: 'tool'; tool: ToolActivity };

export interface Turn {
  role: 'user' | 'assistant';
  /**
   * The final answer. For an assistant turn this is the finish summary, which
   * is what the model actually intended the user to read -- not its running
   * commentary along the way.
   */
  content: string;
  /** Set when the turn ended badly; rendered differently from model prose. */
  error?: string;
  /** True while the run behind this turn is still going. */
  streaming?: boolean;
  steps?: Step[];
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
 * The answer to show for a finished run.
 *
 * Normally the finish summary, which core delivers separately from the
 * narration it streams. A run that was stopped or hit the step limit never
 * called finish, but it still said things along the way -- that narration is
 * the only answer there is, so it is promoted rather than leaving the turn
 * blank and throwing the work away.
 */
export function answerFrom(turn: Turn): string {
  if (turn.content.trim()) return turn.content;
  return (turn.steps ?? [])
    .filter((step): step is { kind: 'note'; text: string } => step.kind === 'note')
    .map((step) => step.text)
    .join('\n\n');
}

/**
 * The agent run behind the panel.
 *
 * Everything here drives core's loop; there is no plain chat path. A question
 * that needs no page is handled by the loop itself, which finishes immediately
 * for conversational messages rather than exploring.
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
        { role: 'assistant', content: '', streaming: true, steps: [] },
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

      // Narration for the step currently in flight. Flushed when the model
      // stops talking, so each note stays attached to its own step.
      let note = '';
      const flushNote = () =>
        patch((turn) => {
          const text = note.trim();
          note = '';
          if (!text) return turn;
          return { ...turn, steps: [...(turn.steps ?? []), { kind: 'note', text }] };
        });

      try {
        const outcome = await runBrowserAgent({
          profile,
          task: text,
          history,
          signal: controller.signal,
          events: {
            // The finish summary. Core sends it here, separately from the
            // streamed narration -- it is the answer the model meant to give.
            onText: (summary) => patch((turn) => ({ ...turn, content: summary })),
            onTextDelta: (delta) => {
              note += delta;
              const current = note;
              patch((turn) => {
                const steps = [...(turn.steps ?? [])];
                const last = steps[steps.length - 1];
                if (last?.kind === 'note') steps[steps.length - 1] = { kind: 'note', text: current };
                else steps.push({ kind: 'note', text: current });
                return { ...turn, steps };
              });
            },
            onTextEnd: () => {
              note = '';
            },
            onToolCall: (call: ToolCall) => {
              // Whatever was being narrated belongs to this call; close it off
              // so the next iteration starts a fresh note.
              note = '';
              patch((turn) => ({
                ...turn,
                steps: [
                  ...(turn.steps ?? []),
                  { kind: 'tool', tool: { id: call.id, name: call.name, args: call.args } },
                ],
              }));
            },
            onToolResult: (result) => {
              patch((turn) => ({
                ...turn,
                steps: (turn.steps ?? []).map((step) =>
                  step.kind === 'tool' && step.tool.id === result.id
                    ? { ...step, tool: { ...step.tool, result: result.content, isError: result.isError } }
                    : step,
                ),
              }));
            },
            onContextUsage: (used) => setTokens(used),
            onCompaction: () => {},
          },
        });

        flushNote();
        patch((turn) => ({
          ...turn,
          streaming: false,
          error: outcomeNote(outcome),
          content: answerFrom(turn),
        }));
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
