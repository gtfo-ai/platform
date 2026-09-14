/**
 * product/19 §16's arithmetic, as pure functions — the caps, the exclusion and the calendar.
 *
 * > *"Minutes derived from events, never from tracking: review = from the first human MR activity
 * > (comment, approval, review start) to merge or last activity, capped at 8 h per calendar day and
 * > excluding gaps > 2 h; question = asked → answered, capped at 30 min per question (reading +
 * > answering); approval = 10 min flat; steer = 5 min flat per steer."*
 *
 * ## Why this is in the application ring rather than in `packages/domain`
 *
 * The same reason `cost/window.ts` gives: the zone arithmetic is `scheduling/zoned-time.ts`, which
 * is here because the working-day calendar needed it first, and a second calendar is how two
 * features stop agreeing about when a day turned (standing rule 9). Nothing below reads a clock, a
 * database or the network — every instant and the zone are arguments — so the placement is about
 * where the helper lives, not about purity.
 *
 * ## The three judgements this file makes, because the document does not
 *
 * 1. **The daily cap is applied per entry, over the calendar days that entry spans**, not per
 *    (user, day) across a task or across the platform. A cross-row cap needs a bucket key, and the
 *    only key available for review minutes on a default instance is `user_id: null` — which would
 *    clamp *every unmapped reviewer in the organisation* to one shared 8 h a day, and would make a
 *    task's total depend on the order the projector happened to see other tasks' events. Per entry
 *    the cap is stateless, order-independent and idempotent, which is what a projection replayed
 *    from the log needs. **The residual, stated:** one person reviewing two tasks on one day can be
 *    credited more than 8 h that day. The gap rule is what keeps that bounded in practice — a
 *    window only grows while somebody is actually writing every two hours.
 * 2. **Equality is inside the window.** *"excluding gaps > 2 h"* excludes a gap **greater** than two
 *    hours, so a gap of exactly two hours continues the window, and *"capped at 8 h"* admits exactly
 *    eight. Both are asserted at the value and one unit past it.
 * 3. **A negative interval is zero, never negative.** Two events can arrive with `occurred_at` going
 *    backwards (a provider's clock, a replay of an older range beside live traffic). Minutes that
 *    went backwards are not work, and a negative number in this column would subtract from a task's
 *    total — so it is clamped, and the projector refuses to *move* a window backwards at all.
 */
import {
  isoDateOf,
  nextIsoDate,
  parseIsoDate,
  zonedParts,
  zonedTimeToInstant,
} from '../scheduling/zoned-time.js';

/** product/19 §16: *"excluding gaps > 2 h"*. */
export const REVIEW_GAP_LIMIT_MINUTES = 120;
/** product/19 §16: *"capped at 8 h per calendar day"*. */
export const REVIEW_DAILY_CAP_MINUTES = 8 * 60;
/** product/19 §16: *"question = asked → answered, capped at 30 min per question"*. */
export const QUESTION_CAP_MINUTES = 30;
/** product/19 §16: *"approval = 10 min flat"*. */
export const APPROVAL_FLAT_MINUTES = 10;
/** product/19 §16: *"steer = 5 min flat per steer"*. */
export const STEER_FLAT_MINUTES = 5;

const MS_PER_MINUTE = 60_000;

/**
 * `human_time_entries.minutes` is `numeric(10,2)`, so the fold rounds where the column does.
 *
 * Rounding here rather than letting PostgreSQL do it keeps one claim true in both directions: what
 * the projector computed and what a later reader sums are the same number, so a backfill and a live
 * dispatch produce **equal rows** rather than rows that differ in the second decimal.
 */
export const roundMinutes = (value: number): number => Math.round(value * 100) / 100;

const parseInstant = (value: string, label: string): number => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`${label}: ${JSON.stringify(value)} is not a parsable timestamp`);
  }
  return ms;
};

/** Local midnight opening `day`, as an epoch millisecond. */
const midnightMs = (day: string, timezone: string): number =>
  zonedTimeToInstant({ ...parseIsoDate(day), hour: 0, minute: 0, second: 0 }, timezone).getTime();

/** Elapsed minutes between two instants, clamped at zero (judgement 3). */
export const elapsedMinutes = (from: string, to: string): number => {
  const start = parseInstant(from, 'elapsedMinutes');
  const end = parseInstant(to, 'elapsedMinutes');
  return end <= start ? 0 : roundMinutes((end - start) / MS_PER_MINUTE);
};

/**
 * Does activity at `at` continue the window whose last activity was `lastActivity`?
 *
 * *"excluding gaps > 2 h"* — so exactly two hours continues it and two hours and a second does not
 * (judgement 2). Activity *before* the window's end continues it trivially: it is already inside.
 * The elapsed value is `roundMinutes`-ed first, so a gap of two hours and a fraction of a minute
 * below the rounding step still continues the window; the bound is asserted one whole second past.
 */
export const continuesWindow = (lastActivity: string, at: string): boolean =>
  elapsedMinutes(lastActivity, at) <= REVIEW_GAP_LIMIT_MINUTES;

/** A question's minutes: asked → answered, capped at 30 (reading + answering). */
export const questionMinutes = (askedAt: string, answeredAt: string): number =>
  Math.min(elapsedMinutes(askedAt, answeredAt), QUESTION_CAP_MINUTES);

/**
 * A review window's minutes: the wall clock from its first activity to its last, with **each
 * calendar day capped at 8 h** in `timezone` (judgement 1).
 *
 * A window inside one day is `min(elapsed, 480)`. A window that crosses local midnight is split at
 * the boundary and each part capped on its own, so three days of continuous activity are 24 h and
 * not 72 — which is what *"per calendar day"* says, and is the only reading under which the cap
 * means anything for a window longer than a day.
 *
 * The loop is bounded by the window's own span in days, and the span cannot grow without real
 * activity at least every two hours ({@link continuesWindow}) — there is no input to this function
 * that a stalled projector could stretch.
 */
export const reviewMinutes = (startedAt: string, endedAt: string, timezone: string): number => {
  const start = parseInstant(startedAt, 'reviewMinutes');
  const end = parseInstant(endedAt, 'reviewMinutes');
  if (end <= start) {
    return 0;
  }
  let total = 0;
  let day = isoDateOf(zonedParts(new Date(start), timezone));
  const lastDay = isoDateOf(zonedParts(new Date(end), timezone));
  for (;;) {
    // Both boundaries are computed from the zone's own calendar rather than by adding 24 hours: a
    // day containing a DST transition is 23 or 25 hours long, and an assumed 24 would put an hour
    // of one day's cap into the next.
    const dayStart = midnightMs(day, timezone);
    const dayEnd = midnightMs(nextIsoDate(day), timezone);
    const slice = Math.min(end, dayEnd) - Math.max(start, dayStart);
    if (slice > 0) {
      total += Math.min(slice / MS_PER_MINUTE, REVIEW_DAILY_CAP_MINUTES);
    }
    if (day === lastDay) {
      return roundMinutes(total);
    }
    day = nextIsoDate(day);
  }
};
