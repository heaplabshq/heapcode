/**
 * Noticing that the agent is going in circles.
 *
 * Watched a run asked to find jobs on a virtualised list spend most of a
 * hundred model turns on it: `get_elements` for "job", then "Engineer", then
 * "Developer", then "with verification", `get_page_text` four times, and
 * narration that read "Let me look at the job list items in the left panel"
 * eleven times in a row. Every call succeeded. Every call returned nothing
 * useful. Nothing anywhere told the model that.
 *
 * Core has no repetition detection — that is checked, not assumed — and its
 * step limit is a hundred turns, so an unproductive loop is expensive long
 * before anyone is asked whether to continue. The existing no-op detection is
 * for mutating actions only, on the reasoning that a click which changed
 * nothing is the dangerous silent failure. A read that finds nothing is not
 * dangerous, but repeated forty times it is the same failure wearing different
 * clothes: the agent believes it is making progress.
 *
 * Two signals, because the real loop showed both and either alone would have
 * missed it.
 *
 * **The identical call.** Same tool, same arguments, same result. There is no
 * reading of that which is progress, so it escalates fast.
 *
 * **The same tool, over and over.** Four `get_elements` calls in a row with
 * nothing else between them is not exploration, whatever the arguments were —
 * and it is the shape the real loop took, which exact-match would have sailed
 * straight past.
 *
 * What it does about it matters as much as noticing. It never fails the call:
 * the result the model asked for is still returned, with the observation
 * appended. Withholding a real answer to make a point would just add a second
 * problem. Only when that has been ignored does it refuse, and the refusal says
 * what to do instead — ask, or report what was found — because "stop" with no
 * alternative is how a model starts inventing one.
 */

/** How many identical call-and-result pairs before this is worth mentioning. */
const SAY_AT = 2;
/** And before the call is refused outright. */
const REFUSE_AT = 3;

/** How many consecutive calls to one tool count as circling. */
const RUT_SAY_AT = 4;
const RUT_REFUSE_AT = 6;

export type Verdict =
  | { kind: 'ok' }
  /** Return the result, with this appended. */
  | { kind: 'warn'; note: string }
  /** Refuse instead, with this as the error. */
  | { kind: 'refuse'; reason: string };

