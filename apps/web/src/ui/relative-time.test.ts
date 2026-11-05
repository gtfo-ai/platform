import { describe, expect, it } from 'vitest';
import { formatAgo } from './relative-time.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');

describe('formatAgo', () => {
  it.each([
    ['2026-11-05T11:59:30.000Z', 'just now'],
    ['2026-11-05T11:55:00.000Z', '5 m ago'],
    ['2026-11-05T09:00:00.000Z', '3 h ago'],
    ['2026-11-03T12:00:00.000Z', '2 d ago'],
    // A server clock ahead of this one is not a negative age.
    ['2026-11-05T12:05:00.000Z', 'just now'],
  ])('reads %s as %s', (iso, expected) => {
    expect(formatAgo(iso, NOW)).toBe(expected);
  });

  it('answers nothing for a time it cannot read', () => {
    expect(formatAgo('not a time', NOW)).toBeNull();
  });
});
