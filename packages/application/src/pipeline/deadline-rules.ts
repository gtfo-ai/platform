/**
 * The deadline **rules** of WP-56 — what a deadline is, as a pure function of the calendar, the
 * project's configuration and the instant the clock starts.
 *
 * A module of its own, apart from `deadlines.ts` (the arming handler and the timer), because the
 * three places that *create* a deadline — the stage executor, the dependency gate and the two
 * approval gates in the saga — need the rule and nothing else, and `deadlines.ts` imports the
 * expiry commands: keeping the rule here keeps those modules out of a cycle through `commands.ts`.
 */
import type { IsoDateTime } from '@platform/contracts';
import type { ConfigValues, DeadlineRule } from '@platform/domain';
import {
  DEFAULT_QUESTION_TIMEOUT,
  questionTimeoutAt,
  resolveDeadline,
  type WorkingCalendar,
} from '../scheduling/working-calendar.js';

/**
 * product/19 §19: *"a taken-over task escalates to `Needs human` after 5 working days of
 * inactivity"*. A constant rather than configuration because the product names no setting for it;
 * it is resolved on the same organisation calendar as every other deadline here.
 */
export const TAKE_OVER_INACTIVITY_TIMEOUT = '5 working days' as const;

/** `pipeline.limits.question_timeout` as the project configured it, or BD-006's default. */
export const questionTimeoutOf = (config: ConfigValues): string =>
  config.pipeline?.limits?.question_timeout ?? DEFAULT_QUESTION_TIMEOUT;

/**
 * The rule a question **and an approval** are created with: `questionTimeoutAt` over the
 * organisation's working calendar, at the project's `question_timeout`.
 *
 * Approvals share it on purpose — BD-006's Q95 amendment says an approval expires "on the same
 * working-day calendar as a question and at the same default … read from the template's limits,
 * never from a new dial cell". So there is no `approval_timeout` key, and a project that lengthens
 * its question timeout lengthens both.
 */
export const questionDeadlineRule =
  (calendar: WorkingCalendar, config: ConfigValues): DeadlineRule =>
  (from) =>
    questionTimeoutAt(
      calendar,
      new Date(from),
      questionTimeoutOf(config),
    ).toISOString() as IsoDateTime;

/** When a take-over taken at `takenAt` has been inactive for {@link TAKE_OVER_INACTIVITY_TIMEOUT}. */
export const takeOverDeadline = (calendar: WorkingCalendar, takenAt: IsoDateTime): IsoDateTime =>
  resolveDeadline(
    calendar,
    new Date(takenAt),
    TAKE_OVER_INACTIVITY_TIMEOUT,
  ).toISOString() as IsoDateTime;
