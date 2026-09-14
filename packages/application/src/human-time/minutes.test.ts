/**
 * product/19 §16's caps and its one exclusion, each asserted **at the value and one unit past it**
 * (standing rule 42).
 *
 * That pairing is the whole point of this file: a fold that always clamped to the cap would pass a
 * test that only checked the over-cap case, and a fold that never clamped would pass one that only
 * checked the under-cap case. Every boundary below therefore has three points — inside, exactly at,
 * and past — and "one unit" is the smallest unit the producer can express: a second for the gap and
 * the caps, because every instant in this platform is an ISO timestamp with milliseconds and the
 * events that carry them are seconds apart at best.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_FLAT_MINUTES,
  continuesWindow,
  elapsedMinutes,
  QUESTION_CAP_MINUTES,
  questionMinutes,
  REVIEW_DAILY_CAP_MINUTES,
  REVIEW_GAP_LIMIT_MINUTES,
  reviewMinutes,
  roundMinutes,
  STEER_FLAT_MINUTES,
} from './minutes.js';

const at = (iso: string): string => iso;

/** `2026-06-01T09:00:00Z` plus `minutes`, as an ISO instant. */
const after = (minutes: number, seconds = 0): string =>
  new Date(
    Date.parse('2026-06-01T09:00:00.000Z') + minutes * 60_000 + seconds * 1_000,
  ).toISOString();

describe('the constants are product/19 §16’s own numbers', () => {
  it('carries the four the document states', () => {
    // Restated rather than derived, because these five numbers *are* the specification: a change to
    // one of them is a product decision and must fail a test that names the document.
    expect({
      gap: REVIEW_GAP_LIMIT_MINUTES,
      daily: REVIEW_DAILY_CAP_MINUTES,
      question: QUESTION_CAP_MINUTES,
      approval: APPROVAL_FLAT_MINUTES,
      steer: STEER_FLAT_MINUTES,
    }).toEqual({ gap: 120, daily: 480, question: 30, approval: 10, steer: 5 });
  });
});

describe('“excluding gaps > 2 h”', () => {
  it('continues a window one unit inside the limit', () => {
    expect(continuesWindow(at('2026-06-01T09:00:00.000Z'), after(119, 59))).toBe(true);
  });

  it('continues a window at exactly two hours, because the exclusion is “greater than”', () => {
    expect(continuesWindow(at('2026-06-01T09:00:00.000Z'), after(120))).toBe(true);
  });

  it('breaks the window one second past two hours', () => {
    expect(continuesWindow(at('2026-06-01T09:00:00.000Z'), after(120, 1))).toBe(false);
  });
});

describe('“question … capped at 30 min per question”', () => {
  it('measures a question answered inside the cap', () => {
    expect(questionMinutes('2026-06-01T09:00:00.000Z', after(29))).toBe(29);
  });

  it('measures exactly the cap at exactly the cap', () => {
    expect(questionMinutes('2026-06-01T09:00:00.000Z', after(30))).toBe(30);
  });

  it('caps a question that took a week, at 30', () => {
    expect(questionMinutes('2026-06-01T09:00:00.000Z', after(30, 1))).toBe(30);
    expect(questionMinutes('2026-06-01T09:00:00.000Z', after(7 * 24 * 60))).toBe(30);
  });

  it('is zero, never negative, for an answer that precedes its question', () => {
    // A clock that went backwards is not work, and a negative here would *subtract* from the task's
    // total — the one direction a projection must never move.
    expect(questionMinutes('2026-06-01T09:00:00.000Z', after(-10))).toBe(0);
    expect(elapsedMinutes('2026-06-01T09:00:00.000Z', after(-10))).toBe(0);
  });
});

