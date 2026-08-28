import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentOutcome, ToolCall } from '@heapcode/core/agent';
import type { ChatMessage } from '@heapcode/core/providers';
import { resolveContextWindow } from '@heapcode/core/providers';
import type { StoredProfile } from '../shared/settings.js';
import { runBrowserAgent, type ConfirmAnswer, type ConfirmRequest } from '../agent/run.js';
import type { BrowserMode } from '../agent/originPolicy.js';
import { clearSession, loadSession, saveSession } from '../shared/session.js';
import type { GrantNeeded } from './page.js';
import type { Dataset } from '../shared/dataset.js';
import { recordRun } from '../shared/tasks.js';
import { ThinkSplitter } from './thinkStream.js';

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
  /**
   * The model thinking, as its own collapsed block.
   *
   * Kept apart from narration because it is not addressed to the user: a
   * reasoning model produces pages of "wait, let me reconsider", and rendering
   * that as speech makes the transcript unreadable and the answer hard to find.
   * Collapsed by default, and still there when someone wants to know why.
   */
  | { kind: 'thinking'; text: string; streaming?: boolean }
  | { kind: 'tool'; tool: ToolActivity }
  /**
   * What the page looked like at this point.
   *
   * Shown to the user and never sent to the model: a picture costs a few hundred
   * kilobytes and would sit in the context for every remaining turn, which is
   * how these agents become slow and expensive. The model reads the
   * accessibility tree instead — smaller, exact, and addressable.
   */
  | { kind: 'view'; dataUrl: string }
  /**
   * The rows collected so far, as a table the user can read and export.
   *
   * One step per run rather than one per extraction: the set is cumulative, so
   * a five-page collection should leave one table that grew, not five snapshots
   * of it growing.
   */
  | { kind: 'data'; dataset: Dataset }
  /**
   * The point where the run outgrew the model's window and its middle was
   * summarized away.
   *
   * Carries nothing: the token counts are already on the meter, and what
   * matters here is only that it happened and where.
   */
  | { kind: 'compacted' };

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
 * Settle a finished turn: pick the answer, and stop showing it twice.
 *
 * There are two ways the same text ends up on screen in both places, and they
 * need opposite treatment -- which is why the first attempt at this fixed only
 * one of them and the duplicate stayed exactly where it was.
 *
 * Either the model called `finish` with a summary repeating what it had already
 * streamed -- both are real, core reports them separately and correctly, and
 * the narration is the copy to drop (see `withoutEchoedAnswer` for how
 * carefully).
 *
 * Or the model produced no summary at all and `answerFrom` promoted the
 * narration to be the answer. Then the promotion *itself* is the duplication:
 * those notes are now the turn's content and are still sitting above it as
 * steps. This is the older of the two bugs and the one that was actually
 * showing -- every run ending without a finish summary hits it.
 *
 * Promotion drops every note rather than only the last, because `answerFrom`
 * joins all of them into the answer. Nothing is lost; it moves.
 */
export function settle(turn: Turn): Turn {
  const summarised = turn.content.trim().length > 0;
  const next: Turn = { ...turn, content: answerFrom(turn) };

  if (summarised) return withoutEchoedAnswer(next);
  const steps = (next.steps ?? []).filter((step) => step.kind !== 'note');
  return steps.length === (next.steps ?? []).length ? next : { ...next, steps };
}

/**
 * Whitespace-insensitive, for comparing two copies of the same prose.
 *
 * Not markdown-insensitive: both strings being compared are markdown *source* —
 * the narration as it streamed and the finish summary as core delivered it — so
 * `**Ollama**` appears identically in each. Only the line breaks differ, because
 * one arrived in deltas.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Drop narration that is just the answer, written twice.
 *
 * A model that streams its reply and then calls `finish` with that same reply
 * as the summary produces both — core reports them separately, correctly, and
 * the panel rendered each: once as raw narration and once as the rendered
 * answer, one under the other. It reads as a stutter, and it is the second time
 * this failure mode has appeared in a different disguise.
 *
 * Deliberately conservative. Only long notes are considered, because a short
 * one ("Let me read the page") is never the answer; and a note is only dropped
 * when it and the answer are substantially the same text, not merely when one
 * mentions the other. Losing real narration to a clever rule would be worse
 * than showing a duplicate.
 */
