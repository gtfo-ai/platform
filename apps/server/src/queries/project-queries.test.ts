/**
 * `dayMinus`, which is the whole of `spent_usd_30d`'s window arithmetic.
 *
 * It is calendar arithmetic on the `YYYY-MM-DD` key `cost_rollup_daily` is written with, and that
 * is the point: the key was computed in the organisation's timezone by `rollupDay` (WP-19, Q12), so
 * subtracting thirty days from an *instant* would be subtracting from the wrong clock — and would
 * be off by an hour across a DST boundary, which moves the answer by a whole day whenever the
 * instant is inside the first hour of one.
 */
import { describe, expect, it } from 'vitest';
import { dayMinus, SPEND_WINDOW_DAYS } from './project-queries.js';

describe('dayMinus', () => {
  it('counts back in calendar days, across a month and a year boundary', () => {
    expect(dayMinus('2026-09-13', 0)).toBe('2026-09-13');
    expect(dayMinus('2026-09-13', 1)).toBe('2026-09-12');
    expect(dayMinus('2026-03-01', 1)).toBe('2026-02-28');
    expect(dayMinus('2026-01-01', 1)).toBe('2025-12-31');
    // A leap year, because February is where a day-count and a month-count disagree.
    expect(dayMinus('2028-03-01', 1)).toBe('2028-02-29');
  });

  it('spans exactly thirty days including today, which is what the DTO promises', () => {
    // `spent_usd_30d` is "the last thirty days", so the cutoff is today minus twenty-nine: the sum
    // is inclusive at both ends. Off by one here is a whole day of spend, silently.
    const cutoff = dayMinus('2026-09-30', SPEND_WINDOW_DAYS - 1);
    expect(cutoff).toBe('2026-09-01');
    const days =
      (Date.parse('2026-09-30T00:00:00Z') - Date.parse(`${cutoff}T00:00:00Z`)) / 86_400_000;
    expect(days + 1).toBe(SPEND_WINDOW_DAYS);
  });

  it('is unaffected by the clock the key was computed in', () => {
    // Whatever zone `rollupDay` used, the key it produced is a date and this is date arithmetic:
    // the same key gives the same cutoff regardless of where the process runs.
    expect(dayMinus('2026-10-25', 1)).toBe('2026-10-24');
    // …including the day European DST ends, which is 25 hours long in Europe/Prague.
    expect(dayMinus('2026-10-26', 1)).toBe('2026-10-25');
  });

  it('refuses a value that is not a rollup key rather than answering with Invalid Date', () => {
    for (const bad of ['', 'yesterday', '2026-13-45', 'null']) {
      expect(() => dayMinus(bad, 1), bad).toThrow(TypeError);
    }
  });
});