describe('“capped at 8 h per calendar day”', () => {
  const utc = 'UTC';

  it('measures a window one minute inside the cap', () => {
    expect(reviewMinutes('2026-06-01T09:00:00.000Z', after(479), utc)).toBe(479);
  });

  it('measures exactly eight hours at exactly eight hours', () => {
    expect(reviewMinutes('2026-06-01T09:00:00.000Z', after(480), utc)).toBe(480);
  });

  it('caps a window one minute past eight hours', () => {
    expect(reviewMinutes('2026-06-01T09:00:00.000Z', after(481), utc)).toBe(480);
  });

  it('caps each calendar day separately, so two days are 16 h and not 24', () => {
    // 09:00 on the 1st to 09:00 on the 3rd is 48 hours of wall clock over three calendar days:
    // 15 h on the 1st (capped to 8), 24 h on the 2nd (capped to 8) and 9 h on the 3rd (capped to 8).
    expect(reviewMinutes('2026-06-01T09:00:00.000Z', '2026-06-03T09:00:00.000Z', utc)).toBe(
      3 * REVIEW_DAILY_CAP_MINUTES,
    );
    // And a window that crosses one midnight with little on each side is **not** capped: 23:30 to
    // 00:30 is one hour, which is the case a per-window cap would get right and a per-day cap
    // applied to the whole window would too — so the day either side is asserted as well.
    expect(reviewMinutes('2026-06-01T23:30:00.000Z', '2026-06-02T00:30:00.000Z', utc)).toBe(60);
  });

  it('reads the calendar in the organisation’s zone, not in UTC', () => {
    // 09:00 → 23:00 UTC is fourteen hours inside **one** UTC day, so the cap takes it to 8 h. The
    // same instants in Europe/Prague (UTC+2 in June) are 11:00 on the 1st to 01:00 on the 2nd —
    // **two** calendar days, 13 h capped to 8 plus one hour. The two answers differ, which is what
    // makes this an assertion about the zone rather than about the cap.
    expect(reviewMinutes('2026-06-01T09:00:00.000Z', '2026-06-01T23:00:00.000Z', 'UTC')).toBe(
      REVIEW_DAILY_CAP_MINUTES,
    );
    expect(
      reviewMinutes('2026-06-01T09:00:00.000Z', '2026-06-01T23:00:00.000Z', 'Europe/Prague'),
    ).toBe(REVIEW_DAILY_CAP_MINUTES + 60);
  });

  it('splits a day containing a DST transition on the zone’s calendar, not on 24 hours', () => {
    /**
     * Europe/Prague springs forward at 02:00 local on 2026-03-29, so that local day is **23 hours**
     * and an implementation that ended it 24 hours after its midnight would overlap the next day.
     *
     * The window is three hours of wall clock across that boundary — 22:00 to 01:00 local — so the
     * answer must be **180** whatever the calendar does. A `dayStart + 24 h` boundary counts the
     * last hour **twice**, once in each day, and answers 240.
     *
     * **Canaried by mutation, on this tree** (standing rule 21): replacing `midnightMs(nextIsoDate
     * (day))` with `dayStart + 24 h` leaves this file at 16/16 green with the *earlier* shape of
     * this case — a window whose every day hit the 8 h cap, where the double count is invisible —
     * and fails here by name. Both days have to stay **under** the cap for the overlap to show,
     * which is the whole reason the window is three hours rather than a day and a half.
     */
    expect(
      reviewMinutes('2026-03-29T20:00:00.000Z', '2026-03-29T23:00:00.000Z', 'Europe/Prague'),
    ).toBe(180);
  });

  it('is zero for a window that has not moved, which is a measurement rather than an absence', () => {
    expect(reviewMinutes('2026-06-01T09:00:00.000Z', '2026-06-01T09:00:00.000Z', utc)).toBe(0);
  });
});

describe('an instant that is not one', () => {
  it('throws by name rather than folding NaN into a task’s total', () => {
    // The producer is the platform's own event log, so this is a defect and not an input: what it
    // must not do is propagate. `NaN` minutes would reach `numeric(10,2)` as an error the caller
    // sees three layers away — or, worse, as a row that makes every sum `NaN`.
    expect(() => elapsedMinutes('not a timestamp', '2026-06-01T09:00:00.000Z')).toThrow(TypeError);
    expect(() => reviewMinutes('2026-06-01T09:00:00.000Z', 'later on', 'UTC')).toThrow(
      /is not a parsable timestamp/,
    );
  });
});

describe('rounding', () => {
  it('rounds to the two decimals numeric(10,2) holds exactly', () => {
    // Not cosmetic: a value written and read back has to be the same number, or a backfill's rows
    // and a live dispatch's rows can never be compared for equality.
    expect(roundMinutes(1 / 3)).toBe(0.33);
    expect(elapsedMinutes('2026-06-01T09:00:00.000Z', '2026-06-01T09:00:20.000Z')).toBe(0.33);
  });
});