export function withoutEchoedAnswer(turn: Turn): Turn {
  const answer = normalize(turn.content);
  const MIN = 40;
  if (answer.length < MIN) return turn;

  const steps = (turn.steps ?? []).filter((step) => {
    if (step.kind !== 'note') return true;
    const note = normalize(step.text);
    if (note.length < MIN) return true;
    if (note === answer) return false;

    // One containing the other counts only when the shorter is most of the
    // longer: the model that trimmed a sentence off its summary wrote the same
    // thing twice, the one that narrated a plan and then answered did not.
    const [shorter, longer] = note.length < answer.length ? [note, answer] : [answer, note];
    return !(longer.includes(shorter) && shorter.length >= longer.length * 0.6);
  });

  return steps.length === (turn.steps ?? []).length ? turn : { ...turn, steps };
}

/**
 * The agent run behind the panel.
 *
 * Everything here drives core's loop; there is no plain chat path. A question
 * that needs no page is handled by the loop itself, which finishes immediately
 * for conversational messages rather than exploring.
 */
export interface ChatDeps {
  mode: BrowserMode;
  /** The site the panel is pointed at, recorded with the run for later recall. */
  host?: string;
  confirm(request: ConfirmRequest): Promise<ConfirmAnswer>;
  cancelConfirm(): void;
  ask(question: { question: string; options?: string[]; blocksAction: boolean }): Promise<string | undefined>;
  cancelAsk(): void;
  /**
   * Ask for a host the run cannot reach. Resolves when the user answers.
   *
   * Handed up rather than handled here: granting needs a user gesture, so the
   * only thing that can act on it is a button, and the button belongs to the
   * panel.
   */
  requestGrant(needed: GrantNeeded): Promise<boolean>;
  /** Abandon a pending ask, when the run it belongs to is stopped. */
  cancelGrant(): void;
  /** Hand the page to the user for one step. Resolves when they are done. */
  handOver(request: { what: string }): Promise<boolean>;
  cancelHandOver(): void;
}

