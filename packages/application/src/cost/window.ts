/**
 * Which budget window an instant falls in — BD-010, product/09: *"Windows are in the organisation
 * timezone (setting, default from the container `TZ`, fallback UTC), reset at boundary."* (Q12).
 *
 * It lives in the application ring rather than in `packages/domain` for one reason: the zone
 * arithmetic is `scheduling/zoned-time.ts`, which is here because the working-day calendar needed
 * it first. Nothing below reads a clock or a database — the instant and the zone are arguments — so
 * the placement is about where the helper lives, not about purity.
 *
 * A window is identified by its **start instant**, which is what `budget_windows.window_start`
 * stores. That makes the rollover implicit: a cost entry that lands after the boundary computes a
 * different start, so it folds into a fresh row with a fresh `notified_pct`, and no job has to have
 * run for the new window to be correct. `budget.window.reset` (TD-004's cron queue) therefore has
 * nothing to do with *correctness* here; it exists to announce the rollover, and this build does
 * not run it (PROGRESS, WP-19).
 */
import type { BudgetWindow, IsoDateTime } from '@platform/contracts';
import {
  assertTimeZone,
  isoDateOf,
  isValidTimeZone,
  zonedParts,
  zonedTimeToInstant,
} from '../scheduling/zoned-time.js';

/** BD-010/Q12: the organisation's zone, and UTC when it has none — or none this runtime can use. */
export const DEFAULT_BUDGET_TIMEZONE = 'UTC';

export interface ResolvedBudgetTimezone {
  readonly timezone: string;
  /** True when the configured value was refused and UTC was put in its place. */
  readonly substituted: boolean;
}

/**
 * Which zone the budget calendar is actually read in — **one decision, three consumers**.
 *
 * `budgetWindowStart` *refuses* a zone it cannot do DST arithmetic in, and that refusal is right for
 * the calculation and wrong for every caller: the ledger would park a run stream (rule 20), the stage
 * executor's admission would fail a job into a retry loop, and the budgets read would answer 500 —
 * three different failures from one bad character in a settings field, in the one case the fallback
 * exists for. So the substitution is decided here and each caller reports it in its own register: the
 * ledger logs a warning by name, the read serves the substituted window, the guard simply does not
 * block on a calendar it could not compute.
 *
 * `null` (unset) and "unusable" are deliberately **not** the same answer to a reader — the first is
 * Q12's documented default and the second is a misconfiguration — which is why `substituted` is a
 * field rather than a comparison against the constant.
 */
export const resolveBudgetTimezone = (configured: string | null): ResolvedBudgetTimezone => {
  if (configured === null || configured.trim() === '') {
    return { timezone: DEFAULT_BUDGET_TIMEZONE, substituted: false };
  }
  return isValidTimeZone(configured)
    ? { timezone: configured, substituted: false }
    : { timezone: DEFAULT_BUDGET_TIMEZONE, substituted: true };
};

/**
 * The start of the `total` window: a budget that never rolls over.
 *
 * A constant rather than `null` because `budget_windows`' primary key is `(budget_id,
 * window_start)` and a nullable key column would let two rows exist for one never-ending window.
 * The Unix epoch is the earliest instant the platform will ever record spend after.
 */
export const TOTAL_WINDOW_START = '1970-01-01T00:00:00.000Z' as IsoDateTime;

const midnight = (
  parts: { readonly year: number; readonly month: number; readonly day: number },
  timezone: string,
): IsoDateTime =>
  zonedTimeToInstant(
    { ...parts, hour: 0, minute: 0, second: 0 },
    timezone,
  ).toISOString() as IsoDateTime;

/**
 * The instant the window containing `at` began, in `timezone`.
 *
 * Weeks start on **Monday**, which is what `zonedParts.weekday` counts from (ISO-8601) and what
 * every other calendar in this repository uses (`scheduling/working-calendar.ts`).
 *
 * @throws when `timezone` is not an IANA zone this runtime knows (`assertTimeZone`'s rules: a fixed
 * offset is refused, because a window computed from one is an hour wrong for half the year).
 */
export const budgetWindowStart = (
  window: BudgetWindow,
  at: IsoDateTime,
  timezone: string,
): IsoDateTime => {
  if (window === 'total') {
    return TOTAL_WINDOW_START;
  }
  assertTimeZone(timezone);
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError(`budgetWindowStart: "${at}" is not a parsable timestamp`);
  }
  const parts = zonedParts(instant, timezone);
  switch (window) {
    case 'day':
      return midnight(parts, timezone);
    case 'month':
      return midnight({ ...parts, day: 1 }, timezone);
    case 'week': {
      // Back up to Monday by whole days in the zone's own calendar, so a week that contains a DST
      // transition still starts at local midnight rather than 23:00 the evening before.
      const start = midnight(parts, timezone);
      const daysBack = parts.weekday - 1;
      if (daysBack === 0) {
        return start;
      }
      const shifted = new Date(Date.parse(start) - daysBack * 24 * 60 * 60_000);
      return midnight(zonedParts(shifted, timezone), timezone);
    }
  }
};

/**
 * The `cost_rollup_daily.day` an instant belongs to — the same calendar the budget windows use.
 *
 * One timezone for both, deliberately: a dashboard that shows "today's spend" from the rollup and a
 * budget that blocks at midnight must agree on when the day turned, and two calendars in one
 * feature is how they stop agreeing (standing rule 9 — an obligation two paths can discharge needs
 * one arbiter).
 */
export const rollupDay = (at: IsoDateTime, timezone: string): string => {
  assertTimeZone(timezone);
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError(`rollupDay: "${at}" is not a parsable timestamp`);
  }
  return isoDateOf(zonedParts(instant, timezone));
};
