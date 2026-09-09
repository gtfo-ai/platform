import { describe, expect, it } from 'vitest';
import {
  assertTimeZone,
  isoDateOf,
  isoWeekdayOfDate,
  isValidTimeZone,
  minutesOfDay,
  nextIsoDate,
  parseIsoDate,
  zonedParts,
  zonedTimeToInstant,
  zoneOffsetMs,
} from './zoned-time.js';

describe('assertTimeZone', () => {
  it.each(['UTC', 'Europe/Prague', 'America/New_York', 'Asia/Kolkata'])('accepts %s', (zone) => {
    expect(() => assertTimeZone(zone)).not.toThrow();
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(['', 'Europe/New_Yrok', 'Mars/Olympus', 'not a zone'])('rejects %s', (zone) => {
    expect(() => assertTimeZone(zone)).toThrow();
    expect(isValidTimeZone(zone)).toBe(false);
  });

  it('rejects a fixed offset, which has no DST rules', () => {
    // `+02:00` parses as a zone in some runtimes and silently makes half the year wrong.
    expect(isValidTimeZone('+02:00')).toBe(false);
  });
});

describe('zonedParts', () => {
  it('reads an instant in the named zone, not the host zone', () => {
    const instant = new Date('2026-06-01T12:34:56Z');
    expect(zonedParts(instant, 'UTC')).toEqual({
      year: 2026,
      month: 6,
      day: 1,
      hour: 12,
      minute: 34,
      second: 56,
      weekday: 1,
    });
    expect(zonedParts(instant, 'Europe/Prague')).toMatchObject({ hour: 14, weekday: 1 });
    expect(zonedParts(instant, 'America/New_York')).toMatchObject({ hour: 8, weekday: 1 });
    expect(zonedParts(instant, 'Asia/Kolkata')).toMatchObject({ hour: 18, minute: 4 });
  });

  it('renders midnight as hour 0', () => {
    expect(zonedParts(new Date('2026-06-01T00:00:00Z'), 'UTC').hour).toBe(0);
  });

  it('crosses the date line correctly', () => {
    expect(zonedParts(new Date('2026-06-01T23:30:00Z'), 'Europe/Prague')).toMatchObject({
      day: 2,
      hour: 1,
      weekday: 2,
    });
  });

  it('gives every ISO weekday its number', () => {
    // 2026-06-01 is a Monday.
    const weekdays = Array.from(
      { length: 7 },
      (_, offset) => zonedParts(new Date(`2026-06-0${offset + 1}T12:00:00Z`), 'UTC').weekday,
    );
    expect(weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('zoneOffsetMs', () => {
  it('is zero for UTC', () => {
    expect(zoneOffsetMs(Date.parse('2026-06-01T00:00:00Z'), 'UTC')).toBe(0);
  });

  it('follows the DST rules of the zone', () => {
    expect(zoneOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'Europe/Prague')).toBe(3_600_000);
    expect(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'Europe/Prague')).toBe(7_200_000);
    expect(zoneOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-18_000_000);
  });

  it('does not let sub-second precision leak into the offset', () => {
    expect(zoneOffsetMs(Date.parse('2026-06-01T12:00:00.750Z'), 'Europe/Prague')).toBe(7_200_000);
  });
});

describe('zonedTimeToInstant', () => {
  const local = (hour: number, day = 1, month = 6) => ({
    year: 2026,
    month,
    day,
    hour,
    minute: 0,
    second: 0,
  });

  it('round-trips an unambiguous local time', () => {
    for (const zone of ['UTC', 'Europe/Prague', 'America/New_York', 'Asia/Kolkata']) {
      const instant = zonedTimeToInstant(local(9), zone);
      expect(zonedParts(instant, zone)).toMatchObject({ year: 2026, month: 6, day: 1, hour: 9 });
    }
  });

  it('applies the zone offset, so 09:00 in Prague is not 09:00 UTC', () => {
    expect(zonedTimeToInstant(local(9), 'Europe/Prague').toISOString()).toBe(
      '2026-06-01T07:00:00.000Z',
    );
    expect(zonedTimeToInstant(local(9), 'America/New_York').toISOString()).toBe(
      '2026-06-01T13:00:00.000Z',
    );
  });

  it('resolves a local time inside a spring-forward gap to the far side of it', () => {
    // Europe/Prague loses 02:00–03:00 on 2026-03-29.
    const instant = zonedTimeToInstant(
      { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 },
      'Europe/Prague',
    );
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // Which reads as 03:30 local — after the gap, never before it.
    expect(zonedParts(instant, 'Europe/Prague')).toMatchObject({ hour: 3, minute: 30 });
  });

  it('resolves an ambiguous local time to the later of the two instants', () => {
    // Europe/Prague repeats 02:00–03:00 on 2026-10-25; 02:30 happens at 00:30Z and again at 01:30Z.
    const instant = zonedTimeToInstant(
      { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 },
      'Europe/Prague',
    );
    expect(instant.toISOString()).toBe('2026-10-25T01:30:00.000Z');
    expect(zonedParts(instant, 'Europe/Prague')).toMatchObject({ hour: 2, minute: 30 });
  });

  it('picks the later instant west of UTC too', () => {
    // America/New_York repeats 01:00–02:00 on 2026-11-01: 01:30 happens at 05:30Z (EDT) and again
    // at 06:30Z (EST). An offset-sign-dependent resolution returns 05:30Z here while getting
    // Europe/Prague right, which is why both hemispheres are pinned.
    const instant = zonedTimeToInstant(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      'America/New_York',
    );
    expect(instant.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(zonedParts(instant, 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
  });

  it('resolves a gap forward west of UTC too', () => {
    // America/New_York loses 02:00–03:00 on 2026-03-08.
    const instant = zonedTimeToInstant(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
      'America/New_York',
    );
    expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedParts(instant, 'America/New_York')).toMatchObject({ hour: 3, minute: 30 });
  });

  it('picks the later instant for a zone whose transition is not a whole hour', () => {
    // Lord Howe Island shifts by 30 minutes: 01:30–02:00 repeats on 2026-04-05.
    const instant = zonedTimeToInstant(
      { year: 2026, month: 4, day: 5, hour: 1, minute: 45, second: 0 },
      'Australia/Lord_Howe',
    );
    expect(zonedParts(instant, 'Australia/Lord_Howe')).toMatchObject({ hour: 1, minute: 45 });
    // The later occurrence is the one at the +10:30 offset.
    expect(zoneOffsetMs(instant.getTime(), 'Australia/Lord_Howe')).toBe(10.5 * 3_600_000);
  });

  it('round-trips every local time of a transition day in both hemispheres', () => {
    for (const [zone, date] of [
      ['Europe/Prague', { year: 2026, month: 10, day: 25 }],
      ['America/New_York', { year: 2026, month: 11, day: 1 }],
      ['Australia/Lord_Howe', { year: 2026, month: 4, day: 5 }],
    ] as const) {
      for (let hour = 0; hour < 24; hour += 1) {
        for (const minute of [0, 30]) {
          const instant = zonedTimeToInstant({ ...date, hour, minute, second: 0 }, zone);
          const readBack = zonedParts(instant, zone);
          // Either the reading round-trips (a real local time) or it fell in a gap, in which case
          // the answer must lie after the requested wall clock, never before it.
          const roundTripped = readBack.hour === hour && readBack.minute === minute;
          const movedForward =
            readBack.day > date.day || readBack.hour * 60 + readBack.minute > hour * 60 + minute;
          expect(roundTripped || movedForward).toBe(true);
        }
      }
    }
  });

  it('handles a zone whose offset is not a whole hour', () => {
    const instant = zonedTimeToInstant(local(9), 'Asia/Kolkata');
    expect(instant.toISOString()).toBe('2026-06-01T03:30:00.000Z');
  });
});

describe('date helpers', () => {
  it('formats and parses YYYY-MM-DD', () => {
    expect(isoDateOf({ year: 2026, month: 6, day: 1 })).toBe('2026-06-01');
    expect(parseIsoDate('2026-06-01')).toEqual({ year: 2026, month: 6, day: 1 });
  });

  it.each(['2026-6-1', '20260601', '2026-13-01', '2026-06-32', 'yesterday'])(
    'rejects %s',
    (value) => {
      expect(() => parseIsoDate(value)).toThrow();
    },
  );

  it('advances to the next day across month, year and leap boundaries', () => {
    expect(nextIsoDate('2026-06-01')).toBe('2026-06-02');
    expect(nextIsoDate('2026-06-30')).toBe('2026-07-01');
    expect(nextIsoDate('2026-12-31')).toBe('2027-01-01');
    expect(nextIsoDate('2028-02-28')).toBe('2028-02-29');
  });

  it('reads the ISO weekday of a date string', () => {
    expect(isoWeekdayOfDate('2026-06-01')).toBe(1);
    expect(isoWeekdayOfDate('2026-06-07')).toBe(7);
  });

  it('parses HH:MM into minutes since midnight', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('09:30')).toBe(570);
    expect(minutesOfDay('23:59')).toBe(1439);
  });

  it.each(['24:00', '9:30', '09:60', '0930', ''])('rejects the time %s', (value) => {
    expect(() => minutesOfDay(value)).toThrow();
  });
});
