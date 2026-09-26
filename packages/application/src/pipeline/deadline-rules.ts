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
import type { DeadlineRule } from '@platform/domain';
import {
  DEFAULT_QUESTION_TIMEOUT,
  questionTimeoutAt,
  resolveDeadline,
  type WorkingCalendar,
} from '../scheduling/working-calendar.js';
import { autonomyPresetFor, type ProjectSettings } from './settings.js';

/**
 * product/19 §19: *"a taken-over task escalates to `Needs human` after 5 working days of
 * inactivity"*. A constant rather than configuration because the product names no setting for it;
 * it is resolved on the same organisation calendar as every other deadline here.
 */
export const TAKE_OVER_INACTIVITY_TIMEOUT = '5 working days' as const;

/**
 * The question timeout in force for a project (BD-006) — resolved in this order (WP-62, Q78):
 *
 * 1. `pipeline.limits.question_timeout` where the project's document sets it — the override;
 * 2. the dial's `questionTimeout`, off the project's **materialised** preset (BD-027:14), where the
 *    document is silent — backlog 72 (a)'s carrier, so the dial's value is no longer a copy nothing
 *    reads;
 * 3. BD-006's default, for a project whose dial was never materialised.
 *
 * `autonomyPresetFor` already folds (1) into the preset (`autonomyOverridesFromConfig`), so (1) and
 * (2) cannot disagree; the document key is written first here only so a never-materialised project
 * still honours its own override.
 */
export const questionTimeoutOf = (settings: ProjectSettings): string =>
  settings.config.pipeline?.limits?.question_timeout ??
  autonomyPresetFor(settings)?.questionTimeout ??
  DEFAULT_QUESTION_TIMEOUT;

/**
 * The rule a question **and an approval** are created with: `questionTimeoutAt` over the
 * organisation's working calendar, at the project's question timeout ({@link questionTimeoutOf}).
 *
 * Approvals share it on purpose — BD-006's Q95 amendment says an approval expires "on the same
 * working-day calendar as a question and at the same default … read from the template's limits,
 * never from a new dial cell". So there is no `approval_timeout` key, and a project that lengthens
 * its question timeout lengthens both.
 */
export const questionDeadlineRule =
  (calendar: WorkingCalendar, settings: ProjectSettings): DeadlineRule =>
  (from) =>
    questionTimeoutAt(
      calendar,
      new Date(from),
      questionTimeoutOf(settings),
    ).toISOString() as IsoDateTime;

/**
 * When a take-over whose holder was last active at `lastActivityAt` has been inactive for
 * {@link TAKE_OVER_INACTIVITY_TIMEOUT} — `TakeOverRecord.lastActivityAt`, the take-over itself or a
 * later command of the holder's (WP-44, PROGRESS backlog 167).
 */
export const takeOverDeadline = (
  calendar: WorkingCalendar,
  lastActivityAt: IsoDateTime,
): IsoDateTime =>
  resolveDeadline(
    calendar,
    new Date(lastActivityAt),
    TAKE_OVER_INACTIVITY_TIMEOUT,
  ).toISOString() as IsoDateTime;
