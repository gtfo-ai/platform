/**
 * **The CI gate's wait for a pipeline** (WP-136, the product owner's decision of 2026-10-03;
 * PROGRESS § "Architect ruling (M8 additions, session 11)"; widened 2026-11-26).
 *
 * Every other gate parks after {@link MAX_GATE_CHECKS} checks thirty seconds apart, so a pipeline
 * longer than about two and a half minutes parked every task. WP-136 gave a **poll-only** binding a
 * time bound on the assumption that a webhook's `ci.pipeline.finished` settles the gate long before
 * the five checks on any other binding; fontai's GO-705 (2026-11-26) measured that false — parked at
 * 2 min 08 s, its pipeline's `failed` webhook arrived nine minutes later. So at `ci_gate`, on **every**
 * git binding (poll-only, webhook, or no poll plan), the bound is a **time** instead of a count; on a
 * binding a webhook reaches the recheck is the safety net for a lost delivery, and the delivery
 * still settles the gate the moment it arrives (`ci-settle.ts`):
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
 * **A pipeline that is still running at the timeout is not a reason to call a person** (BD-034, the
 * product owner's rule of 2026-11-26: *anything the platform can recover from by itself must not
 * escalate*). When the clock reaches the timeout and the last read saw a pipeline that is `pending` or
 * `running` — it is progressing, and its own ending will settle the gate (or send a failure to the
 * CI-fix loop) — the gate keeps waiting **overtime**: one read every {@link CI_WAIT_OVERTIME_RECHECK_MS}
 * until {@link ciWaitCeilingMinutes} from the entry. Only a pipeline that does not finish by itself
 * (`manual`: a person must start a job), no pipeline at all, or the ceiling parks the task — and the
 * ceiling's brief says how long the platform waited and how often it asked.
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

/**
 * The delay between reads once the timeout has passed on a pipeline that is still progressing
 * (BD-034): five minutes — at most twelve provider reads an hour for a task waiting overtime.
 */
export const CI_WAIT_OVERTIME_RECHECK_MS = 5 * 60_000;

/**
 * How long, from the gate's entry, the CI gate waits for a pipeline that is still `pending` or
 * `running` (BD-034): a day, or the configured timeout when that is longer. A real pipeline ends
 * well inside it — GitLab's own job timeout defaults to an hour — so reaching it means the pipeline
 * is stuck (a runner that never picks it up), which a person has to look at.
 */
export const CI_WAIT_CEILING_MINUTES = 24 * 60;

const MINUTE_MS = 60_000;

/** The overtime's end, in minutes from the entry: {@link CI_WAIT_CEILING_MINUTES} or the timeout. */
export const ciWaitCeilingMinutes = (timeoutMinutes: number): number =>
  Math.max(CI_WAIT_CEILING_MINUTES, timeoutMinutes);

/**
 * The backstop count — the checks the cadence can make before the ceiling, plus the first five: one
 * minute apart up to the timeout (`ceil(timeout / 60 s) + 5`, the ruling's), then five minutes
 * apart up to the ceiling (BD-034). It is reached only if the clock were wrong.
 */
export const ciWaitBackstopChecks = (timeoutMinutes: number): number =>
  Math.ceil((timeoutMinutes * MINUTE_MS) / CI_WAIT_LATE_RECHECK_MS) +
  MAX_GATE_CHECKS +
  Math.ceil(
    ((ciWaitCeilingMinutes(timeoutMinutes) - timeoutMinutes) * MINUTE_MS) /
      CI_WAIT_OVERTIME_RECHECK_MS,
  );

/**
 * Is this pipeline still on its way to an ending of its own (BD-034)? `pending` (queued for a
 * runner, created, scheduled) and `running` are; `manual` waits for a person and is not.
 */
export const isProgressingPipeline = (pipeline: CiWait['pipeline']): boolean =>
  pipeline !== null && (pipeline.status === 'pending' || pipeline.status === 'running');

export type CiWaitDecision =
  | { readonly kind: 'recheck'; readonly delayMs: number; readonly overtime?: true }
  | { readonly kind: 'timed_out' }
  | { readonly kind: 'ceiling'; readonly minutes: number }
  | { readonly kind: 'backstop'; readonly limit: number };

/**
 * What a pending CI read does next. `checks` is this fire's count (the
 * first evaluation is 1). An instant that does not parse is **not** "within the timeout" (standing
 * rule 16): `NaN` fails the comparison and the gate parks rather than waiting for ever.
 *
 * `progressing` is {@link isProgressingPipeline} of the read this fire made: past the timeout, a
 * progressing pipeline is waited for overtime (BD-034) up to the ceiling, and anything else times
 * out as before.
 */
