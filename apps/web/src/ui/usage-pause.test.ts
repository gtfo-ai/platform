import { describe, expect, it } from 'vitest';
import { usagePauseTime, usagePauseWords } from './usage-pause.js';

const NOW = Date.parse('2026-11-04T10:00:00.000Z');

describe('usagePauseWords (WP-285)', () => {
  it('says the reset as HH:MM in the organisation’s zone', () => {
    expect(
      usagePauseWords(
        { until: '2026-11-04T13:00:00.000Z', estimated: false, timezone: 'Europe/Prague' },
        NOW,
      ),
    ).toBe('Paused — usage limit until 14:00');
    expect(
      usagePauseWords(
        { until: '2026-11-04T13:00:00.000Z', estimated: false, timezone: 'UTC' },
        NOW,
      ),
    ).toBe('Paused — usage limit until 13:00');
  });

  it('says *about* for a default pause, whose instant is a guess', () => {
    expect(
      usagePauseWords({ until: '2026-11-04T11:00:00.000Z', estimated: true, timezone: 'UTC' }, NOW),
    ).toBe('Paused — usage limit until about 11:00');
  });

  it('names the day of a reset that is not today in that zone', () => {
    expect(usagePauseTime('2026-11-07T09:30:00.000Z', NOW, 'UTC')).toBe('Sat 7 Nov, 09:30');
    // The same instant is today in UTC and tomorrow in Auckland: the zone decides the day.
    expect(usagePauseTime('2026-11-04T12:00:00.000Z', NOW, 'UTC')).toBe('12:00');
    expect(usagePauseTime('2026-11-04T12:00:00.000Z', NOW, 'Pacific/Auckland')).toBe(
      'Thu 5 Nov, 01:00',
    );
    expect(usagePauseTime('2026-11-04T09:00:00.000Z', NOW, 'Pacific/Auckland')).toBe('22:00');
  });

  it('falls back to UTC for a zone the browser does not know, and keeps an unreadable instant', () => {
    expect(usagePauseTime('2026-11-04T13:00:00.000Z', NOW, 'Mars/Olympus')).toBe('13:00');
    expect(usagePauseTime('soon', NOW, 'UTC')).toBe('soon');
  });
});
