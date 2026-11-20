/**
 * **Every date and time the application writes** (S-28.21, BACKLOG 1608).
 *
 * The screens wrote times four ways — `Intl.DateTimeFormat('en', { hour: 'numeric' })` in the
 * activity rows, `toLocaleTimeString([])` in the merge box, `timeStyle: 'short'` everywhere else,
 * `h23` only for a usage pause — so one page could read *3:05 PM* beside *15:05*. This module is the
 * one place a date or a time of day becomes words, and `time-format-census.test.ts` refuses a
 * `toLocale*String` or an `Intl.DateTimeFormat` anywhere else under `apps/web/src`.
 *
 * **The clock is a setting**: the organisation's `display.clock` (`24h` or `12h`, technical/12),
 * **`24h` by default** — before anybody saves, before the document is read, on a read that failed,
 * and on the worker's local page, which has no organisation to ask. `ClockFromOrganisation`
 * (`app/clock.tsx`) puts the organisation's answer here with {@link setClock}; a formatter called
 * outside a screen (a test, a text builder) reads the same value. There is no per-user override:
 * no user-preference store exists (BACKLOG 1624).
 *
 * Only the words change: the server sends ISO instants and the browser formats them in the
 * reader's own zone, unless a caller names one (a usage pause is shown in the organisation's).
 * A value that is not an instant is shown as it came (or as nothing, for a bare time), never as
 * *Invalid Date*. A zone the browser does not know falls back to UTC rather than throwing: a screen
 * must not die on a setting it only reads.
 *
 * Pure and dependency-free: the worker page's entry imports it and is held to its own budget.
 */

/** How a time of day is written: *14:05* or *2:05 PM*. */
export type Clock = '24h' | '12h';

/** The clock before anybody chooses one (the owner's ruling on BACKLOG 1608). */
export const DEFAULT_CLOCK: Clock = '24h';

let current: Clock = DEFAULT_CLOCK;

/** A stored `display.clock` as a clock: only `12h` departs from the default. */
export const clockOf = (value: unknown): Clock => (value === '12h' ? '12h' : DEFAULT_CLOCK);

/** The clock every formatter here uses unless a call names its own. */
export const setClock = (clock: Clock): void => {
  current = clock;
};

export const currentClock = (): Clock => current;

export interface TimeOptions {
  /** Overrides the clock in force (a test, a preview). */
  readonly clock?: Clock;
  /** An IANA zone; absent is the reader's own. */
  readonly timeZone?: string;
}

const cache = new Map<string, Intl.DateTimeFormat>();

/** One formatter per locale and options; an unknown zone is UTC rather than a `RangeError`. */
const formatter = (locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${locale}\n${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (found === undefined) {
    try {
      found = new Intl.DateTimeFormat(locale, options);
    } catch {
      found = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    }
    cache.set(key, found);
  }
  return found;
};

const cycle = (options: TimeOptions): 'h23' | 'h12' =>
  (options.clock ?? current) === '24h' ? 'h23' : 'h12';

const zone = (options: TimeOptions): { timeZone?: string } =>
  options.timeZone === undefined ? {} : { timeZone: options.timeZone };

const instant = (value: string | number): number =>
  typeof value === 'number' ? value : Date.parse(value);

/** *Nov 5, 2026, 16:39* (or *4:39 PM*) — or the text itself when it is not an instant. */
export const formatDateTime = (iso: string, options: TimeOptions = {}): string => {
  const at = instant(iso);
  return Number.isNaN(at)
    ? iso
    : formatter('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        hourCycle: cycle(options),
        ...zone(options),
      }).format(at);
};

/** *16:39* (or *4:39 PM*) — a time of day alone; nothing when it is not an instant. */
export const formatTime = (value: string | number, options: TimeOptions = {}): string => {
  const at = instant(value);
  if (Number.isNaN(at)) return '';
  const hourCycle = cycle(options);
  return formatter('en', {
    hour: hourCycle === 'h23' ? '2-digit' : 'numeric',
    minute: '2-digit',
    hourCycle,
    ...zone(options),
  }).format(at);
};

/** *16:39:12* (or *4:39:12 PM*) — a log line's time; nothing when it is not an instant. */
export const formatTimeWithSeconds = (
  value: string | number,
  options: TimeOptions = {},
): string => {
  const at = instant(value);
  if (Number.isNaN(at)) return '';
  const hourCycle = cycle(options);
  return formatter('en', {
    hour: hourCycle === 'h23' ? '2-digit' : 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hourCycle,
    ...zone(options),
  }).format(at);
};

/** *Nov 5, 2026* — the day an instant falls on in the reader's zone; the text itself if it is none. */
export const formatDate = (iso: string, options: TimeOptions = {}): string => {
  const at = instant(iso);
  return Number.isNaN(at)
    ? iso
    : formatter('en', { dateStyle: 'medium', ...zone(options) }).format(at);
};

/**
 * A civil date (`2026-09-10`) as every screen writes a date — *Sep 10, 2026* — read at UTC
 * midnight and formatted in UTC, so the reader's own zone never moves it a day. A value that is not
 * a date is shown as it came.
 */
export const formatCivilDate = (day: string): string => {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(at)
    ? formatter('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(at)
    : day;
};

/** Whether two instants fall on the same calendar day in `timeZone` (the reader's own if absent). */
export const sameDay = (a: number, b: number, timeZone?: string): boolean => {
  const day = formatter('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return day.format(a) === day.format(b);
};

/** *Tue 4 Nov* — the day a time falls on, when it is not today. */
export const formatWeekdayDate = (at: number, timeZone?: string): string =>
  formatter('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
