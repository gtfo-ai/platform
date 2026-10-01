/**
 * Jobs and working-calendar configuration read from the environment (technical/12, TD-020).
 *
 * Naming follows the rest of `.env.example`: standard 12-factor variables stay unprefixed (`TZ`),
 * platform settings take the neutral `APP_` prefix. Nothing here is a secret, so there is no
 * `_FILE` variant.
 *
 * The working calendar is seeded from the environment and later overridden per organisation
 * (technical/03 `organizations.timezone` / `settings`). Both layers produce the same
 * `WorkingCalendarConfig`, so the resolver never has to care which it got — and neither ever falls
 * back to the host's zone.
 */
import {
  createWorkingCalendar,
  defaultWorkingCalendarConfig,
  type WorkingCalendar,
  type WorkingCalendarConfig,
} from '@platform/application';
import * as z from 'zod';
import { DEFAULT_JOBS_SCHEMA } from './pg-boss-jobs.js';

/** The environment as this module reads it: a plain string map, so tests can pass a literal. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Why this process refuses `APP_JOBS_SCHEMA`, or `null` when it is unset, blank or `pgboss` — WP-106,
 * PROGRESS backlog 296, option (b).
 *
 * **The value is fixed at `pgboss`.** `migrate` installs pg-boss, declares every job queue
 * (WP-86) and grants the app role in the `pgboss` schema, and it reads no variable for another:
 * `runMigrations` takes `pgBossSchema` and `migrate` passes none, and `platform_apply_grants`
 * (migration 0001) grants on the literal. So a process told to look elsewhere would find nothing
 * `migrate` installed. Before WP-106 the expected failure was pg-boss's own *"pg-boss is not
 * installed"* at start, which names neither the variable nor `migrate` (read off pg-boss 12.30.0's
 * `check()` in backlog 296, **predicted, not measured**). Every process that reads the
 * variable — the server's roles through {@link loadJobsConfig}, and `migrate` itself — refuses to
 * start on any other value and names both. Making the schema configurable would be a migration
 * that replaces `platform_apply_grants` and a `migrate` that reads the variable (the entry's option
 * (a)); it was ruled out at M6 rather than built.
 */
export const jobsSchemaRefusal = (env: EnvLike): string | null => {
  const raw = env.APP_JOBS_SCHEMA?.trim();
  if (raw === undefined || raw === '' || raw === DEFAULT_JOBS_SCHEMA) {
    return null;
  }
  return (
    `APP_JOBS_SCHEMA is ${JSON.stringify(raw.slice(0, 64))}, and the only value this release accepts is "${DEFAULT_JOBS_SCHEMA}": ` +
    `the migrate service installs pg-boss, declares the job queues and grants the app role in the "${DEFAULT_JOBS_SCHEMA}" schema ` +
    'and reads no variable for another, so a process looking anywhere else would find nothing migrate installed. ' +
    `Unset APP_JOBS_SCHEMA or set it to ${DEFAULT_JOBS_SCHEMA}`
  );
};

export const jobsConfigSchema = z.strictObject({
  /**
   * Schema pg-boss owns: always `pgboss`, the one `migrate` installs into ({@link
   * jobsSchemaRefusal} refuses `APP_JOBS_SCHEMA` set to anything else).
   */
  schema: z.literal(DEFAULT_JOBS_SCHEMA),
  /** Default worker poll interval. pg-boss's floor is 0.5 s. */
  pollingIntervalSeconds: z.number().min(0.5).max(3600),
  /** How often the cron table is re-read; pg-boss caps it at 45 s. */
  cronMonitorIntervalSeconds: z.int().min(1).max(45),
});

export type JobsConfig = z.infer<typeof jobsConfigSchema>;

export const JOBS_CONFIG_DEFAULTS = {
  schema: DEFAULT_JOBS_SCHEMA,
  pollingIntervalSeconds: 2,
  cronMonitorIntervalSeconds: 30,
} as const;

const SOURCE_VARIABLE: Record<string, string> = {
  schema: 'APP_JOBS_SCHEMA',
  pollingIntervalSeconds: 'APP_JOBS_POLL_INTERVAL_SECONDS',
  cronMonitorIntervalSeconds: 'APP_JOBS_CRON_INTERVAL_SECONDS',
  timezone: 'TZ',
  working_weekdays: 'APP_WORKING_DAYS',
  working_hours: 'APP_WORKING_HOURS',
  holidays: 'APP_HOLIDAYS',
};

/** Turns a `ZodError` into one line an operator can act on: the variable name plus the problem. */
function configError(what: string, error: z.ZodError): Error {
  const problems = error.issues.map((issue) => {
    const field = String(issue.path[0] ?? '');
    return `${SOURCE_VARIABLE[field] ?? field} ${issue.message}`;
  });
  return new Error(`invalid ${what}: ${problems.join('; ')}`, { cause: error });
}

