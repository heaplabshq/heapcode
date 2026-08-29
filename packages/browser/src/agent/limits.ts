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

/**
 * Sized for real work, not for a demo.
 *
 * The first numbers here (30 / 8 / 20) were guesses, and a real task walked
 * straight through them: applying to five jobs on one site is naturally dozens
 * of clicks and tens of navigations, and the run spent its last third telling
 * the user it had hit a wall. A ceiling that stops legitimate work is not a
 * safety feature, it is a bug that happens to fail closed.
 */
export const DEFAULT_LIMITS: RunLimits = {
  maxActions: 150,
  maxNavigations: 40,
  maxPerHost: 120,
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
   *
   * Neither are actions a human approved one at a time. The ceiling exists for
   * actions taken *unattended* — it is the backstop that survives a compromised
   * model in auto mode. When someone is reading and approving each request,
   * they are a better limit than any number, and charging them for it only
   * hurries them toward the wall.
   */
  spend(tool: string, host: string): LimitCheck {
    // Opening a tab is a navigation that keeps the old page. It costs the
    // navigation budget for the same reason `navigate` does -- a run that has
    // been talked into hopping between forty pages is the thing being bounded,
    // and doing it in forty tabs instead is not a different behaviour.
    const navigating = tool === 'navigate' || tool === 'go_back' || tool === 'open_tab';

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
