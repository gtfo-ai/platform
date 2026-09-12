import type { IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { budgetWindowStart, rollupDay, TOTAL_WINDOW_START } from './window.js';

const at = (value: string) => value as IsoDateTime;

describe('budgetWindowStart (BD-010, Q12: windows are in the organisation timezone)', () => {
  it('starts a day at local midnight, not at UTC midnight', () => {
    // 00:30 in Prague on 12 June is 22:30 UTC on the 11th; the day is the 12th, and it began at
    // 22:00 UTC on the 11th. Reading this in UTC would answer the 11th and charge the wrong day.
    expect(budgetWindowStart('day', at('2026-06-11T22:30:00.000Z'), 'Europe/Prague')).toBe(
      '2026-06-11T22:00:00.000Z',
    );
    expect(budgetWindowStart('day', at('2026-06-11T22:30:00.000Z'), 'UTC')).toBe(
      '2026-06-11T00:00:00.000Z',
    );
  });

  it('starts a week on Monday', () => {
    // 2026-06-11 is a Thursday.
    expect(budgetWindowStart('week', at('2026-06-11T12:00:00.000Z'), 'UTC')).toBe(
      '2026-06-08T00:00:00.000Z',
    );
    // A Monday is its own week's start (standing rule 42: assert the boundary from both sides).
    expect(budgetWindowStart('week', at('2026-06-08T00:00:00.000Z'), 'UTC')).toBe(
      '2026-06-08T00:00:00.000Z',
    );
    expect(budgetWindowStart('week', at('2026-06-07T23:59:59.000Z'), 'UTC')).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('keeps a week that contains a DST change at local midnight', () => {
    // Europe/Prague springs forward on 2026-03-29 (a Sunday), inside the week of the 23rd.
    expect(budgetWindowStart('week', at('2026-03-30T08:00:00.000Z'), 'Europe/Prague')).toBe(
      '2026-03-29T22:00:00.000Z',
    );
    expect(budgetWindowStart('week', at('2026-03-28T08:00:00.000Z'), 'Europe/Prague')).toBe(
      '2026-03-22T23:00:00.000Z',
    );
  });

  it('starts a month on the first, in the zone', () => {
    expect(budgetWindowStart('month', at('2026-06-30T23:30:00.000Z'), 'UTC')).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    expect(budgetWindowStart('month', at('2026-06-30T23:30:00.000Z'), 'Europe/Prague')).toBe(
      '2026-06-30T22:00:00.000Z',
    );
  });

  it('gives a `total` budget one window for ever', () => {
    expect(budgetWindowStart('total', at('2026-06-11T12:00:00.000Z'), 'UTC')).toBe(
      TOTAL_WINDOW_START,
    );
    expect(budgetWindowStart('total', at('2030-01-01T00:00:00.000Z'), 'Pacific/Auckland')).toBe(
      TOTAL_WINDOW_START,
    );
  });

  it('refuses a fixed offset, because a window built on one is wrong for half the year', () => {
    expect(() => budgetWindowStart('day', at('2026-06-11T12:00:00.000Z'), '+02:00')).toThrow();
  });

  it('refuses an unparsable instant rather than answering for the epoch', () => {
    expect(() => budgetWindowStart('day', at('not a date'), 'UTC')).toThrow(TypeError);
  });
});

describe('rollupDay', () => {
  it('is the calendar day in the organisation’s zone', () => {
    expect(rollupDay(at('2026-06-11T22:30:00.000Z'), 'Europe/Prague')).toBe('2026-06-12');
    expect(rollupDay(at('2026-06-11T22:30:00.000Z'), 'UTC')).toBe('2026-06-11');
  });

  it('agrees with the day window, which is the point of having one calendar', () => {
    const instant = at('2026-06-11T22:30:00.000Z');
    const zone = 'Europe/Prague';
    expect(budgetWindowStart('day', instant, zone).slice(0, 10)).not.toBe(rollupDay(instant, zone));
    // The two are different *representations* — a UTC instant and a local date — so the check that
    // matters is that the window's start, read back in the zone, is the same day the rollup uses.
    expect(rollupDay(budgetWindowStart('day', instant, zone), zone)).toBe(rollupDay(instant, zone));
  });
});