function keyFor(tool: string, args: Record<string, unknown>): string {
  // Key order is not stable across model calls, so sort it. Without this the
  // same call written two ways looks like two calls.
  const entries = Object.entries(args ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `${tool}(${JSON.stringify(entries)})`;
}

export class RepetitionGuard {
  /** How many times each exact call has produced the result it last produced. */
  #identical = new Map<string, { content: string; count: number }>();
  /** The tool called last, and how many times in a row. */
  #lastTool?: string;
  #inARow = 0;

  /**
   * Record a call and its result, and say whether it is going anywhere.
   *
   * Called after the tool has run, because the result is half the signal: two
   * `get_page_text` calls that returned different sections of a long page are
   * progress, and two that returned the same text are not.
   */
  check(tool: string, args: Record<string, unknown>, content: string): Verdict {
    this.#inARow = tool === this.#lastTool ? this.#inARow + 1 : 1;
    this.#lastTool = tool;

    const key = keyFor(tool, args);
    const seen = this.#identical.get(key);
    const repeats = seen && seen.content === content ? seen.count + 1 : 1;
    this.#identical.set(key, { content, count: repeats });

    if (repeats >= REFUSE_AT) {
      return {
        kind: 'refuse',
        reason:
          `This is the ${ordinal(repeats)} time you have called ${tool} with these arguments and ` +
          `received exactly the same result. It will not change. Do something different: look at ` +
          `the page another way, scroll, ask the user what they meant, or finish and tell them what ` +
          `you did find.`,
      };
    }

    if (this.#inARow >= RUT_REFUSE_AT) {
      return {
        kind: 'refuse',
        reason:
          `You have called ${tool} ${this.#inARow} times in a row without doing anything else, and ` +
          `you are no closer. Stop looking the same way. Either act on what you already have, ask ` +
          `the user what they want, or finish and report what you found and what you could not.`,
      };
    }

    if (repeats >= SAY_AT) {
      return {
        kind: 'warn',
        note:
          `Note: this is the same call and the same result as last time. Repeating it will not ` +
          `produce anything new.`,
      };
    }

    if (this.#inARow >= RUT_SAY_AT) {
      return {
        kind: 'warn',
        note:
          `Note: that is ${this.#inARow} ${tool} calls in a row. If this one has not told you what ` +
          `you needed, another will not either — try a different approach, or ask the user.`,
      };
    }

    return { kind: 'ok' };
  }

  /**
   * A mutating action clears the rut counter.
   *
   * The page is a different page after a click, so the reads that follow are
   * asking a new question even when they use the same tool.
   */
  acted(): void {
    this.#lastTool = undefined;
    this.#inARow = 0;
  }
}

function ordinal(n: number): string {
  if (n === 2) return 'second';
  if (n === 3) return 'third';
  return `${n}th`;
}

/**
 * Noticing the circle inside a single turn, where the guard above cannot see.
 *
 * `RepetitionGuard` watches tool calls, so it needs the model to make one. The
 * failure this exists for never gets that far: asked to tick a checkbox the
 * snapshot had not offered (see content/visibility.ts), a model spent one
 * unbroken turn deliberating -- "let me try clicking", "hmm, actually", "OK
 * FINAL", "writing the call now" -- and then degenerated into the same two
 * lines over and over, hundreds of times, without ever emitting the call it
 * kept announcing.
 *
 * Nothing stopped it. Core's `finishReason === 'length'` nudge is the right
 * recovery but it only fires when the provider cuts the reply off, and
 * `maxTokens` is per-profile and usually unset, so there was no cut to wait
 * for. The user pressed Stop. That is the hole: a run that is going nowhere
 * should not depend on someone watching it.
 *
 * What counts as degenerate is deliberately narrow -- a chunk of text repeated
 * back to back many times over. Circling in *substance* ("let me reconsider"
 * for forty paragraphs) is a judgement call and this does not attempt it;
 * verbatim repetition is not a judgement call, and it is what the real failure
 * looked like once it had given up.
 */

/** How much of the tail to keep. Enough to hold several repeats of a long unit. */
const TAIL = 4_000;
/** The shortest repeating unit worth calling a loop. */
const MIN_UNIT = 3;
/** The longest. Past this, repetition is more likely to be a real list. */
const MAX_UNIT = 400;
/** How many back-to-back repeats before the run is stopped. */
const REPEATS = 8;
/** Only re-check every so often: the scan is over the tail, not over one delta. */
const CHECK_EVERY = 300;

export class SpiralWatch {
  #tail = '';
  #sinceCheck = 0;
  #tripped = false;

  /**
   * Feed it whatever the model is saying, thinking included.
   *
   * Returns true exactly once, on the delta that confirms the loop, so the
   * caller can stop the run without having to de-duplicate the report.
   */
  saw(text: string): boolean {
    if (this.#tripped || !text) return false;
    this.#tail = (this.#tail + text).slice(-TAIL);
    this.#sinceCheck += text.length;
    if (this.#sinceCheck < CHECK_EVERY) return false;
    this.#sinceCheck = 0;
    if (!looping(this.#tail)) return false;
    this.#tripped = true;
    return true;
  }

  /**
   * A turn ended, or a tool ran.
   *
   * Either way the model has stopped saying whatever it was saying, so the
   * tail is no longer evidence of anything. Without this, text from one turn
   * and text from the next could form a repeat that neither one contains.
   */
  turned(): void {
    this.#tail = '';
    this.#sinceCheck = 0;
  }

  /** What to tell the user, in their terms rather than the model's. */
  get reason(): string {
    return (
      'The model started repeating itself instead of acting, so the run was stopped. ' +
      'This usually means it could not find a control it was looking for. Try asking again, ' +
      'more specifically, or take that one step yourself and let it carry on.'
    );
  }
}

/**
 * Whether the end of this text is one chunk repeated back to back.
 *
 * Compared on collapsed whitespace, because the loop that prompted this
 * alternated one blank line with two and no person would call that a
 * difference.
 */
function looping(text: string): boolean {
  const tail = text.replace(/\s+/g, ' ').trimEnd();
  for (let unit = MIN_UNIT; unit <= MAX_UNIT; unit++) {
    if (tail.length < unit * REPEATS) return false;
    const candidate = tail.slice(-unit);
    // Whitespace-only units repeat in perfectly ordinary text.
    if (!candidate.trim()) continue;
    let repeats = 1;
    while (
      repeats < REPEATS &&
      tail.slice(-unit * (repeats + 1), -unit * repeats) === candidate
    ) {
      repeats++;
    }
    if (repeats >= REPEATS) return true;
  }
  return false;
}
