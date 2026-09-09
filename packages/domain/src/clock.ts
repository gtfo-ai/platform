/**
 * Time as an injected dependency.
 *
 * `packages/domain` has no I/O (technical/01), and reading the wall clock is I/O: it makes the
 * same input produce different output, which would make the property tests in this package
 * meaningless. Aggregates therefore never call `Date.now()`; they read `Clock.now()` from the
 * command context. The composition root supplies a real clock; tests supply `fixedClock`.
 *
 * The arithmetic helpers below are pure functions over the ISO-8601 wire format
 * (`isoDateTimeSchema` in `@platform/contracts`), not over `Date` objects, because that is the
 * shape every event payload and record carries.
 */
import type { IsoDateTime } from '@platform/contracts';

export interface Clock {
  /** The current instant, as RFC 3339 with an offset — the wire format of every timestamp. */
  now(): IsoDateTime;
}

/**
 * A clock that returns a fixed instant, optionally advancing by `stepMs` on every read so a
 * command sequence produces strictly increasing timestamps without any real time passing.
 */
export const fixedClock = (start: IsoDateTime, stepMs = 0): Clock => {
  let current = Date.parse(start);
  if (Number.isNaN(current)) {
    throw new TypeError(`fixedClock: "${start}" is not a parsable timestamp`);
  }
  return {
    now: () => {
      const at = new Date(current).toISOString();
      current += stepMs;
      return at;
    },
  };
};

/** Milliseconds from `from` to `to`; negative when `to` precedes `from`. */
export const differenceMs = (from: IsoDateTime, to: IsoDateTime): number =>
  Date.parse(to) - Date.parse(from);

/** `at` shifted by `ms`, back in the wire format. */
export const addMs = (at: IsoDateTime, ms: number): IsoDateTime =>
  new Date(Date.parse(at) + ms).toISOString();

/** True when `a` is strictly earlier than `b`. */
export const isBefore = (a: IsoDateTime, b: IsoDateTime): boolean => Date.parse(a) < Date.parse(b);

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** The units `durationSchema` (`@platform/contracts`) accepts. */
export type DurationUnit = 'minute' | 'hour' | 'day';

export interface ParsedDuration {
  readonly amount: number;
  readonly unit: DurationUnit;
  /**
   * `1 working day` — the org calendar skips weekends and holidays. Resolving a working-day
   * deadline needs that calendar, which is a job-scheduling concern (WP-05); this package only
   * reports the flag so the caller knows which resolver to use.
   */
  readonly working: boolean;
}

const DURATION_PATTERN = /^(\d+) (working )?(minutes?|hours?|days?)$/;

/**
 * Parses the human duration format used by `limits.question_timeout` (technical/12), e.g.
 * `30 minutes`, `2 hours`, `1 working day`.
 */
export const parseDuration = (value: string): ParsedDuration => {
  const match = DURATION_PATTERN.exec(value);
  if (match === null) {
    throw new TypeError(`"${value}" is not a duration such as "2 hours" or "1 working day"`);
  }
  const amount = Number(match[1]);
  const unitToken = match[3] ?? '';
  const unit: DurationUnit = unitToken.startsWith('minute')
    ? 'minute'
    : unitToken.startsWith('hour')
      ? 'hour'
      : 'day';
  return { amount, unit, working: match[2] !== undefined };
};

/**
 * A calendar-free duration in milliseconds. Throws for `working` durations, which need the org
 * calendar (WP-05) rather than a fixed multiplier.
 */
export const durationToMs = (duration: ParsedDuration): number => {
  if (duration.working) {
    throw new TypeError('a working-day duration needs the organisation calendar (WP-05)');
  }
  const perUnit =
    duration.unit === 'minute'
      ? MS_PER_MINUTE
      : duration.unit === 'hour'
        ? MS_PER_HOUR
        : MS_PER_DAY;
  return duration.amount * perUnit;
};
