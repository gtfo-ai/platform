import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMs,
  differenceMs,
  durationToMs,
  fixedClock,
  isBefore,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  parseDuration,
} from './clock.js';
import { PROPERTY_TEST_TIMEOUT_MS } from './testing/property.js';

describe('fixedClock', () => {
  it('returns the same instant when it does not step', () => {
    const clock = fixedClock('2026-09-09T09:00:00.000Z');
    expect(clock.now()).toBe('2026-09-09T09:00:00.000Z');
    expect(clock.now()).toBe('2026-09-09T09:00:00.000Z');
  });

  it('advances by the step so a command sequence gets increasing timestamps', () => {
    const clock = fixedClock('2026-09-09T09:00:00.000Z', 1_500);
    expect(clock.now()).toBe('2026-09-09T09:00:00.000Z');
    expect(clock.now()).toBe('2026-09-09T09:00:01.500Z');
    expect(clock.now()).toBe('2026-09-09T09:00:03.000Z');
  });

  it('refuses a start that is not a timestamp', () => {
    expect(() => fixedClock('yesterday')).toThrow(TypeError);
  });
});

describe('instant arithmetic', () => {
  it(
    'addMs and differenceMs are inverses',
    () => {
      fc.assert(
        fc.property(fc.integer({ min: -10_000_000, max: 10_000_000 }), (ms) => {
          const start = '2026-09-09T09:00:00.000Z';
          expect(differenceMs(start, addMs(start, ms))).toBe(ms);
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('isBefore orders instants', () => {
    expect(isBefore('2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.001Z')).toBe(true);
    expect(isBefore('2026-09-09T09:00:00.001Z', '2026-09-09T09:00:00.000Z')).toBe(false);
    expect(isBefore('2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z')).toBe(false);
  });

  it('understands a numeric offset as well as Z', () => {
    expect(differenceMs('2026-09-09T11:00:00+02:00', '2026-09-09T09:00:00.000Z')).toBe(0);
  });
});

describe('parseDuration (technical/12 `limits.question_timeout`)', () => {
  it('parses the documented forms', () => {
    expect(parseDuration('30 minutes')).toEqual({ amount: 30, unit: 'minute', working: false });
    expect(parseDuration('1 minute')).toEqual({ amount: 1, unit: 'minute', working: false });
    expect(parseDuration('2 hours')).toEqual({ amount: 2, unit: 'hour', working: false });
    expect(parseDuration('1 day')).toEqual({ amount: 1, unit: 'day', working: false });
    expect(parseDuration('1 working day')).toEqual({ amount: 1, unit: 'day', working: true });
    expect(parseDuration('3 working hours')).toEqual({ amount: 3, unit: 'hour', working: true });
  });

  it('rejects anything else', () => {
    for (const value of ['soon', '2 weeks', '-1 day', 'day', '1  day']) {
      expect(() => parseDuration(value)).toThrow(TypeError);
    }
  });

  it('converts calendar-free durations to milliseconds', () => {
    expect(durationToMs(parseDuration('30 minutes'))).toBe(30 * MS_PER_MINUTE);
    expect(durationToMs(parseDuration('2 hours'))).toBe(2 * MS_PER_HOUR);
    expect(durationToMs(parseDuration('1 day'))).toBe(MS_PER_DAY);
  });

  it('refuses to guess what a working day is (that calendar belongs to WP-05)', () => {
    expect(() => durationToMs(parseDuration('1 working day'))).toThrow(TypeError);
  });
});
