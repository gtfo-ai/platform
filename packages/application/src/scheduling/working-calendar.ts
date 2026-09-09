/**
 * The working-day calendar that turns `limits.question_timeout` — technical/12 writes it as
 * `1 working day` — into an absolute deadline (TD-004: `question.timeout` and
 * `question.reminder` compute `startAfter` on this calendar).
 *
 * Pure and total: given the same calendar, anchor and duration it returns the same instant on
 * every host, in every process time zone. The zone is a field of the calendar, never
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` — see `zoned-time.ts`.
 *
 * **Model.** A calendar defines, for every date, at most one *working window*: on a working
 * weekday that is not a holiday, `[working_hours.start, working_hours.end)` read in the calendar's
 * zone. "Working time" is time inside those windows and nothing else, so one routine answers every
 * flavour of the duration grammar:
 *
 *   `N working minutes` → advance N minutes of working time
 *   `N working hours`   → advance 60·N
 *   `N working days`    → advance N × the length of one working window
 *
 * A duration without `working` is plain elapsed time (a minute is a minute at 03:00 on a Sunday),
 * because that is what "30 minutes" says.
 *
 * Sources: docs/technical/12-configuration-and-schemas.md (`question_timeout`),
 * docs/technical/02-domain-model-and-events.md (Question state machine), BD-006, Q8, Q36.
 */
import { durationSchema } from '@platform/contracts';
import * as z from 'zod';
import {
  assertTimeZone,
  type IsoDate,
  isoDateOf,
  isoWeekdayOfDate,
  minutesOfDay,
  nextIsoDate,
  parseIsoDate,
  zonedParts,
  zonedTimeToInstant,
} from './zoned-time.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * How far `advanceWorkingTime` will walk before giving up. Ten years of dates is far past any
 * legitimate timeout and stops a calendar whose holidays swallow every working day from looping.
 */
const MAX_CALENDAR_DAYS_SCANNED = 3660;

/** ISO-8601 weekday: Monday = 1 … Sunday = 7. */
export const isoWeekdaySchema = z.int().min(1).max(7);

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected a 24-hour HH:MM time');

/**
 * The organisation's working calendar.
 *
 * snake_case because it is a configuration shape on the wire (CLAUDE.md § Conventions); the
 * exported TypeScript identifiers stay camelCase. It is deliberately *not* in
 * `packages/contracts` yet: technical/12 does not define it (Q36), so it lives with the code that
 * needs it until the organisation-settings contract lands.
 */
export const workingCalendarSchema = z
  .strictObject({
    /** IANA zone. Seeded from `TZ` (technical/12), overridden by the organisation setting. */
    timezone: z.string().min(1),
    /** ISO weekdays that can carry working time. Default Monday–Friday. */
    working_weekdays: z.array(isoWeekdaySchema).min(1).max(7),
    /** The window inside a working day, in the calendar's own zone. `start` must precede `end`. */
    working_hours: z.strictObject({ start: timeOfDaySchema, end: timeOfDaySchema }),
    /** Dates with no working time at all, `YYYY-MM-DD` in the calendar's zone. */
    holidays: z.array(z.iso.date()),
  })
  .refine(
    (value) => minutesOfDay(value.working_hours.start) < minutesOfDay(value.working_hours.end),
    {
      message: 'working_hours.start must be earlier in the day than working_hours.end',
      path: ['working_hours'],
    },
  )
  .refine((value) => new Set(value.working_weekdays).size === value.working_weekdays.length, {
    message: 'working_weekdays must not repeat a weekday',
    path: ['working_weekdays'],
  })
  .refine((value) => value.holidays.every((date) => !Number.isNaN(Date.parse(date))), {
    message: 'holidays must be calendar dates',
    path: ['holidays'],
  });

export type WorkingCalendarConfig = z.infer<typeof workingCalendarSchema>;

/**
 * Defaults when nothing is configured: Monday–Friday, 09:00–17:00, no holidays, UTC.
 *
 * Q36 records why these are the defaults rather than something read from a public holiday feed:
 * the platform never guesses a country's holidays, it uses the list the organisation gives it.
 * A function rather than a constant, so no caller can mutate the shared arrays.
 */