export function useChat(profile: StoredProfile, deps: ChatDeps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState(0);
  const abort = useRef<AbortController | undefined>(undefined);
  /**
   * Whether the stored conversation has been read back yet.
   *
   * Without it the first render writes an empty transcript over the stored one
   * before the read has returned, which loses exactly the conversation this is
   * meant to save.
   */
  const restored = useRef(false);

  // Bring back the conversation the last panel was having. The run itself is
  // gone -- an in-flight model call cannot be resumed -- but the transcript, the
  // answers the user already gave, and the work already done all come back, and
  // an unfinished turn is marked as interrupted rather than left spinning.
  useEffect(() => {
    let cancelled = false;
    void loadSession().then((session) => {
      if (cancelled || !session) {
        restored.current = true;
        return;
      }
      setTurns(session.turns);
      setTokens(session.tokens);
      restored.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Checkpoint after every change rather than at the end of a run: the case
  // this exists for is the panel closing at a moment nobody chose.
  useEffect(() => {
    if (!restored.current) return;
    void saveSession(turns, tokens);
  }, [turns, tokens]);
  /**
   * Sites trusted for writes, for this session only.
   *
   * A ref rather than state because the running loop reads it between calls,
   * and a re-render is not what should publish it. Session-scoped on purpose:
   * "always allow" answered once on a shopping site should not still be in
   * force next week (PRD section 6.3).
   */
  const trustedHosts = useRef(new Set<string>());

  const stop = useCallback(() => {
    abort.current?.abort();
    // A question still on screen belongs to the run being stopped; leaving it
    // there would let a later click approve an action nobody is waiting for.
    deps.cancelConfirm();
    deps.cancelAsk();
    // A permission asked for by a run that is being stopped is not a question
    // anyone still needs answered, and neither is a step it was waiting on.
    deps.cancelGrant();
    deps.cancelHandOver();
  }, [deps]);

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
      /**
       * Splits `<think>` tags out of the narration stream.
       *
       * One per run, reset when a message ends: the tag can straddle two
       * deltas, so this has to hold state across them. Endpoints that report
       * reasoning in its own field never reach it — those arrive on
       * `onReasoningDelta` already separated.
       */
      let splitter = new ThinkSplitter();

      /** Append to the thinking block in flight, or start one. */
      const think = (text: string) => {
        if (!text) return;
        patch((turn) => {
          const steps = [...(turn.steps ?? [])];
          const last = steps[steps.length - 1];
          if (last?.kind === 'thinking' && last.streaming) {
            steps[steps.length - 1] = { ...last, text: last.text + text };
          } else {
            steps.push({ kind: 'thinking', text, streaming: true });
          }
          return { ...turn, steps };
        });
      };

      /** Close the thinking block, so the next one is a new block. */
      const endThinking = () =>
        patch((turn) => ({
          ...turn,
          steps: (turn.steps ?? []).map((step) =>
            step.kind === 'thinking' && step.streaming ? { ...step, streaming: false } : step,
          ),
        }));
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
          mode: deps.mode,
          trustedHosts: trustedHosts.current,
          confirm: deps.confirm,
          ask: deps.ask,
          onTrustHost: (host) => trustedHosts.current.add(host.toLowerCase()),
          onBlocked: (reason) =>
            patch((turn) => ({
              ...turn,
              steps: [...(turn.steps ?? []), { kind: 'note', text: reason }],
            })),
          requestGrant: deps.requestGrant,
          handOver: deps.handOver,
          events: {
            // The finish summary. Core sends it here, separately from the
            // streamed narration -- it is the answer the model meant to give.
            onText: (summary) => patch((turn) => ({ ...turn, content: summary })),
            onReasoningDelta: (delta) => think(delta),
            onReasoningEnd: () => endThinking(),
            onTextDelta: (rawDelta) => {
              // Inline `<think>` goes to the thinking block; what is left is
              // what the model is actually saying to the user.
              const split = splitter.push(rawDelta);
              if (split.reasoning) think(split.reasoning);
              if (!split.text) return;
              note += split.text;
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
              const tail = splitter.end();
              if (tail.reasoning) think(tail.reasoning);
              endThinking();
              splitter = new ThinkSplitter();
              note = '';
            },
            onToolCall: (call: ToolCall) => {
              // Whatever was being narrated belongs to this call; close it off
              // so the next iteration starts a fresh note.
              endThinking();
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
            onData: (dataset) =>
              patch((turn) => {
                const steps = [...(turn.steps ?? [])];
                const existing = steps.findIndex((step) => step.kind === 'data');
                // Replace rather than append: the dataset is cumulative, so a
                // second table would be the same rows plus a few more.
                if (existing >= 0) steps[existing] = { kind: 'data', dataset };
                else steps.push({ kind: 'data', dataset });
                return { ...turn, steps };
              }),
            onView: (dataUrl) =>
              patch((turn) => {
                const steps = [...(turn.steps ?? [])];
                const last = steps[steps.length - 1];
                // Replace a view that has not been separated by anything else,
                // so a burst of reads leaves one current picture rather than
                // five near-identical ones.
                if (last?.kind === 'view') steps[steps.length - 1] = { kind: 'view', dataUrl };
                else steps.push({ kind: 'view', dataUrl });
                return { ...turn, steps };
              }),
            onContextUsage: (used) => setTokens(used),
            /*
             * The run outgrew the model's window, so the middle of it was
             * replaced by a summary.
             *
             * Worth saying out loud. It is the one moment a run quietly stops
             * knowing something it knew a minute ago, and an agent that gets
             * vaguer halfway through a long job looks like a worse model rather
             * than one that has just been made to forget. Recorded as a step so
             * it sits in the run at the point it happened, rather than as a
             * banner that would outlive the moment it describes.
             */
            onCompaction: () =>
              patch((turn) => ({
                ...turn,
                steps: [...(turn.steps ?? []), { kind: 'compacted' }],
              })),
          },
        });

        flushNote();
        let answer = '';
        patch((turn) => {
          const settled = settle(turn);
          answer = settled.content;
          return { ...settled, streaming: false, error: outcomeNote(outcome) };
        });
        // Recorded after the fact, with what it produced, so the list is useful
        // for finding the wording of something that worked rather than being a
        // bare list of prompts.
        void recordRun({ task: text, host: deps.host, at: Date.now(), outcome, summary: answer });
      } catch (error) {
        const message = controller.signal.aborted
          ? 'Stopped.'
          : error instanceof Error
            ? error.message
            : String(error);
        patch((turn) => ({ ...turn, streaming: false, error: message }));
        void recordRun({
          task: text,
          host: deps.host,
          at: Date.now(),
          outcome: controller.signal.aborted ? 'stopped' : 'error',
          summary: message,
        });
      } finally {
        abort.current = undefined;
        setBusy(false);
      }
    },
    [busy, profile, turns, deps],
  );

  const clear = useCallback(() => {
    setTurns([]);
    setTokens(0);
    void clearSession();
  }, []);

  return { turns, busy, send, stop, clear, tokens, contextWindow: resolveContextWindow(profile) };
}
