/**
 * Bounded loops (BD-008) and convergence detection (product/04).
 *
 * "Every return cycle has a maximum iteration count (defaults: code review 3, business review 2,
 * CI fixes 3, refinement question rounds 2, architecture revisions 2, human MR rounds 3).
 * Exceeding any limit moves the task to `Needs human` … Nothing retries silently."
 *
 * **Two** of those loops have no key in `pipelineLimitsSchema` (`@platform/contracts`, from
 * technical/12's `pipeline.limits` block): refinement question rounds and architecture revisions.
 * They are enforced here with the documented defaults but are not configurable yet: see the WP-02
 * report; the fix belongs in the config schema, not in a workaround here. The rebase gate's two
 * loops were in that list until **WP-26** and are configurable now (`rebase_attempts`,
 * `rebase_rechecks`).
 *
 * `rebase` is product/04 S6b rather than BD-008: "rebase (or merge, per project), resolve
 * conflicts (**bounded, default 2 attempts**, by a short Implementation run), re-run CI". It counts
 * exactly those attempts: the rebase gate sends the task back to `conflict_resolution`, and the
 * third failure escalates instead.
 *
 * `rebase_rechecks` counts the **other** way into that gate, and it is a separate loop rather than
 * a second helping of the first because the two bound different things (WP-26). product/04 S6b runs
 * the gate again "whenever the default branch moves while the MR waits", which is a backwards
 * transition out of `ready_for_merge` — so before this loop existed it spent a round of
 * **`human_rounds`**, whose meaning is BD-008's "human MR rounds": three merges to `main` under a
 * waiting merge request parked the task with *"human_rounds iteration limit of 3 reached: main
 * moved to …"*, an escalation naming a loop no human had been round. Sharing `rebase` instead would
 * be worse in the other direction: one default-branch move would eat one of the two resolution
 * attempts product/04 promises. So there are two counters, and the edge that spends this one is
 * named in `RETURN_LOOPS_BY_EDGE` (`../pipeline/interpreter.js`).
 */
import type { PipelineLimits } from '@platform/contracts';

/** The named return cycles of product/04. Counter keys on `tasks.iteration_counters`. */
export const ITERATION_LOOPS = [
  'code_review',
  'business_review',
  'ci_fix',
  'human_rounds',
  'refinement_questions',
  'architecture_revisions',
  'rebase',
  'rebase_rechecks',
] as const;

export type IterationLoop = (typeof ITERATION_LOOPS)[number];

/** BD-008's defaults, verbatim. */
export const DEFAULT_ITERATION_LIMITS = {
  code_review: 3,
  business_review: 2,
  ci_fix: 3,
  human_rounds: 3,
  refinement_questions: 2,
  architecture_revisions: 2,
  /** product/04 S6b, not BD-008: conflict-resolution runs per merge request. */
  rebase: 2,
  /**
   * Re-checks of the rebase gate driven by the default branch moving (WP-26).
   *
   * **Ten, and it is the platform's number rather than a product one** — no document names a limit
   * for something the outside world drives. It is an order of magnitude above BD-008's largest
   * agent loop because a round costs one `get_merge_request` read rather than a run, and a merge
   * request that has outlived ten merges to the default branch is one a human should be looking at
   * anyway. A project that merges to `main` more often than that raises it with
   * `pipeline.limits.rebase_rechecks`.
   */
  rebase_rechecks: 10,
} as const satisfies Record<IterationLoop, number>;

export type IterationLimits = Record<IterationLoop, number>;

/**
 * Loops between agents. A human decision resets these — product/04: "A human decision resets the
 * agent-to-agent iteration counter (Paperclip)" — while `human_rounds` counts the human's own
 * rounds and is therefore never reset by one.
 */
export const AGENT_ITERATION_LOOPS = [
  'code_review',
  'business_review',
  'ci_fix',
  'refinement_questions',
  'architecture_revisions',
  'rebase',
  // A human decision refills it for the same reason it refills the others: the budget exists to
  // stop the *machine* looping, and a human who has just looked at the task has ended that concern.
  'rebase_rechecks',
] as const satisfies readonly IterationLoop[];

