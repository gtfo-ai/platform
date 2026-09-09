/**
 * Explicit time-zone arithmetic for the working-day calendar.
 *
 * The platform's time zone is *configuration* — `TZ` seeds the organisation setting
 * (technical/12) and every deadline is computed in it. Nothing here ever reads the host's local
 * zone: `Date#getHours()`, `Date#getDay()` and friends do exactly that, so they are not used.
 * Everything goes through `Intl.DateTimeFormat` with an explicit `timeZone`, which is the only
 * IANA-aware clock in the standard library until `Temporal` ships (not available on Node 25.1).
 *
 * Pure: no I/O, no ambient state beyond a formatter cache.
 */

/** A wall-clock reading in some named zone. `weekday` is ISO-8601: Monday = 1 … Sunday = 7. */
export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: number;
}

/** The date half of a `ZonedParts`, as `YYYY-MM-DD`. */
export type IsoDate = string;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, formatter);
  return formatter;
};

/**
 * Throws unless `timeZone` is an IANA zone this runtime knows.
 *
 * `Intl.DateTimeFormat` is the check rather than a name list: what matters is whether the zone can
 * actually be used for arithmetic here, not whether it appears in some table. A fixed offset such
 * as `+02:00` is deliberately rejected — the calendar needs a zone with DST rules, and a fixed
 * offset silently produces wrong local times for half the year.
 */
export const assertTimeZone = (timeZone: string): void => {
  if (timeZone === '') {
    throw new Error('time zone is required (an IANA name such as "Europe/Prague" or "UTC")');
  }
  // ES2024 made `Intl` accept offset zones such as `+02:00`, and Node 25 does. They are refused
  // here rather than passed through: an offset has no DST rules, so a calendar built on one is
  // silently an hour wrong for half the year — which is exactly the failure this module exists to
  // rule out. Every IANA name starts with a letter (`Etc/GMT+5` included).
  if (!/^[A-Za-z]/.test(timeZone)) {
    throw new Error(
      `time zone ${JSON.stringify(timeZone)} is a fixed offset, not an IANA zone: use a name such as "Europe/Prague" so daylight saving is applied`,
    );
  }
  try {
    formatterFor(timeZone).format(0);
  } catch (error) {
    throw new Error(
      `unknown time zone ${JSON.stringify(timeZone)}: expected an IANA name such as "Europe/Prague" or "UTC"`,
      { cause: error },
    );
  }
};

/** True when `timeZone` is an IANA zone this runtime knows. */
export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    assertTimeZone(timeZone);
    return true;
  } catch {
    return false;
  }
};

/**
 * Builds a UTC instant from calendar fields *read as UTC*. Used as the pivot of the offset
 * calculation below, never as a result. `Date.UTC` maps years 0–99 onto 1900–1999, so the year is
 * set through `setUTCFullYear`, which does not.
 */
const utcFromFields = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
};

/** ISO weekday (Monday = 1 … Sunday = 7) of a proleptic Gregorian date. Locale-independent. */
const isoWeekdayOf = (year: number, month: number, day: number): number => {
  const sundayBased = new Date(utcFromFields(year, month, day, 12, 0, 0)).getUTCDay();
  return sundayBased === 0 ? 7 : sundayBased;
};

const partValue = (parts: readonly Intl.DateTimeFormatPart[], type: string): number => {
  const found = parts.find((part) => part.type === type);
  if (found === undefined) {
    throw new Error(`Intl.DateTimeFormat did not produce a "${type}" part`);
  }
  return Number.parseInt(found.value, 10);
};

/** Decomposes an instant into the wall-clock reading an observer in `timeZone` would see. */
export const zonedParts = (instant: Date, timeZone: string): ZonedParts => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const year = partValue(parts, 'year');
  const month = partValue(parts, 'month');
  const day = partValue(parts, 'day');
  // Some ICU builds render midnight as hour 24 under h23; normalise so arithmetic stays in 0…23.
  const hour = partValue(parts, 'hour') % 24;
  return {
    year,
    month,
    day,
    hour,
    minute: partValue(parts, 'minute'),
    second: partValue(parts, 'second'),
    weekday: isoWeekdayOf(year, month, day),
  };
};