export const defaultWorkingCalendarConfig = (): WorkingCalendarConfig => ({
  timezone: 'UTC',
  working_weekdays: [1, 2, 3, 4, 5],
  working_hours: { start: '09:00', end: '17:00' },
  holidays: [],
});

/** The default `limits.question_timeout` (BD-006, Q8, technical/12). */
export const DEFAULT_QUESTION_TIMEOUT = '1 working day' as const;

/** A validated calendar: the parsed configuration plus the derived numbers used for arithmetic. */
export interface WorkingCalendar {
  readonly config: WorkingCalendarConfig;
  readonly timezone: string;
  /** Minutes since local midnight at which a working day opens. */
  readonly startMinute: number;
  /** Minutes since local midnight at which a working day closes. */
  readonly endMinute: number;
  /** Length of one working window, in minutes — what "1 working day" means. */
  readonly minutesPerWorkingDay: number;
  readonly workingWeekdays: ReadonlySet<number>;
  readonly holidays: ReadonlySet<IsoDate>;
}

/**
 * Validates a calendar configuration and precomputes what the arithmetic needs.
 *
 * Throws a single `Error` naming every problem, so a misconfigured organisation reads its fix out
 * of one log line rather than out of a serialised `ZodError`.
 */
export const createWorkingCalendar = (
  input: Readonly<Record<string, unknown>> = defaultWorkingCalendarConfig(),
): WorkingCalendar => {
  const result = workingCalendarSchema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`,
    );
    throw new Error(`invalid working calendar: ${problems.join('; ')}`, { cause: result.error });
  }

  const config = result.data;
  assertTimeZone(config.timezone);
  for (const holiday of config.holidays) {
    parseIsoDate(holiday);
  }

  const startMinute = minutesOfDay(config.working_hours.start);
  const endMinute = minutesOfDay(config.working_hours.end);

  return {
    config,
    timezone: config.timezone,
    startMinute,
    endMinute,
    minutesPerWorkingDay: endMinute - startMinute,
    workingWeekdays: new Set(config.working_weekdays),
    holidays: new Set(config.holidays),
  };
};

/** True when `date` (a `YYYY-MM-DD` in the calendar's zone) carries working time. */
export const isWorkingDate = (calendar: WorkingCalendar, date: IsoDate): boolean =>
  calendar.workingWeekdays.has(isoWeekdayOfDate(date)) && !calendar.holidays.has(date);

/** The calendar date `instant` falls on, read in the calendar's zone. */
export const localDateOf = (calendar: WorkingCalendar, instant: Date): IsoDate =>
  isoDateOf(zonedParts(instant, calendar.timezone));

/**
 * The absolute `[start, end)` of a date's working window, or `null` on a weekend or holiday.
 *
 * Both edges are resolved through the zone, so a DST transition inside the window shortens or
 * lengthens it in absolute terms exactly as the wall clock says it should.
 */
export const workingWindow = (
  calendar: WorkingCalendar,
  date: IsoDate,
): { readonly start: Date; readonly end: Date } | null => {
  if (!isWorkingDate(calendar, date)) {
    return null;
  }
  const { year, month, day } = parseIsoDate(date);
  const at = (minute: number): Date =>
    zonedTimeToInstant(
      { year, month, day, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 },
      calendar.timezone,
    );
  return { start: at(calendar.startMinute), end: at(calendar.endMinute) };
};

/**
 * Advances `from` by `minutes` of *working* time.
 *
 * `minutes = 0` is meaningful and useful: it returns the first working instant at or after
 * `from`, which is what "start the clock when the office opens" means.
 */
export const advanceWorkingTime = (
  calendar: WorkingCalendar,
  from: Date,
  minutes: number,
): Date => {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`working minutes must be a non-negative finite number, got ${minutes}`);
  }

  let remainingMs = minutes * MS_PER_MINUTE;
  const fromMs = from.getTime();
  let date = localDateOf(calendar, from);

  for (let scanned = 0; scanned <= MAX_CALENDAR_DAYS_SCANNED; scanned += 1) {
    const window = workingWindow(calendar, date);
    if (window !== null) {
      const segmentStart = Math.max(fromMs, window.start.getTime());
      const available = window.end.getTime() - segmentStart;
      if (available > 0) {
        if (remainingMs <= available) {
          return new Date(segmentStart + remainingMs);
        }
        remainingMs -= available;
      }
    }
    date = nextIsoDate(date);
  }

  throw new Error(
    `no working time found within ${MAX_CALENDAR_DAYS_SCANNED} days of ${from.toISOString()}: check working_weekdays and holidays`,
  );
};

/** A `question_timeout`-style duration, split into its parts. */
export interface ParsedDuration {
  readonly amount: number;
  readonly unit: 'minutes' | 'hours' | 'days';
  /** `true` for `N working …`, which is measured on the calendar rather than on the wall clock. */
  readonly working: boolean;
}

/**
 * Parses the duration grammar `packages/contracts` publishes (`durationSchema`), so what the
 * configuration accepts and what this module can resolve cannot drift apart.
 */
export const parseDuration = (text: string): ParsedDuration => {
  const parsed = durationSchema.safeParse(text);
  if (!parsed.success) {
    throw new Error(
      `invalid duration ${JSON.stringify(text)}: expected e.g. "30 minutes", "2 hours" or "1 working day"`,
      { cause: parsed.error },
    );
  }
  const match = /^(\d+) (working )?(minute|hour|day)s?$/.exec(parsed.data);
  if (match === null) {
    throw new Error(`invalid duration ${JSON.stringify(text)}`);
  }
  return {
    amount: Number.parseInt(match[1] as string, 10),
    unit: `${match[3] as string}s` as ParsedDuration['unit'],
    working: match[2] !== undefined,
  };
};

/**
 * Resolves a duration against the calendar, from an anchor instant.
 *
 * This is what a question deadline, a reminder offset or a take-over inactivity timeout is
 * computed with; the caller passes the instant the clock starts, never "now" implicitly.
 */
export const resolveDeadline = (calendar: WorkingCalendar, from: Date, duration: string): Date => {
  const { amount, unit, working } = parseDuration(duration);

  if (!working) {
    const perUnit =
      unit === 'minutes' ? MS_PER_MINUTE : unit === 'hours' ? MS_PER_HOUR : MS_PER_DAY;
    return new Date(from.getTime() + amount * perUnit);
  }

  const minutes =
    unit === 'minutes'
      ? amount
      : unit === 'hours'
        ? amount * 60
        : amount * calendar.minutesPerWorkingDay;

  return advanceWorkingTime(calendar, from, minutes);
};

/**
 * The deadline of a question asked at `askedAt` (technical/02: `open → expired` after
 * `limits.question_timeout`, default `1 working day`).
 */
export const questionTimeoutAt = (
  calendar: WorkingCalendar,
  askedAt: Date,
  timeout: string = DEFAULT_QUESTION_TIMEOUT,
): Date => resolveDeadline(calendar, askedAt, timeout);

/**
 * Reminder instants for a question, one per offset, each measured from `askedAt` on the same
 * calendar (technical/02: "reminders at configurable offsets"). Offsets at or after the deadline
 * are dropped: a reminder that would arrive after the escalation is noise.
 */
export const questionReminderTimes = (
  calendar: WorkingCalendar,
  askedAt: Date,
  offsets: readonly string[],
  timeout: string = DEFAULT_QUESTION_TIMEOUT,
): readonly Date[] => {
  const deadline = questionTimeoutAt(calendar, askedAt, timeout).getTime();
  return offsets
    .map((offset) => resolveDeadline(calendar, askedAt, offset))
    .filter((at) => at.getTime() > askedAt.getTime() && at.getTime() < deadline)
    .sort((left, right) => left.getTime() - right.getTime());
};
