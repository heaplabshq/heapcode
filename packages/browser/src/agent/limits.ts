/**
 * Ceilings on what one run may do, whatever it has been persuaded of.
 *
 * Every other defence in this product runs through the model's judgement or the
 * user's attention, and both can be worn down: a page that gets the model to
 * propose forty actions gets forty confirmations in front of a user who will
 * start clicking through them. These limits do not depend on either. They are
 * arithmetic, they are checked before the confirmation is shown, and a
 * compromised model cannot talk its way past them (PRD section 6.1).
 *
 * The numbers are deliberately generous for real work and tight enough that a
 * runaway is bounded. A genuine form-filling task is a handful of actions; a
 * page trying to drain something needs many.
 */

export interface RunLimits {
  maxActions: number;
  maxNavigations: number;
  /** Actions on any single host, which is what a cross-site pivot has to spend. */
  maxPerHost: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxActions: 30,
  maxNavigations: 8,
  maxPerHost: 20,
};

export type LimitCheck = { ok: true } | { ok: false; reason: string };

/**
 * Counts for one run. A run is the unit because that is the scope of a single
 * user request -- carrying counts across requests would penalise a user doing
 * a lot of legitimate work in one session.
 */
export class RunBudget {
  #actions = 0;
  #navigations = 0;
  #perHost = new Map<string, number>();
  #limits: RunLimits;

  constructor(limits: RunLimits = DEFAULT_LIMITS) {
    this.#limits = limits;
  }

  /**
   * Check and consume one action's worth of budget.
   *
   * Consumed on the attempt rather than on success, so a page that makes the
   * agent fail repeatedly still runs out. Reads are not counted: they cannot
   * change anything, and counting them would stop the agent looking before it
   * acts, which is the behaviour we want most.
   */
  spend(tool: string, host: string): LimitCheck {
    const navigating = tool === 'navigate' || tool === 'go_back';

    if (this.#actions >= this.#limits.maxActions) {
      return {
        ok: false,
        reason: `This run has already taken ${this.#actions} actions, which is the limit. Stopping here. Ask again if that was genuinely needed.`,
      };
    }
    if (navigating && this.#navigations >= this.#limits.maxNavigations) {
      return {
        ok: false,
        reason: `This run has already navigated ${this.#navigations} times, which is the limit. Stopping here.`,
      };
    }

    const onHost = this.#perHost.get(host) ?? 0;
    if (onHost >= this.#limits.maxPerHost) {
      return {
        ok: false,
        reason: `This run has already taken ${onHost} actions on ${host}, which is the limit for one site. Stopping here.`,
      };
    }

    this.#actions++;
    if (navigating) this.#navigations++;
    this.#perHost.set(host, onHost + 1);
    return { ok: true };
  }

  get actions(): number {
    return this.#actions;
  }

  get navigations(): number {
    return this.#navigations;
  }
}
