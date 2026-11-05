/**
 * **A usage limit's pause, in words** (WP-285, TD-031 decision 11, BD-032 decision 7): *Paused —
 * usage limit until 14:00*. One spelling for the Workers screen, the run page and the worker's own
 * page, so a developer reads the same sentence wherever they look.
 *
 * The time is `HH:MM` on a 24-hour clock **in the given zone** — the organisation's on the
 * platform's screens, the browser's own on the worker's local page (the machine it runs on) — and
 * gains the day (`Tue 4 Nov, 14:00`) when the reset is not on today's date in that zone, because a
 * weekly limit resets days later. `estimated` (the limit named no reset time, so the instant is the
 * claimant's default pause) says *until about*. A zone the browser does not know falls back to UTC
 * rather than throwing: the screen must not die on a setting it only reads.
 *
 * Pure and dependency-free: the worker page's entry imports it and is held to its own 120 kB budget.
 */

/** What a pause says: when it ends, whether that is a guess, and the zone it is shown in. */
export interface UsagePause {
  readonly until: string;
  readonly estimated: boolean;
  /** An IANA zone; absent is the browser's own. */
  readonly timezone?: string;
}

const formatterFor = (
  timezone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      ...options,
      ...(timezone === undefined ? {} : { timeZone: timezone }),
    });
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' });
  }
};

/** `14:00`, or `Tue 4 Nov, 14:00` when `iso` is not on `nowMs`'s date in `timezone`. */
export const usagePauseTime = (iso: string, nowMs: number, timezone?: string): string => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const time = formatterFor(timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = formatterFor(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const clock = time.format(at);
  if (day.format(at) === day.format(nowMs)) return clock;
  const date = formatterFor(timezone, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${date.format(at)}, ${clock}`;
};

/** *Paused — usage limit until 14:00* (or *until about 14:00*). */
export const usagePauseWords = (pause: UsagePause, nowMs: number): string =>
  `Paused — usage limit until ${pause.estimated ? 'about ' : ''}${usagePauseTime(
    pause.until,
    nowMs,
    pause.timezone,
  )}`;
