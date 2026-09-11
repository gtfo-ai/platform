/**
 * Database configuration read from the environment (technical/12, TD-020).
 *
 * Naming: standard 12-factor variables stay unprefixed (`DATABASE_URL`), platform settings take
 * the neutral `APP_` prefix, and every value that may hold a secret also accepts a `<NAME>_FILE`
 * variant pointing at a file — the Docker secrets convention. The `_FILE` variant wins when both
 * are set, matching the rest of `.env.example`.
 */
import { readFileSync } from 'node:fs';
import * as z from 'zod';

/** The environment as this module reads it: a plain string map, so tests can pass a literal. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Reads `NAME`, preferring the contents of the file named by `NAME_FILE` when that is set.
 * Trailing whitespace is stripped: a secret file written by an operator almost always ends in a
 * newline, and a newline inside a connection string is a confusing failure.
 */
export const readEnvWithFile = (name: string, env: EnvLike): string | undefined => {
  const filePath = env[`${name}_FILE`]?.trim();
  if (filePath !== undefined && filePath !== '') {
    return readFileSync(filePath, 'utf8').trimEnd();
  }
  const direct = env[name];
  return direct === undefined || direct.trim() === '' ? undefined : direct;
};

/**
 * A bare, lower-case SQL identifier — what PostgreSQL stores unquoted. Role names are interpolated
 * into `SET ROLE`, so they are constrained here rather than escaped later.
 */
const roleNameSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*$/, 'expected a bare lower-case SQL identifier');

/** Field name -> the environment variable it comes from, so an error names what to fix. */
const SOURCE_VARIABLE: Record<string, string> = {
  url: 'DATABASE_URL',
  appRole: 'APP_DB_APP_ROLE',
  poolMax: 'APP_DB_POOL_MAX',
  connectionTimeoutMs: 'APP_DB_CONNECTION_TIMEOUT_MS',
  partitionMonthsAhead: 'APP_DB_PARTITION_MONTHS_AHEAD',
  transcriptRetentionDays: 'APP_TRANSCRIPT_RETENTION_DAYS',
};

export const databaseConfigSchema = z.strictObject({
  /** libpq connection string. Holds a password, hence the `_FILE` variant. */
  url: z.string().min(1, 'is required (or set DATABASE_URL_FILE to a file holding it)'),
  /**
   * Role the runtime pool switches to with `SET ROLE` after connecting. Empty disables the switch,
   * for a deployment whose login role already carries exactly the right grants.
   */
  appRole: roleNameSchema.or(z.literal('')),
  /**
   * Upper bound on pooled connections.
   *
   * The dispatcher holds **two** at once per concurrent dispatch — one for the transaction that
   * owns the event's queue row for the length of the dispatch, one for the handler running inside
   * it — so this has to exceed twice `APP_DISPATCH_MAX_CONCURRENCY`. `createEventing` refuses a
   * combination that cannot work rather than letting it deadlock on the pool.
   */
  poolMax: z.int().min(1).max(1000),
  /**
   * How long a caller waits for a free pooled connection before failing.
   *
   * `pg` waits **for ever** by default, which turns pool exhaustion into a silent hang with no log
   * line and no failing request. A bounded wait turns the same mistake into an error: the dispatch
   * transaction rolls back, the event stays in `event_dispatch`, and the sweep retries it.
   */
  connectionTimeoutMs: z.int().min(100).max(600_000),
  /** How many months of partitions the migrator and the maintenance job keep ahead of today. */
  partitionMonthsAhead: z.int().min(0).max(120),
  /**
   * Transcript retention. Null means keep forever, which is the default (technical/03, Q13).
   * Only whole `run_messages` partitions are dropped; metadata, artifacts, events and cost stay.
   */
  transcriptRetentionDays: z.int().min(1).nullable(),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export const DATABASE_CONFIG_DEFAULTS = {
  appRole: 'platform_app',
  /**
   * 13 at WP-15b, from 10.
   *
   * `apps/server`'s `requiredPoolConnections` refuses to start below its own floor, and that floor
   * rose to **11** for `ROLE=all` when an outbound provider call started writing an audit row from
   * inside a dispatch handler's transaction — a third connection per in-flight dispatch. 10 would
   * therefore no longer boot. 13 keeps the two connections of slack the previous default carried
   * over its floor of 8; it is a floor plus slack, not a capacity plan, and `.env.example` says so.
   */
  poolMax: 13,
  connectionTimeoutMs: 10_000,
  partitionMonthsAhead: 3,
} as const;

/**
 * Builds the database configuration from an environment.
 *
 * Throws a single `Error` naming every offending variable — a misconfigured deployment should read
 * its own fix out of the first line of the log, not out of a serialised `ZodError`.
 */
export const loadDatabaseConfig = (env: EnvLike = process.env): DatabaseConfig => {
  const retention = env.APP_TRANSCRIPT_RETENTION_DAYS?.trim();

  const result = databaseConfigSchema.safeParse({
    url: readEnvWithFile('DATABASE_URL', env) ?? '',
    appRole: env.APP_DB_APP_ROLE?.trim() ?? DATABASE_CONFIG_DEFAULTS.appRole,
    poolMax: numberFromEnv(env.APP_DB_POOL_MAX, DATABASE_CONFIG_DEFAULTS.poolMax),
    connectionTimeoutMs: numberFromEnv(
      env.APP_DB_CONNECTION_TIMEOUT_MS,
      DATABASE_CONFIG_DEFAULTS.connectionTimeoutMs,
    ),
    partitionMonthsAhead: numberFromEnv(
      env.APP_DB_PARTITION_MONTHS_AHEAD,
      DATABASE_CONFIG_DEFAULTS.partitionMonthsAhead,
    ),
    transcriptRetentionDays:
      retention === undefined || retention === '' ? null : numberFromEnv(retention, null),
  });

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const field = String(issue.path[0] ?? '');
      return `${SOURCE_VARIABLE[field] ?? field} ${issue.message}`;
    });
    throw new Error(`invalid database configuration: ${problems.join('; ')}`, {
      cause: result.error,
    });
  }

  return result.data;
};

/**
 * Parses a numeric environment variable, leaving anything unparseable in place so the schema
 * reports it against the right variable rather than throwing here.
 */
const numberFromEnv = (raw: string | undefined, fallback: number | null): unknown => {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
};
