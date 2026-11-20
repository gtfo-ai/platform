import { afterEach, describe, expect, it } from 'vitest';
import { logLineWords } from '../worker/model.js';
import {
  clockOf,
  currentClock,
  DEFAULT_CLOCK,
  formatCivilDate,
  formatDate,
  formatDateTime,
  formatTime,
  formatTimeWithSeconds,
  formatWeekdayDate,
  sameDay,
  setClock,
} from './time.js';

const AFTERNOON = '2026-11-19T15:05:09.000Z';
const UTC = { timeZone: 'UTC' } as const;

afterEach(() => {
  setClock(DEFAULT_CLOCK);
});

describe('the clock (S-28.21, BACKLOG 1608)', () => {
  it('is 24-hour before anybody chooses one', () => {
    expect(DEFAULT_CLOCK).toBe('24h');
    expect(currentClock()).toBe('24h');
    expect(formatTime(AFTERNOON, UTC)).toBe('15:05');
    expect(formatDateTime(AFTERNOON, UTC)).toBe('Nov 19, 2026, 15:05');
    expect(formatTimeWithSeconds(AFTERNOON, UTC)).toBe('15:05:09');
  });

  it('writes midnight as 00, never 24', () => {
    expect(formatTime('2026-11-19T00:05:00.000Z', UTC)).toBe('00:05');
  });

  it('follows the clock in force once the organisation chose 12-hour', () => {
    setClock('12h');
    expect(formatTime(AFTERNOON, UTC)).toMatch(/^3:05\sPM$/);
    expect(formatDateTime(AFTERNOON, UTC)).toMatch(/^Nov 19, 2026, 3:05\sPM$/);
    expect(formatTimeWithSeconds(AFTERNOON, UTC)).toMatch(/^3:05:09\sPM$/);
    // …and back.
    setClock('24h');
    expect(formatTime(AFTERNOON, UTC)).toBe('15:05');
  });

  it('lets a call name its own clock (the settings preview)', () => {
    expect(formatTime(AFTERNOON, { ...UTC, clock: '12h' })).toMatch(/^3:05\sPM$/);
    setClock('12h');
    expect(formatTime(AFTERNOON, { ...UTC, clock: '24h' })).toBe('15:05');
  });

  it('reads only 12h as a departure from the default', () => {
    expect(clockOf('12h')).toBe('12h');
    for (const value of ['24h', undefined, null, '', '12H', 12]) {
      expect(clockOf(value)).toBe('24h');
    }
  });
});

describe('the formatters', () => {
  it('show a value that is not an instant as it came, or as nothing for a bare time', () => {
    expect(formatDateTime('soon')).toBe('soon');
    expect(formatDate('soon')).toBe('soon');
    expect(formatTime('soon')).toBe('');
    expect(formatTimeWithSeconds(Number.NaN)).toBe('');
  });

  it('format in a named zone, and fall back to UTC for one the browser does not know', () => {
    expect(formatTime(AFTERNOON, { timeZone: 'Pacific/Auckland' })).toBe('04:05');
    expect(formatTime(AFTERNOON, { timeZone: 'Mars/Olympus' })).toBe('15:05');
  });

  it('write a date alone, and a civil date in UTC whatever the reader’s zone', () => {
    expect(formatDate(AFTERNOON, UTC)).toBe('Nov 19, 2026');
    expect(formatCivilDate('2026-09-10')).toBe('Sep 10, 2026');
    expect(formatCivilDate('not-a-day')).toBe('not-a-day');
  });

  it('tell the day apart in a zone, and name it', () => {
    const at = Date.parse(AFTERNOON);
    expect(sameDay(at, Date.parse('2026-11-19T01:00:00.000Z'), 'UTC')).toBe(true);
    expect(sameDay(at, Date.parse('2026-11-19T01:00:00.000Z'), 'Pacific/Auckland')).toBe(false);
    expect(formatWeekdayDate(at, 'UTC')).toBe('Thu 19 Nov');
  });
});

describe('the worker page’s log line', () => {
  it('reads its time through the formatter, on the clock in force', () => {
    const line = JSON.stringify({ time: Date.parse(AFTERNOON), msg: 'claimed a run' });
    expect(logLineWords(line)).toBe(`${formatTimeWithSeconds(AFTERNOON)}  claimed a run`);
    expect(logLineWords(line)).toMatch(/^\d{2}:\d{2}:09 {2}claimed a run$/);
    expect(logLineWords('plain text')).toBe('plain text');
  });
});