/** Parses a numeric variable, leaving anything unparseable in place so the schema names it. */
const numberFromEnv = (raw: string | undefined, fallback: number): unknown => {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^\d+(\.\d+)?$/.test(value) ? Number.parseFloat(value) : value;
};

export const loadJobsConfig = (env: EnvLike = process.env): JobsConfig => {
  const schemaRefusal = jobsSchemaRefusal(env);
  if (schemaRefusal !== null) {
    throw new Error(`invalid jobs configuration: ${schemaRefusal}`);
  }
  const result = jobsConfigSchema.safeParse({
    schema: JOBS_CONFIG_DEFAULTS.schema,
    pollingIntervalSeconds: numberFromEnv(
      env.APP_JOBS_POLL_INTERVAL_SECONDS,
      JOBS_CONFIG_DEFAULTS.pollingIntervalSeconds,
    ),
    cronMonitorIntervalSeconds: numberFromEnv(
      env.APP_JOBS_CRON_INTERVAL_SECONDS,
      JOBS_CONFIG_DEFAULTS.cronMonitorIntervalSeconds,
    ),
  });

  if (!result.success) {
    throw configError('jobs configuration', result.error);
  }
  return result.data;
};

/**
 * Splits a comma-separated list.
 *
 * An unset or blank variable is an empty list, which is how "not configured" is spelled. Anything
 * else must be a clean list: an empty entry (`1,,2`, a trailing comma) is an error rather than
 * something quietly dropped, because a list this short is almost always hand-edited and a dropped
 * entry moves every deadline in the system with nothing in the log to say so.
 */
const commaList = (raw: string | undefined, variable: string): string[] => {
  const value = (raw ?? '').trim();
  if (value === '') {
    return [];
  }
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) {
    throw new Error(
      `invalid working calendar: ${variable} has an empty entry (${JSON.stringify(raw)}); remove the stray comma`,
    );
  }
  return entries;
};

/** `HH:MM-HH:MM`, both halves required. */
const WORKING_HOURS_PATTERN = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;

/**
 * Builds the working-calendar configuration from the environment.
 *
 * `TZ` is the seed technical/12 names ("organisation default timezone seed"), and it is read as an
 * *explicit* variable rather than through the host clock: an unset `TZ` means UTC here, never
 * "whatever zone this container happens to be in".
 */
export const loadWorkingCalendarConfig = (env: EnvLike = process.env): WorkingCalendarConfig => {
  const defaults = defaultWorkingCalendarConfig();
  const weekdays = commaList(env.APP_WORKING_DAYS, 'APP_WORKING_DAYS');

  const hours = env.APP_WORKING_HOURS?.trim() ?? '';
  const match = hours === '' ? null : WORKING_HOURS_PATTERN.exec(hours);
  if (hours !== '' && match === null) {
    // A half-written window used to fall back to the default end time, so `APP_WORKING_HOURS=09:00`
    // silently meant 09:00–17:00 and every deadline moved with nothing in the log.
    throw new Error(
      `invalid working calendar: APP_WORKING_HOURS must be exactly HH:MM-HH:MM, got ${JSON.stringify(env.APP_WORKING_HOURS)}`,
    );
  }

  return {
    timezone: env.TZ?.trim() || defaults.timezone,
    working_weekdays:
      weekdays.length === 0
        ? defaults.working_weekdays
        : weekdays.map((day) => (/^\d+$/.test(day) ? Number.parseInt(day, 10) : Number.NaN)),
    working_hours: {
      start: match?.[1] ?? defaults.working_hours.start,
      end: match?.[2] ?? defaults.working_hours.end,
    },
    holidays: commaList(env.APP_HOLIDAYS, 'APP_HOLIDAYS'),
  };
};

/**
 * Builds and validates the working calendar in one step, naming the offending variable when the
 * environment is wrong.
 */
export const loadWorkingCalendar = (env: EnvLike = process.env): WorkingCalendar => {
  try {
    return createWorkingCalendar(loadWorkingCalendarConfig(env));
  } catch (error) {
    const hint = [
      'APP_WORKING_DAYS (ISO weekday numbers, e.g. 1,2,3,4,5)',
      'APP_WORKING_HOURS (HH:MM-HH:MM)',
      'APP_HOLIDAYS (comma-separated YYYY-MM-DD)',
      'TZ (IANA zone)',
    ].join(', ');
    throw new Error(`${(error as Error).message}. Check ${hint}`, { cause: error });
  }
};
