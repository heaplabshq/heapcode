/**
 * Shared pieces of the `ask_user` wait, so both hosts bound it the same way.
 *
 * The wait itself is deliberately host-side. Every input that should reset it —
 * a keypress, a window regaining focus — happens in the host, and so does the
 * countdown UI; a server-side timer would have to be fed both across the socket
 * for no gain. The case a server-side bound would add, a host that stops
 * answering entirely, is already covered: the socket closes and
 * `Session.dispose()` aborts every in-flight run (server/session.ts:95-103).
 */

/**
 * What the model is told when nobody answered and no idle timeout was involved
 * — a cancelled run, a headless run with no human, or a host that could not
 * show the question. Was duplicated across all three clients.
 */
export const ASK_USER_NO_ANSWER = 'The user did not answer. Proceed with your best judgment.';

/** How long before expiry a host should start showing a visible countdown. */
export const ASK_USER_COUNTDOWN_MS = 20_000;

export function askUserAnswerMessage(answer: string): string {
  return `User answered: ${answer}`;
}

/**
 * The idle-timeout result. Not an error — the agent is meant to carry on.
 *
 * The last sentence is load-bearing rather than decorative. `ask_user` is
 * documented as a clarifying-question tool, but both its own description
 * (toolDefinitions.ts) and the system prompt (prompts.ts) invite "whether to
 * proceed" questions through it, and `blocksAction` depends on the model
 * classifying its own question correctly. When that classification is wrong,
 * this wording is the only thing standing between an idle timeout and a model
 * reading "proceed on your own judgment" as consent to a destructive action.
 */
export function askUserIdleMessage(partial?: string): string {
  const trimmed = partial?.trim();
  return [
    'The user did not respond within the configured idle timeout and may be away.',
    trimmed ? `Their partial answer so far was: "${trimmed}".` : undefined,
    'Proceed on your own judgment and keep going; you can ask again later if you still need a decision.',
    'This is NOT approval for anything — if you were asking whether to proceed with an action, do not treat this as a yes.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Whether this `ask_user` call is gating an action rather than asking the user
 * to choose or clarify. Such a call must never resolve on idle, however the
 * timeout is configured — the same rule Claude Code applies to permission
 * prompts and plan approval.
 *
 * Model-supplied, because nothing else can tell the two apart: a question is
 * just a string, and this product's real permission gates live elsewhere
 * entirely (`permission/request` → PermissionEngine; plan approval via a
 * `planOnly` run), so there is no structural signal to read.
 */
export function askUserBlocksAction(args: Record<string, unknown>): boolean {
  return args.blocksAction === true;
}

/**
 * A duration setting into milliseconds, or undefined for "no timeout" — which
 * is the default and the value every unset, empty, or unparseable setting maps
 * to. Never throws: a typo in a config file must not break an agent run, it
 * must just leave the wait unbounded, which is the pre-existing behavior.
 *
 * Accepts `90s`, `5m`, `1h`, or a bare number of seconds. `0`, `off`, `none`
 * and anything unrecognized mean no timeout.
 */
export function parseIdleTimeout(raw: string | number | undefined | null): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') return raw > 0 ? raw * 1_000 : undefined;
  const text = raw.trim().toLowerCase();
  if (!text || text === 'off' || text === 'none' || text === '0') return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2] ?? 's';
  const scale = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  return value * scale;
}

/**
 * An idle deadline that any activity pushes back.
 *
 * Shared rather than written twice because "reset on activity" is the part that
 * protects a present-but-slow person from being cut off mid-thought, and two
 * hand-rolled versions of it would drift. Hosts own their own rendering and
 * poll `remainingMs()` for the countdown.
 */
export class IdleDeadline {
  private timer?: ReturnType<typeof setTimeout>;
  private expiresAt = 0;
  private stopped = false;

  /** `ms` undefined → an inert deadline that never fires, which is the default. */
  constructor(
    private readonly ms: number | undefined,
    private readonly onExpire: () => void,
  ) {}

  get enabled(): boolean {
    return this.ms !== undefined;
  }

  start(): void {
    if (this.ms === undefined || this.stopped) return;
    this.arm();
  }

  /** Activity: a keypress, a focus gain, anything that means the user is still here. */
  touch(): void {
    if (this.ms === undefined || this.stopped || !this.timer) return;
    this.arm();
  }

  /** Milliseconds left, or Infinity when no timeout is configured. */
  remainingMs(): number {
    if (this.ms === undefined || !this.timer) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.expiresAt - Date.now());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.expiresAt = Date.now() + this.ms!;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) this.onExpire();
    }, this.ms);
    // Never hold the process open on this alone — a pending question must not
    // stop `heapcode -p` from exiting once its run is done.
    this.timer.unref?.();
  }
}
