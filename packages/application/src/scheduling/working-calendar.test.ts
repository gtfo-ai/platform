import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  advanceWorkingTime,
  createWorkingCalendar,
  DEFAULT_QUESTION_TIMEOUT,
  defaultWorkingCalendarConfig,
  isWorkingDate,
  localDateOf,
  parseDuration,
  questionReminderTimes,
  questionTimeoutAt,
  resolveDeadline,
  type WorkingCalendar,
  workingWindow,
} from './working-calendar.js';
import { zonedParts } from './zoned-time.js';

/** Mon–Fri 09:00–17:00 UTC, no holidays. 2026-06-01 is a Monday. */
const utcCalendar = createWorkingCalendar();

const calendar = (overrides: Record<string, unknown>): WorkingCalendar =>
  createWorkingCalendar({ ...defaultWorkingCalendarConfig(), ...overrides });

const at = (iso: string): Date => new Date(iso);
const iso = (date: Date): string => date.toISOString();

describe('createWorkingCalendar', () => {
  it('defaults to Monday–Friday, 09:00–17:00, UTC, no holidays', () => {
    expect(utcCalendar.timezone).toBe('UTC');
    expect([...utcCalendar.workingWeekdays].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(utcCalendar.minutesPerWorkingDay).toBe(8 * 60);
    expect(utcCalendar.holidays.size).toBe(0);
  });

  it('rejects a working window that does not open before it closes', () => {
    expect(() => calendar({ working_hours: { start: '17:00', end: '09:00' } })).toThrow(
      /working calendar/,
    );
    expect(() => calendar({ working_hours: { start: '09:00', end: '09:00' } })).toThrow();
  });

  it('rejects a repeated weekday, an empty week and an out-of-range weekday', () => {
    expect(() => calendar({ working_weekdays: [1, 1, 2] })).toThrow(/must not repeat/);
    expect(() => calendar({ working_weekdays: [] })).toThrow();
    expect(() => calendar({ working_weekdays: [0] })).toThrow();
    expect(() => calendar({ working_weekdays: [8] })).toThrow();
  });

  it('rejects an unknown time zone and a fixed offset', () => {
    expect(() => calendar({ timezone: 'Europe/New_Yrok' })).toThrow(/unknown time zone/);
    expect(() => calendar({ timezone: '+02:00' })).toThrow(/fixed offset/);
  });

  it('rejects a holiday that is not a calendar date', () => {
    expect(() => calendar({ holidays: ['2026-13-01'] })).toThrow();
    expect(() => calendar({ holidays: ['2026-02-30'] })).toThrow();
  });

  it('rejects unknown keys, so a typo is never silently ignored', () => {
    expect(() => calendar({ working_hoursz: {} })).toThrow();
  });

  it('names the offending field', () => {
    expect(() => calendar({ working_weekdays: [9] })).toThrow(/working_weekdays/);
  });
});

describe('isWorkingDate and workingWindow', () => {
  it('excludes weekends', () => {
    expect(isWorkingDate(utcCalendar, '2026-06-05')).toBe(true); // Friday
    expect(isWorkingDate(utcCalendar, '2026-06-06')).toBe(false); // Saturday
    expect(isWorkingDate(utcCalendar, '2026-06-07')).toBe(false); // Sunday
    expect(workingWindow(utcCalendar, '2026-06-06')).toBeNull();
  });

  it('excludes configured holidays', () => {
    const withHoliday = calendar({ holidays: ['2026-07-06'] }); // Cyril and Methodius, a Monday
    expect(isWorkingDate(withHoliday, '2026-07-06')).toBe(false);
    expect(isWorkingDate(withHoliday, '2026-07-07')).toBe(true);
  });

  it('honours a non-Monday–Friday week', () => {
    const sundayToThursday = calendar({ working_weekdays: [7, 1, 2, 3, 4] });
    expect(isWorkingDate(sundayToThursday, '2026-06-07')).toBe(true); // Sunday
    expect(isWorkingDate(sundayToThursday, '2026-06-05')).toBe(false); // Friday
  });

  it('anchors the window in the calendar zone, not UTC', () => {
    const prague = calendar({ timezone: 'Europe/Prague' });
    const window = workingWindow(prague, '2026-06-01');
    expect(iso(window?.start as Date)).toBe('2026-06-01T07:00:00.000Z'); // 09:00 CEST
    expect(iso(window?.end as Date)).toBe('2026-06-01T15:00:00.000Z'); // 17:00 CEST
  });

  it('shortens a working day that contains a spring-forward transition', () => {
    // Europe/Prague springs forward at 02:00 on 2026-03-29 (a Sunday), so use a zone whose
    // transition lands inside the window: Chile moves at 24:00 local, so use a 00:00–23:00 window
    // in Prague on the transition day instead.
    const around = createWorkingCalendar({
      timezone: 'Europe/Prague',
      working_weekdays: [1, 2, 3, 4, 5, 6, 7],
      working_hours: { start: '01:00', end: '05:00' },
      holidays: [],
    });
    const window = workingWindow(around, '2026-03-29');
    expect(window).not.toBeNull();
    const { start, end } = window as { start: Date; end: Date };
    const lengthHours = (end.getTime() - start.getTime()) / 3_600_000;
    // Four wall-clock hours, three real ones: the wall clock is what a deadline means.
    expect(lengthHours).toBe(3);
  });
});

describe('advanceWorkingTime', () => {
  it('returns the next working instant for zero minutes', () => {
    expect(iso(advanceWorkingTime(utcCalendar, at('2026-06-06T10:00:00Z'), 0))).toBe(
      '2026-06-08T09:00:00.000Z',
    );
    expect(iso(advanceWorkingTime(utcCalendar, at('2026-06-01T10:00:00Z'), 0))).toBe(
      '2026-06-01T10:00:00.000Z',
    );
  });

  it('consumes only time inside the working window', () => {
    // 16:00 Friday + 2 working hours = 1 h on Friday, 1 h from Monday 09:00.
    expect(iso(advanceWorkingTime(utcCalendar, at('2026-06-05T16:00:00Z'), 120))).toBe(
      '2026-06-08T10:00:00.000Z',
    );
  });

  it('rejects a negative or non-finite amount', () => {
    expect(() => advanceWorkingTime(utcCalendar, at('2026-06-01T10:00:00Z'), -1)).toThrow();
    expect(() => advanceWorkingTime(utcCalendar, at('2026-06-01T10:00:00Z'), Number.NaN)).toThrow();
  });

  it('gives up rather than looping when the calendar has no reachable working time', () => {
    const everyDayIsAHoliday = calendar({
      // Every date the scan can reach from the anchor below, so it exhausts its budget.
      holidays: Array.from({ length: 3700 }, (_, offset) => {
        const day = new Date(Date.UTC(2026, 5, 1) + offset * 86_400_000);
        return day.toISOString().slice(0, 10);
      }),
    });
    expect(() => advanceWorkingTime(everyDayIsAHoliday, at('2026-06-01T10:00:00Z'), 60)).toThrow(
      /no working time found/,
    );
  });
});

describe('parseDuration', () => {
  it.each([
    ['30 minutes', { amount: 30, unit: 'minutes', working: false }],
    ['1 minute', { amount: 1, unit: 'minutes', working: false }],
    ['2 hours', { amount: 2, unit: 'hours', working: false }],
    ['1 working day', { amount: 1, unit: 'days', working: true }],
    ['3 working hours', { amount: 3, unit: 'hours', working: true }],
    ['0 minutes', { amount: 0, unit: 'minutes', working: false }],
  ])('parses %s', (text, expected) => {
    expect(parseDuration(text)).toEqual(expected);
  });

  it.each(['1 working fortnight', 'soon', '', 'day', '-1 days', '1.5 hours'])(
    'rejects %s',
    (text) => {
      expect(() => parseDuration(text)).toThrow(/invalid duration/);
    },
  );

  it('is bound to the grammar published by @platform/contracts', () => {
    // A duration the configuration schema accepts must be one this module can resolve, or a valid
    // `.agentic/config.yml` would blow up at the moment a question is asked.
    for (const unit of ['minute', 'hour', 'day']) {
      for (const text of [`1 ${unit}`, `2 ${unit}s`, `1 working ${unit}`, `2 working ${unit}s`]) {
        expect(() => resolveDeadline(utcCalendar, at('2026-06-01T10:00:00Z'), text)).not.toThrow();
      }
    }
  });
});

describe('resolveDeadline', () => {
  it('treats a duration without "working" as plain elapsed time', () => {
    expect(iso(resolveDeadline(utcCalendar, at('2026-06-06T10:00:00Z'), '30 minutes'))).toBe(
      '2026-06-06T10:30:00.000Z',
    );
    expect(iso(resolveDeadline(utcCalendar, at('2026-06-06T10:00:00Z'), '2 days'))).toBe(
      '2026-06-08T10:00:00.000Z',
    );
  });

  it.each([
    // asked mid-morning on a Monday → same time on Tuesday
    ['2026-06-01T14:00:00Z', '2026-06-02T14:00:00.000Z'],
    // asked an hour before Friday close → 1 h Friday + 7 h Monday
    ['2026-06-05T16:00:00Z', '2026-06-08T16:00:00.000Z'],
    // asked on a Saturday → the clock starts when the office opens on Monday
    ['2026-06-06T10:00:00Z', '2026-06-08T17:00:00.000Z'],
    // asked before opening → clamped to 09:00 the same day
    ['2026-06-01T07:00:00Z', '2026-06-01T17:00:00.000Z'],
    // asked after closing → the whole day comes from Tuesday
    ['2026-06-01T18:00:00Z', '2026-06-02T17:00:00.000Z'],
  ])('resolves "1 working day" from %s to %s', (asked, expected) => {
    expect(iso(resolveDeadline(utcCalendar, at(asked), '1 working day'))).toBe(expected);
  });

  it('skips a holiday in the middle of the week', () => {
    const withHoliday = calendar({ holidays: ['2026-06-02'] });
    expect(iso(resolveDeadline(withHoliday, at('2026-06-01T14:00:00Z'), '1 working day'))).toBe(
      '2026-06-03T14:00:00.000Z',
    );
  });

  it('spans several working days', () => {
    expect(iso(resolveDeadline(utcCalendar, at('2026-06-01T10:00:00Z'), '5 working days'))).toBe(
      '2026-06-08T10:00:00.000Z',
    );
  });

  it('counts working hours and minutes on the same calendar', () => {
    expect(iso(resolveDeadline(utcCalendar, at('2026-06-05T16:30:00Z'), '2 working hours'))).toBe(
      '2026-06-08T10:30:00.000Z',
    );
    expect(
      iso(resolveDeadline(utcCalendar, at('2026-06-05T16:50:00Z'), '20 working minutes')),
    ).toBe('2026-06-08T09:10:00.000Z');
  });

  it('computes the same wall-clock answer in another zone', () => {
    const prague = calendar({ timezone: 'Europe/Prague' });
    // 14:00 CEST on Monday → 14:00 CEST on Tuesday, i.e. 12:00Z both days.
    const deadline = resolveDeadline(prague, at('2026-06-01T12:00:00Z'), '1 working day');
    expect(iso(deadline)).toBe('2026-06-02T12:00:00.000Z');
    expect(zonedParts(deadline, 'Europe/Prague')).toMatchObject({ hour: 14 });
  });

  it('keeps the wall-clock answer across a DST transition', () => {
    const prague = calendar({ timezone: 'Europe/Prague' });
    // Friday 2026-03-27 14:00 CET (13:00Z) + 1 working day → Monday 2026-03-30 14:00 CEST
    // (12:00Z): the same wall-clock time, one absolute hour earlier because the clocks moved.
    const deadline = resolveDeadline(prague, at('2026-03-27T13:00:00Z'), '1 working day');
    expect(zonedParts(deadline, 'Europe/Prague')).toMatchObject({
      year: 2026,
      month: 3,
      day: 30,
      hour: 14,
    });
    expect(iso(deadline)).toBe('2026-03-30T12:00:00.000Z');
  });
});

describe('questionTimeoutAt and questionReminderTimes', () => {
  it('defaults to the 1 working day BD-006 specifies', () => {
    expect(DEFAULT_QUESTION_TIMEOUT).toBe('1 working day');
    expect(iso(questionTimeoutAt(utcCalendar, at('2026-06-01T14:00:00Z')))).toBe(
      '2026-06-02T14:00:00.000Z',
    );
  });

  it('accepts a project override', () => {
    expect(iso(questionTimeoutAt(utcCalendar, at('2026-06-01T10:00:00Z'), '2 hours'))).toBe(
      '2026-06-01T12:00:00.000Z',
    );
  });

  it('orders reminders and drops any that would arrive after the deadline', () => {
    const asked = at('2026-06-01T10:00:00Z');
    const reminders = questionReminderTimes(utcCalendar, asked, [
      '4 working hours',
      '1 working hour',
      '1 working day',
      '3 working days',
    ]);
    expect(reminders.map(iso)).toEqual(['2026-06-01T11:00:00.000Z', '2026-06-01T14:00:00.000Z']);
  });

  it('drops a zero offset, which would fire the moment the question is asked', () => {
    expect(questionReminderTimes(utcCalendar, at('2026-06-01T10:00:00Z'), ['0 minutes'])).toEqual(
      [],
    );
  });
});

describe('properties', () => {
  const anchor = fc
    .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) })
    .map((ms) => new Date(ms));
  const zones = fc.constantFrom('UTC', 'Europe/Prague', 'America/New_York', 'Asia/Kolkata');

  it('never returns an instant before the anchor', () => {
    fc.assert(
      fc.property(anchor, zones, fc.integer({ min: 0, max: 5000 }), (from, timezone, minutes) => {
        const target = calendar({ timezone });
        expect(advanceWorkingTime(target, from, minutes).getTime()).toBeGreaterThanOrEqual(
          from.getTime(),
        );
      }),
    );
  });

  it('is monotonic in the amount of working time', () => {
    fc.assert(
      fc.property(
        anchor,
        zones,
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 2000 }),
        (from, timezone, a, b) => {
          const target = calendar({ timezone });
          const [less, more] = a <= b ? [a, b] : [b, a];
          expect(advanceWorkingTime(target, from, less).getTime()).toBeLessThanOrEqual(
            advanceWorkingTime(target, from, more).getTime(),
          );
        },
      ),
    );
  });

  it('always lands inside a working window (or exactly at its close)', () => {
    fc.assert(
      fc.property(anchor, zones, fc.integer({ min: 0, max: 3000 }), (from, timezone, minutes) => {
        const target = calendar({ timezone });
        const result = advanceWorkingTime(target, from, minutes);
        const date = localDateOf(target, result);
        // A result exactly at the close reads as the next day in some zones only if the window
        // ends at midnight, which the schema forbids; so the window of `date` must contain it.
        const window = workingWindow(target, date);
        expect(window).not.toBeNull();
        expect(result.getTime()).toBeGreaterThanOrEqual(
          (window as { start: Date }).start.getTime(),
        );
        expect(result.getTime()).toBeLessThanOrEqual((window as { end: Date }).end.getTime());
      }),
    );
  });

  it('adding N then M working minutes equals adding N + M', () => {
    fc.assert(
      fc.property(
        anchor,
        zones,
        fc.integer({ min: 1, max: 900 }),
        fc.integer({ min: 1, max: 900 }),
        (from, timezone, first, second) => {
          const target = calendar({ timezone });
          const stepwise = advanceWorkingTime(
            target,
            advanceWorkingTime(target, from, first),
            second,
          );
          const direct = advanceWorkingTime(target, from, first + second);
          expect(iso(stepwise)).toBe(iso(direct));
        },
      ),
    );
  });
});