export const decideCiWait = (input: {
  readonly enteredAtMs: number;
  readonly nowMs: number;
  readonly checks: number;
  readonly timeoutMinutes: number;
  readonly progressing?: boolean;
}): CiWaitDecision => {
  const elapsedMs = input.nowMs - input.enteredAtMs;
  const limit = ciWaitBackstopChecks(input.timeoutMinutes);
  if (!(elapsedMs < input.timeoutMinutes * MINUTE_MS)) {
    if (input.progressing !== true || Number.isNaN(elapsedMs)) {
      return { kind: 'timed_out' };
    }
    const ceiling = ciWaitCeilingMinutes(input.timeoutMinutes);
    if (!(elapsedMs < ceiling * MINUTE_MS)) {
      return { kind: 'ceiling', minutes: ceiling };
    }
    if (!(input.checks < limit)) {
      return { kind: 'backstop', limit };
    }
    // The last overtime read is moved up to the ceiling rather than a step past it.
    return {
      kind: 'recheck',
      delayMs: Math.min(CI_WAIT_OVERTIME_RECHECK_MS, ceiling * MINUTE_MS - elapsedMs),
      overtime: true,
    };
  }
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

/** "a poll-only gitlab binding" or "a gitlab binding" — the reason's words for the binding. */
const bindingWords = (wait: CiWait): string =>
  `${wait.pollOnly ? 'a poll-only ' : 'a '}${wait.provider} binding`;

/** The escalation's reason — what the gate's row and the `task.escalated` event carry. */
export const ciWaitReason = (
  wait: CiWait,
  decision: Exclude<CiWaitDecision, { kind: 'recheck' }>,
  checks: number,
): string =>
  decision.kind === 'timed_out'
    ? `the CI gate on ${bindingWords(wait)} timed out: the merge request ${sawWhat(wait)} after ${String(wait.timeoutMinutes)} minutes (${timeoutKey(wait)})`
    : decision.kind === 'ceiling'
      ? `the CI gate on ${bindingWords(wait)} waited ${String(decision.minutes)} minutes, past its CI timeout of ${String(wait.timeoutMinutes)} because the pipeline was still progressing, and stopped at its ceiling: the merge request ${sawWhat(wait)} at check ${String(checks)}`
      : `the CI gate on ${bindingWords(wait)} stopped at its backstop of ${String(decision.limit)} checks before its clock reached ${String(wait.timeoutMinutes)} minutes (${timeoutKey(wait)}); the merge request ${sawWhat(wait)} at check ${String(checks)}`;

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
  if (decision.kind === 'ceiling') {
    const pipeline =
      wait.pipeline === null
        ? 'No CI pipeline had started for the head commit'
        : `The CI pipeline ${wait.pipeline.id} for this merge request was still ${wait.pipeline.status}`;
    return (
      `${pipeline} after ${String(decision.minutes)} minutes. The platform waited past the CI timeout (\`${timeoutKey(wait)}\`) because the pipeline was still progressing, reading it every minute up to the timeout and every ${String(CI_WAIT_OVERTIME_RECHECK_MS / MINUTE_MS)} minutes after, ${String(checks)} reads in all, and no pipeline event settled it. ` +
      'A pipeline that has not finished in this long is stuck — usually no runner picks up its jobs. Look at the pipeline; when it has finished, hand the task back at ci_gate.'
    );
  }
  const head =
    decision.kind === 'timed_out'
      ? `${what} — the CI timeout (\`${timeoutKey(wait)}\`).`
      : `The CI gate stopped after ${String(checks)} checks, its backstop, before its clock reached the CI timeout (\`${timeoutKey(wait)}\`); ${wait.pipeline === null ? 'no pipeline had started for the head commit' : `pipeline ${wait.pipeline.id} was still ${wait.pipeline.status}`}.`;
  const how = wait.pollOnly
    ? `This project's ${wait.provider} binding is poll-only, so the platform asked ${wait.provider} every minute rather than waiting for a webhook.`
    : `No pipeline event from ${wait.provider} settled it, and the platform's own check every minute still read it unfinished.`;
  return (
    `${head} ${how}` +
    `${manualNote(wait)} Look at the pipeline; when it has finished, hand the task back at ci_gate. If pipelines here routinely take longer, raise ci_timeout_minutes.`
  );
};
