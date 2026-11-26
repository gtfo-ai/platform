/**
 * **A gate that has no answer yet waits by time, not by five checks** (BD-034, the product owner's
 * rule of 2026-11-26: *anything the platform can recover from by itself must not escalate*).
 *
 * Until BD-034 every gate other than the CI gate parked its task for a person after
 * five (`MAX_GATE_CHECKS`) `pending` answers thirty seconds apart — two and a half minutes. What a gate
 * waits on is never a person's decision: the rebase gate waits for the provider to compute
 * mergeability (GitLab computes it asynchronously, and on a busy instance that takes minutes), and a
 * custom gate that declares an `on` event waits for that event. Both end by themselves, so the bound
 * is now a **time**:
 *
 *  - **the clock** is the gate's current entry, `task_stages.entered_at`, read on every fire — the
 *    same clock as the CI gate's (`ci-wait.ts`), so a restart, a recovered job or a replay cannot
 *    extend it, and a hand-back is a new attempt with a fresh clock;
 *  - **the limit** is {@link GATE_PENDING_LIMIT_MINUTES} for a gate the platform evaluates (the
 *    provider's own computation) and {@link GATE_EVENT_LIMIT_MINUTES} for a gate that waits for a
 *    declared event;
 *  - **the cadence** backs off: thirty seconds, then twice as long each time up to five minutes, the
 *    last re-check moved up to the deadline;
 *  - **the backstop** is a count ({@link gateWaitBackstop}), reached only if the clock were wrong.
 *
 * The pure half — the decision and the brief; `jobs.ts` reads the entry, applies the decision and
 * settles. An attempt with **no** `task_stages` row (a task entered before every entry opened one)
 * has no instant to time from and keeps the five checks rather than inventing a clock (standing
 * rule 16).
 */

/** The first re-check: the gate's own thirty seconds (`GATE_RECHECK_MS`). */
export const GATE_WAIT_FIRST_RECHECK_MS = 30_000;

/** The delay's ceiling: one provider read every five minutes while a gate waits. */
export const GATE_WAIT_MAX_RECHECK_MS = 5 * 60_000;

/**
 * How long a gate the platform evaluates waits for the provider to answer — the default CI timeout's
 * sixty minutes. Mergeability that has not been computed in an hour is a provider that is stuck.
 */
export const GATE_PENDING_LIMIT_MINUTES = 60;

/** How long a gate waits for its declared `on` event: a day. */
export const GATE_EVENT_LIMIT_MINUTES = 24 * 60;

const MINUTE_MS = 60_000;

/** The delay after check number `checks`: 30 s, 60 s, 2 min, 4 min, then 5 min. */
export const gateWaitDelayMs = (checks: number): number =>
  Math.min(
    GATE_WAIT_MAX_RECHECK_MS,
    GATE_WAIT_FIRST_RECHECK_MS * 2 ** Math.max(0, Math.min(checks - 1, 20)),
  );

/**
 * The backstop: one more check than the limit could hold at the **shortest** delay, so it is
 * reached only if the clock were wrong.
 */
export const gateWaitBackstop = (limitMinutes: number): number =>
  Math.ceil((limitMinutes * MINUTE_MS) / GATE_WAIT_FIRST_RECHECK_MS) + 1;

export type GateWaitDecision =
  | { readonly kind: 'recheck'; readonly delayMs: number }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'backstop'; readonly limit: number };

/**
 * What a pending gate read does next. `checks` counts this one (the first evaluation is 1). An
 * instant that does not parse is past the deadline, never within it (standing rule 16).
 */
export const decideGateWait = (input: {
  readonly enteredAtMs: number;
  readonly nowMs: number;
  readonly checks: number;
  readonly limitMinutes: number;
}): GateWaitDecision => {
  const left = input.enteredAtMs + input.limitMinutes * MINUTE_MS - input.nowMs;
  if (!(left > 0)) {
    return { kind: 'timed_out' };
  }
  const limit = gateWaitBackstop(input.limitMinutes);
  if (!(input.checks < limit)) {
    return { kind: 'backstop', limit };
  }
  return { kind: 'recheck', delayMs: Math.min(gateWaitDelayMs(input.checks), left) };
};

/**
 * The limit a gate waits to: a declared event's day, or the provider's hour. `waitsForEvent` is
 * true for a custom gate the platform does not evaluate and that declares an `on` event.
 */
export const gateWaitLimitMinutes = (waitsForEvent: boolean): number =>
  waitsForEvent ? GATE_EVENT_LIMIT_MINUTES : GATE_PENDING_LIMIT_MINUTES;

/** Everything the brief says: platform text, and the gate's own `detail`. */
export interface GateWaitFacts {
  readonly stage: string;
  readonly detail: string;
  readonly checks: number;
  readonly limitMinutes: number;
  /** Whole minutes since the gate's entry; `null` when that instant did not parse. */
  readonly minutes: number | null;
}

const afterHowLong = (minutes: number | null): string =>
  minutes === null ? 'after an unmeasured time' : `after ${String(minutes)} minutes`;

/** The escalation's reason — the gate's row and `task.escalated` carry it. */
export const gateWaitReason = (facts: GateWaitFacts, decision: GateWaitDecision): string =>
  `the "${facts.stage}" gate could not be decided ${afterHowLong(facts.minutes)} and ${String(facts.checks)} checks: ${facts.detail}; ${
    decision.kind === 'backstop'
      ? `it stopped at its backstop of ${String(decision.limit)} checks`
      : `it stopped at its ${String(facts.limitMinutes)}-minute limit`
  }`;

/** The brief a person reads on the task page: what was tried, and what to look at. */
export const gateWaitBrief = (facts: GateWaitFacts): string =>
  `The "${facts.stage}" gate for this task still has no answer ${afterHowLong(facts.minutes)} (${facts.detail}). ` +
  `The platform asked ${String(facts.checks)} times, waiting 30 seconds and then twice as long each time up to 5 minutes, until its ${String(facts.limitMinutes)}-minute limit for this gate. ` +
  'Something that should have answered by itself did not. Look at the merge request (or the event the gate waits for) yourself, then hand the task back.';
