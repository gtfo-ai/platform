import { describe, expect, it } from 'vitest';
import {
  MAX_RESET_AHEAD_MS,
  mergeUsageLimits,
  RESETS_AT_MILLISECONDS_FROM,
  resetsAtOf,
  usageLimitOf,
} from './usage-limit.js';

const NOW = Date.parse('2026-03-01T09:00:00.000Z');
const IN_FIVE_HOURS = '2026-03-01T14:00:00.000Z';

describe('resetsAtOf — the unit by magnitude until V-WM1 pins it', () => {
  it('reads seconds and milliseconds of one instant alike', () => {
    expect(resetsAtOf(Date.parse(IN_FIVE_HOURS) / 1000, NOW)).toBe(IN_FIVE_HOURS);
    expect(resetsAtOf(Date.parse(IN_FIVE_HOURS), NOW)).toBe(IN_FIVE_HOURS);
  });

  it('puts the boundary where neither unit can be today', () => {
    // 10¹¹ s is the year 5138; 10¹¹ ms is 1973 — both far from now, so the cut is unambiguous.
    expect(resetsAtOf(RESETS_AT_MILLISECONDS_FROM - 1, NOW)).toBeNull();
    expect(resetsAtOf(RESETS_AT_MILLISECONDS_FROM, NOW)).toBeNull();
  });

  it('refuses a reset that is past, now, too far ahead, or not a number', () => {
    expect(resetsAtOf(NOW / 1000, NOW)).toBeNull();
    expect(resetsAtOf(NOW - 1, NOW)).toBeNull();
    expect(resetsAtOf(NOW + MAX_RESET_AHEAD_MS, NOW)).not.toBeNull();
    expect(resetsAtOf(NOW + MAX_RESET_AHEAD_MS + 1, NOW)).toBeNull();
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -5,
      0,
      '1772373600',
      null,
      undefined,
    ]) {
      expect(resetsAtOf(bad, NOW)).toBeNull();
    }
  });
});

describe('usageLimitOf', () => {
  const event = (info: unknown) => ({ type: 'rate_limit_event', rate_limit_info: info });

  it('reads a rejection, a credits error and a 429 result', () => {
    expect(usageLimitOf(event({ status: 'rejected', resetsAt: 1772373600 }), NOW)).toEqual({
      signal: 'rate_limit_rejected',
      resetsAt: IN_FIVE_HOURS,
    });
    expect(usageLimitOf(event({ status: 'allowed', errorCode: 'credits_required' }), NOW)).toEqual({
      signal: 'credits_required',
      resetsAt: null,
    });
    expect(usageLimitOf({ type: 'result', api_error_status: 429 }, NOW)).toEqual({
      signal: 'api_status_429',
      resetsAt: null,
    });
  });

  it('reads nothing into an allowed event, another status, or a malformed one', () => {
    for (const message of [
      event({ status: 'allowed', resetsAt: 1772373600 }),
      event({ status: 'allowed_warning', utilization: 0.95 }),
      event(null),
      event('rejected'),
      { type: 'result', api_error_status: 500 },
      { type: 'result', api_error_status: '429' },
      { type: 'assistant' },
      null,
      [],
    ]) {
      expect(usageLimitOf(message, NOW)).toBeNull();
    }
  });
});

describe('mergeUsageLimits', () => {
  it('keeps the first signal and any reset either named', () => {
    const rejected = { signal: 'rate_limit_rejected' as const, resetsAt: IN_FIVE_HOURS as never };
    const status = { signal: 'api_status_429' as const, resetsAt: null };
    expect(mergeUsageLimits(null, status)).toBe(status);
    expect(mergeUsageLimits(rejected, null)).toBe(rejected);
    expect(mergeUsageLimits(rejected, status)).toEqual(rejected);
    expect(mergeUsageLimits(status, rejected)).toEqual({
      signal: 'api_status_429',
      resetsAt: IN_FIVE_HOURS,
    });
  });
});