export type IterationCounters = Readonly<Partial<Record<IterationLoop, number>>>;

/**
 * Effective limits for a task.
 *
 * @param limits the `pipeline.limits` block of the effective configuration
 * @param humanRounds the autonomy preset's "human MR rounds before escalation" (product/19 §11),
 *   used when the configuration does not set `human_rounds` explicitly
 */
export const resolveIterationLimits = (
  limits?: PipelineLimits,
  humanRounds?: number,
): IterationLimits => ({
  code_review: limits?.code_review_iterations ?? DEFAULT_ITERATION_LIMITS.code_review,
  business_review: limits?.business_review_iterations ?? DEFAULT_ITERATION_LIMITS.business_review,
  ci_fix: limits?.ci_fix_iterations ?? DEFAULT_ITERATION_LIMITS.ci_fix,
  human_rounds: limits?.human_rounds ?? humanRounds ?? DEFAULT_ITERATION_LIMITS.human_rounds,
  refinement_questions: DEFAULT_ITERATION_LIMITS.refinement_questions,
  architecture_revisions: DEFAULT_ITERATION_LIMITS.architecture_revisions,
  rebase: limits?.rebase_attempts ?? DEFAULT_ITERATION_LIMITS.rebase,
  rebase_rechecks: limits?.rebase_rechecks ?? DEFAULT_ITERATION_LIMITS.rebase_rechecks,
});

export interface IterationDecision {
  /** False when the loop has already run its course and the task must escalate instead. */
  readonly allowed: boolean;
  /** The counter value after this iteration, when it is allowed. */
  readonly next: number;
  readonly current: number;
  readonly limit: number;
}

/**
 * May the task go round `loop` once more?
 *
 * With the default limit of 3 for code review, three returns are allowed (counter 1, 2, 3) and
 * the fourth escalates — "exceeding any limit moves the task to Needs human", so the limit itself
 * is reachable.
 */
export const evaluateIteration = (
  counters: IterationCounters,
  loop: IterationLoop,
  limits: IterationLimits,
): IterationDecision => {
  const current = counters[loop] ?? 0;
  const limit = limits[loop];
  return { allowed: current < limit, next: current + 1, current, limit };
};

/** The counters with `loop` incremented. Other counters are untouched. */
export const incrementIteration = (
  counters: IterationCounters,
  loop: IterationLoop,
): IterationCounters => ({ ...counters, [loop]: (counters[loop] ?? 0) + 1 });

/**
 * Zeroes the agent-to-agent counters after a human decision (product/04, BD-007). `human_rounds`
 * survives, otherwise a human could loop with the agent forever by construction.
 */
export const resetAgentIterations = (counters: IterationCounters): IterationCounters => {
  const next: Partial<Record<IterationLoop, number>> = { ...counters };
  for (const loop of AGENT_ITERATION_LOOPS) {
    if (next[loop] !== undefined) {
      next[loop] = 0;
    }
  }
  return next;
};

/**
 * Convergence detection (product/04 S5): "if a re-review reports the same findings as the
 * previous round, stop immediately and escalate instead of burning the remaining iterations".
 *
 * `signature` is a caller-computed digest of the round's findings — the domain does not care how
 * it is produced, only that identical rounds produce identical signatures.
 */
export const isRepeatOfPreviousRound = (history: readonly string[], signature: string): boolean =>
  history.length > 0 && history[history.length - 1] === signature;

/**
 * CI convergence (product/04 S4): "Three identical failures in a row stop the loop early."
 * `history` is oldest-first and already includes the newest failure.
 */
export const hasIdenticalFailureStreak = (history: readonly string[], streak = 3): boolean => {
  if (streak <= 0 || history.length < streak) {
    return false;
  }
  const tail = history.slice(history.length - streak);
  return tail.every((entry) => entry === tail[0]);
};
