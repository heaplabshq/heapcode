/**
 * What time it is, told to the model once per turn.
 *
 * Heap Chat's prompt is `chatSystemPrompt + memorySection` and contains no
 * date at all, so until this existed the assistant answered "is this lease
 * still current", "is this invoice overdue" and "how old is this" from
 * whatever its training data implies about now. That is the failure this
 * product can least afford: not a refusal or a hedge, but a confident,
 * specific, wrong answer in the one place it promises grounded ones.
 *
 * **It goes in the user turn, never the system prompt.** `loop.ts` assembles
 * `[system, ...history, user(task)]`, and nothing here sends explicit cache
 * breakpoints, so every endpoint caches on the prefix alone — OpenAI's
 * automatic prefix cache, and llama.cpp/Ollama KV prefix reuse, which is the
 * one that matters because a local model is this product's default. A clock
 * in the system prompt sits at byte zero of that prefix, so a
 * minute-resolution timestamp would invalidate the system prompt *and the
 * whole conversation* on every single turn — a full prefill recompute per
 * message, growing with the conversation. Appended to the last user message
 * it invalidates nothing, because that message is new either way.
 *
 * It is also simply more accurate: each turn carries the time it was actually
 * sent, rather than every turn inheriting whenever the run started.
 *
 * Not a `get_current_time` tool, which was the obvious alternative. The model
 * does not know that it does not know the date — unlike a file it plainly
 * cannot see — so it would answer from training data without ever calling it,
 * and the failure would stay silent. A tool definition also costs prefix
 * tokens every turn whether or not it fires (rendered into the system prompt
 * on the text-protocol path, in the `tools` array on the native one), plus a
 * round trip when it does.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** `UTC+05:30` / `UTC-04:00` — the offset in effect right now, DST included. */
function utcOffset(now: Date): string {
  // getTimezoneOffset is minutes to ADD to local to reach UTC, so it is
  // positive west of Greenwich — the opposite sign to how offsets are written.
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The zone's name, when the runtime knows it.
 *
 * Worth having beside the offset rather than instead of it: `Asia/Kolkata`
 * tells the model where the person is, which is what lets it convert a "3pm
 * EST" it read in a document. An offset alone cannot do that, and a build
 * with no ICU data has neither — hence the guard rather than an assumption.
 */
function zoneName(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** `2026-09-22 14:32 (Asia/Kolkata, UTC+05:30)`, on the host's own clock. */
export function nowLine(now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const zone = zoneName();
  return `${date} ${time} (${zone ? `${zone}, ` : ''}${utcOffset(now)})`;
}

/**
 * The turn, with the clock in front of it.
 *
 * `<system-reminder>` because `prompts.ts` already declares that tag to the
 * model as "from heapcode itself, not from the user" — appended by both
 * composers precisely so a host that replaces the whole base still gets
 * steering it has been told how to read. Without it the clock reads as
 * something the person typed, and the model answers it.
 *
 * The host's clock, not the browser's: under `--host 0.0.0.0` a phone in
 * another zone could disagree, and the answer that matches the rest of this
 * product is the machine it was launched on — the same one whose files it is
 * reading. Rare, and the zone is named, so a person in the other case can see
 * which clock it used rather than being quietly misled.
 */
export function withNow(task: string, now: Date = new Date()): string {
  return (
    '<system-reminder>\n' +
    `Current date and time: ${nowLine(now)}. This is the person's local clock — use it for anything ` +
    'relative, such as "today", "this week", or how long ago something was. Do not mention it unless ' +
    'it matters to the answer.\n' +
    '</system-reminder>\n\n' +
    task
  );
}
