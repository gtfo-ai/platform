/**
 * **The CI gate's wait on a poll-only git binding** (WP-136, the product owner's decision of
 * 2026-10-03; PROGRESS § "Architect ruling (M8 additions, session 11)").
 *
 * Every gate parks after {@link MAX_GATE_CHECKS} checks thirty seconds apart, and on a binding a
 * webhook reaches the pipeline's own `ci.pipeline.finished` settles the CI gate long before that
 * (`ci-settle.ts`). A **poll-only** binding receives no such event, so a pipeline longer than about
 * two and a half minutes parked every task. For that binding, and only at `ci_gate`, the bound is a
 * **time** instead of a count:
 *
 *  - **the clock** is the gate's current entry, `task_stages.entered_at`, read on every fire — so a
 *    lost or recovered job, a restart or a replay cannot extend it, and a hand-back at `ci_gate` is
 *    a new attempt with a fresh clock (an old attempt's job finds its row closed and does nothing);
 *  - **the timeout** is `pipeline.limits.ci_timeout_minutes` (10–1440, default 60), read at every
 *    evaluation;
 *  - **the cadence** is the gate's thirty seconds for the first {@link MAX_GATE_CHECKS} checks and
 *    {@link CI_WAIT_LATE_RECHECK_MS} after — at most sixty provider reads an hour per waiting task;
 *  - **the backstop** is a count, {@link ciWaitBackstopChecks}, so no chain is unbounded even if the
 *    clock were wrong (TD-004: a timer cannot be cancelled, and every fire re-validates).
 *
 * This module is the pure half — the decision and the brief; `jobs.ts` reads the entry, applies the
 * decision and settles. A resume of a task paused at the gate is **not** a new entry (a pause closes
 * no `task_stages` row), so its clock keeps running; a hand-back at `ci_gate` is the fresh one.
 */
import { type CiWait, MAX_GATE_CHECKS } from './gates.js';

/**
 * The first checks' delay — the same thirty seconds as `jobs.ts`' `GATE_RECHECK_MS`, stated here
 * rather than imported because `jobs.ts` imports this module (`ci-wait.test.ts` holds them equal).
 */
export const CI_WAIT_EARLY_RECHECK_MS = 30_000;

/** The delay after the first {@link MAX_GATE_CHECKS} checks: one provider read a minute. */
export const CI_WAIT_LATE_RECHECK_MS = 60_000;

const MINUTE_MS = 60_000;

/**
 * The backstop count — `ceil(timeout / 60 s) + 5`, the ruling's: one more than the checks the
 * cadence can make before the clock runs out, so it is reached only if the clock were wrong.
 */
export const ciWaitBackstopChecks = (timeoutMinutes: number): number =>
  Math.ceil((timeoutMinutes * MINUTE_MS) / CI_WAIT_LATE_RECHECK_MS) + MAX_GATE_CHECKS;

export type CiWaitDecision =
  | { readonly kind: 'recheck'; readonly delayMs: number }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'backstop'; readonly limit: number };

/**
 * What a pending CI read on a poll-only binding does next. `checks` is this fire's count (the
 * first evaluation is 1). An instant that does not parse is **not** "within the timeout" (standing
 * rule 16): `NaN` fails the comparison and the gate parks rather than waiting for ever.
 */
export const decideCiWait = (input: {
  readonly enteredAtMs: number;
  readonly nowMs: number;
  readonly checks: number;
  readonly timeoutMinutes: number;
}): CiWaitDecision => {
  const elapsedMs = input.nowMs - input.enteredAtMs;
  if (!(elapsedMs < input.timeoutMinutes * MINUTE_MS)) {
    return { kind: 'timed_out' };
  }
  const limit = ciWaitBackstopChecks(input.timeoutMinutes);
  if (!(input.checks < limit)) {
    return { kind: 'backstop', limit };
  }
  return {
    kind: 'recheck',
    delayMs: input.checks < MAX_GATE_CHECKS ? CI_WAIT_EARLY_RECHECK_MS : CI_WAIT_LATE_RECHECK_MS,
  };
};

/** What the gate saw, in the brief's words. */
const sawWhat = (wait: CiWait): string =>
  wait.pipeline === null
    ? 'had no pipeline: no pipeline has started for the head commit'
    : `was still ${wait.pipeline.status} (pipeline ${wait.pipeline.id})`;

/**
 * A `manual` pipeline waits for a person to start a job, so it never finishes by itself — the
 * timeout's brief says so (WP-136 criterion 1; `manual` is what the GitLab adapter maps GitLab's
 * `manual` to, while `created`, `waiting_for_resource`, `preparing`, `waiting_for_callback` and
 * `scheduled` read `pending` and `canceling` reads `running` — `gitlab/mapping.test.ts`).
 */
const manualNote = (wait: CiWait): string =>
  wait.pipeline?.status === 'manual'
    ? ' A manual pipeline does not finish by itself: it waits for someone to start its manual job.'
    : '';

const timeoutKey = (wait: CiWait): string =>
  `pipeline.limits.ci_timeout_minutes = ${String(wait.timeoutMinutes)}`;

/** The escalation's reason — what the gate's row and the `task.escalated` event carry. */
export const ciWaitReason = (
  wait: CiWait,
  decision: Exclude<CiWaitDecision, { kind: 'recheck' }>,
  checks: number,
): string =>
  decision.kind === 'timed_out'
    ? `the CI gate on a poll-only ${wait.provider} binding timed out: the merge request ${sawWhat(wait)} after ${String(wait.timeoutMinutes)} minutes (${timeoutKey(wait)})`
    : `the CI gate on a poll-only ${wait.provider} binding stopped at its backstop of ${String(decision.limit)} checks before its clock reached ${String(wait.timeoutMinutes)} minutes (${timeoutKey(wait)}); the merge request ${sawWhat(wait)} at check ${String(checks)}`;

/**
 * The brief a person reads on the task page — the ruling's (e) sentence, with the provider's id
 * where the ruling says "GitLab" (the pipeline does not know which provider it talks to, BD-017).
 */
export const ciWaitBrief = (
  wait: CiWait,
  decision: Exclude<CiWaitDecision, { kind: 'recheck' }>,
  checks: number,
): string => {
  const what =
    wait.pipeline === null
      ? `No CI pipeline has started for the head commit of this merge request after ${String(wait.timeoutMinutes)} minutes`
      : `The CI pipeline ${wait.pipeline.id} for this merge request was still ${wait.pipeline.status} after ${String(wait.timeoutMinutes)} minutes`;
  const head =
    decision.kind === 'timed_out'
      ? `${what} — the CI timeout (\`${timeoutKey(wait)}\`).`
      : `The CI gate stopped after ${String(checks)} checks, its backstop, before its clock reached the CI timeout (\`${timeoutKey(wait)}\`); ${wait.pipeline === null ? 'no pipeline had started for the head commit' : `pipeline ${wait.pipeline.id} was still ${wait.pipeline.status}`}.`;
  return (
    `${head} This project's ${wait.provider} binding is poll-only, so the platform asked ${wait.provider} every minute rather than waiting for a webhook.` +
    `${manualNote(wait)} Look at the pipeline; when it has finished, hand the task back at ci_gate. If pipelines here routinely take longer, raise ci_timeout_minutes.`
  );
};