/** Offset of `timeZone` from UTC at `instantMs`, in milliseconds (east of UTC is positive). */
export const zoneOffsetMs = (instantMs: number, timeZone: string): number => {
  const parts = zonedParts(new Date(instantMs), timeZone);
  const asUtc = utcFromFields(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // formatToParts truncates to whole seconds; add back the sub-second part so the offset of a
  // zone with a non-whole-second historical offset does not absorb the milliseconds.
  return asUtc - (instantMs - (((instantMs % 1000) + 1000) % 1000));
};

/**
 * The instant at which the wall clock in `timeZone` reads the given local time.
 *
 * Two clock readings a year are not a simple bijection, and both cases are resolved here rather
 * than left to the caller:
 *  - **gap** (spring forward): a local time that never occurs resolves to the instant *after* the
 *    gap, so a deadline is never silently moved backwards.
 *  - **ambiguity** (fall back): a local time that occurs twice resolves to the *later* instant,
 *    which is the one a person watching the clock reaches second.
 */
export const zonedTimeToInstant = (local: Omit<ZonedParts, 'weekday'>, timeZone: string): Date => {
  const pivot = utcFromFields(
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );

  // Both candidates are built up front, from the offset a day before and a day after the reading.
  // A transition moves the offset by at most a couple of hours, so one of these two is the offset
  // in force at the answer — whichever side of the transition it falls on. Deriving the candidates
  // by iterating from `pivot` instead (guess, re-measure, stop when it agrees) is the usual trick
  // and it is wrong: which occurrence the iteration converges on depends on the sign of the zone's
  // offset, so it silently returns the *earlier* occurrence west of UTC.
  const offsetBefore = zoneOffsetMs(pivot - MS_PER_DAY, timeZone);
  const offsetAfter = zoneOffsetMs(pivot + MS_PER_DAY, timeZone);
  const candidates =
    offsetBefore === offsetAfter
      ? [pivot - offsetBefore]
      : [pivot - offsetBefore, pivot - offsetAfter];

  // A candidate is a real answer only if reading it back in the zone gives the requested local
  // time — that is exactly `zoneOffsetMs(candidate) === pivot - candidate`.
  const valid = candidates.filter(
    (candidate) => zoneOffsetMs(candidate, timeZone) === pivot - candidate,
  );

  return valid.length > 0
    ? // Ambiguous (fall back): the later instant, the one a person watching the clock reaches
      // second. Unambiguous: there is only one, so the max is it.
      new Date(Math.max(...valid))
    : // Inside a gap (spring forward): no reading matches. The later candidate is the first instant
      // on the far side, so a deadline is never silently moved backwards.
      new Date(Math.max(...candidates));
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of a zoned reading. */
export const isoDateOf = (parts: Pick<ZonedParts, 'year' | 'month' | 'day'>): IsoDate =>
  `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`;

/** Parses `YYYY-MM-DD` into its numeric fields. Throws on anything else. */
export const parseIsoDate = (value: IsoDate): { year: number; month: number; day: number } => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`expected a YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`${value} is not a calendar date`);
  }
  return { year, month, day };
};

/** The calendar date one day after `value`, in the same (implicit) calendar. */
export const nextIsoDate = (value: IsoDate): IsoDate => {
  const { year, month, day } = parseIsoDate(value);
  const next = new Date(utcFromFields(year, month, day, 12, 0, 0) + MS_PER_DAY);
  return isoDateOf({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  });
};

/** ISO weekday (Monday = 1 … Sunday = 7) of a `YYYY-MM-DD` date. */
export const isoWeekdayOfDate = (value: IsoDate): number => {
  const { year, month, day } = parseIsoDate(value);
  return isoWeekdayOf(year, month, day);
};

/** Parses `HH:MM` into minutes since local midnight. Throws on anything else. */
export const minutesOfDay = (value: string): number => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) {
    throw new Error(`expected a 24-hour HH:MM time, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(match[1] as string, 10) * 60 + Number.parseInt(match[2] as string, 10);
};
