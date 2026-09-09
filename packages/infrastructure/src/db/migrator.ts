/**
 * The `migrate` entrypoint's engine (TD-019, technical/11 § Compose).
 *
 * Guarantees:
 *  - **One writer.** A session-level advisory lock is taken before anything is inspected, so two
 *    `migrate` containers started at once serialise instead of racing.
 *  - **Idempotent.** Each file is applied at most once, recorded in `platform_migrations` inside
 *    the same transaction as its own DDL. A second run applies nothing.
 *  - **Forward-only.** An applied file whose checksum changed is an error, not a re-apply.
 *  - **Self-reporting.** The returned report says exactly what was applied, installed and created.
 *
 * pg-boss owns its own schema (TD-004), so it is installed through its own API rather than copied
 * into a migration file; grants are re-applied afterwards so the application role can use it.
 */
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { loadMigrations, type Migration, migrationsDirectory } from './migrations.js';
import { TRANSCRIPT_RETENTION_SCOPE } from './partitions.js';

/**
 * Advisory-lock key for schema migrations: the two halves of "PLAF"/"MIGR" as int4. Any other
 * advisory lock in the system must use a different pair.
 */
export const MIGRATION_LOCK_KEY = [0x504c4146, 0x4d494752] as const;

export const DEFAULT_PGBOSS_SCHEMA = 'pgboss';
export const DEFAULT_APP_ROLE = 'platform_app';
export const DEFAULT_PARTITION_MONTHS_AHEAD = 3;

export interface MigrateOptions {
  readonly connectionString: string;
  /** Role the least-privilege grants target. Empty string skips the grant step entirely. */
  readonly appRole?: string;
  /** Months of partitions to create ahead of the current one. */
  readonly partitionMonthsAhead?: number;
  /**
   * Transcript retention window written into `platform_table_policy`. Null — the default — keeps
   * transcripts forever (Q13). Storing it here rather than passing it to the drop function is what
   * stops the application role from choosing its own window.
   */
  readonly transcriptRetentionDays?: number | null;
  readonly pgBossSchema?: string;
  readonly migrationsDirectory?: string;
  /** Structured progress sink. Defaults to silence; the CLI passes a writer. */
  readonly log?: (event: MigrateEvent) => void;
}

export type MigrateEvent =
  | { readonly kind: 'lock_wait' }
  | { readonly kind: 'lock_acquired' }
  | { readonly kind: 'migration_applied'; readonly name: string; readonly durationMs: number }
  | { readonly kind: 'migration_skipped'; readonly name: string }
  | { readonly kind: 'pgboss'; readonly schema: string; readonly version: number | null }
  | { readonly kind: 'grants'; readonly role: string }
  | { readonly kind: 'retention'; readonly scope: string; readonly days: number | null }
  | { readonly kind: 'partitions'; readonly created: readonly string[] }
  /** A `RAISE NOTICE`/`WARNING` from the server — how the SQL reports what an operator must fix. */
  | { readonly kind: 'notice'; readonly message: string };

export interface MigrateReport {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly pgBossSchema: string;
  readonly pgBossSchemaVersion: number | null;
  readonly grantsAppliedTo: string | null;
  readonly transcriptRetentionDays: number | null;
  readonly partitionsCreated: readonly string[];
  readonly durationMs: number;
}

/** The subset of a `pg.Client` the migrator uses; a test seam, not a public abstraction. */
export interface MigrationClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
  on(event: 'notice', listener: (notice: { message?: string }) => void): unknown;
  end(): Promise<void>;
}

/** Injected so the unit tier can drive every branch without a database. */
export interface MigrateDependencies {
  readonly connect: (connectionString: string) => Promise<MigrationClient>;
  readonly installJobs: (connectionString: string, schema: string) => Promise<number | null>;
}

/** The log table is created outside the migration files: it has to exist to record the first one. */
const MIGRATION_LOG_DDL = `
  create table if not exists platform_migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now(),
    duration_ms integer not null
  )
`;

const connectWithPg = async (connectionString: string): Promise<MigrationClient> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client as unknown as MigrationClient;
};

const installPgBoss = async (connectionString: string, schema: string): Promise<number | null> => {
  // `migrate: true` installs or upgrades the schema; supervision and scheduling are the running
  // application's job (WP-05), not the one-shot migrate container's.
  const boss = new PgBoss({
    connectionString,
    schema,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  // pg-boss surfaces background problems as 'error' events; an unhandled one would crash the
  // process during what should be a quiet install.
  boss.on('error', () => {});
  try {
    await boss.start();
    return await boss.schemaVersion();
  } finally {
    // `close` returns the connections; nothing is in flight, so there is nothing to drain.
    await boss.stop({ close: true, graceful: false });
  }
};

export const defaultMigrateDependencies: MigrateDependencies = {
  connect: connectWithPg,
  installJobs: installPgBoss,
};

const readApplied = async (client: MigrationClient): Promise<Map<string, string>> => {
  const { rows } = await client.query<{ name: string; checksum: string }>(
    'select name, checksum from platform_migrations order by name',
  );
  return new Map(rows.map((row) => [row.name, row.checksum]));
};

const applyMigration = async (client: MigrationClient, migration: Migration): Promise<number> => {
  const started = Date.now();
  await client.query('begin');
  try {
    await client.query(migration.sql);
    const durationMs = Date.now() - started;
    await client.query(
      'insert into platform_migrations (name, checksum, duration_ms) values ($1, $2, $3)',
      [migration.name, migration.checksum, durationMs],
    );
    await client.query('commit');
    return durationMs;
  } catch (error) {
    await client.query('rollback');
    throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, {
      cause: error,
    });
  }
};

/**
 * Fails when the database carries a migration this build does not know about — the "app refuses to
 * start when the DB schema is newer than the code" rule of TD-019. Safe to call from any process.
 */
export const findUnknownMigrations = async (
  client: MigrationClient,
  known: readonly Migration[] = loadMigrations(),
): Promise<string[]> => {
  const exists = await client.query<{ present: boolean }>(
    "select to_regclass('public.platform_migrations') is not null as present",
  );
  if (exists.rows[0]?.present !== true) {
    return [];
  }
  const { rows } = await client.query<{ name: string }>('select name from platform_migrations');
  const knownNames = new Set(known.map((migration) => migration.name));
  return rows.map((row) => row.name).filter((name) => !knownNames.has(name));
};

/**
 * Applies every pending migration under an advisory lock, then installs pg-boss, records the
 * retention window, creates the partitions the next few months need and re-applies the
 * least-privilege grants.
 */
export const runMigrations = async (
  options: MigrateOptions,
  dependencies: MigrateDependencies = defaultMigrateDependencies,
): Promise<MigrateReport> => {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const appRole = options.appRole ?? DEFAULT_APP_ROLE;
  const monthsAhead = options.partitionMonthsAhead ?? DEFAULT_PARTITION_MONTHS_AHEAD;
  const retentionDays = options.transcriptRetentionDays ?? null;
  const pgBossSchema = options.pgBossSchema ?? DEFAULT_PGBOSS_SCHEMA;
  const migrations = loadMigrations(options.migrationsDirectory ?? migrationsDirectory);

  const client = await dependencies.connect(options.connectionString);
  // The SQL raises warnings for conditions an operator has to fix by hand (a role membership the
  // migration user could not grant, say). Swallowing them would hide the one thing that stops the
  // application from connecting afterwards.
  client.on('notice', (notice) => {
    log({ kind: 'notice', message: notice.message ?? String(notice) });
  });

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    log({ kind: 'lock_wait' });
    await client.query('select pg_advisory_lock($1::int, $2::int)', [
      MIGRATION_LOCK_KEY[0],
      MIGRATION_LOCK_KEY[1],
    ]);
    log({ kind: 'lock_acquired' });

    await client.query(MIGRATION_LOG_DDL);
    const alreadyApplied = await readApplied(client);

    for (const migration of migrations) {
      const previousChecksum = alreadyApplied.get(migration.name);
      if (previousChecksum !== undefined) {
        if (previousChecksum !== migration.checksum) {
          throw new Error(
            `migration ${migration.name} was applied with checksum ${previousChecksum} but this build carries ${migration.checksum}; migrations are forward-only (TD-019) — add a new file instead of editing an applied one`,
          );
        }
        skipped.push(migration.name);
        log({ kind: 'migration_skipped', name: migration.name });
        continue;
      }
      const durationMs = await applyMigration(client, migration);
      applied.push(migration.name);
      log({ kind: 'migration_applied', name: migration.name, durationMs });
    }

    const pgBossSchemaVersion = await dependencies.installJobs(
      options.connectionString,
      pgBossSchema,
    );
    log({ kind: 'pgboss', schema: pgBossSchema, version: pgBossSchemaVersion });

    // The retention window is stored, not passed at call time, so the application role can only
    // ever trigger the retention the operator configured here. Note this is a rewrite on every
    // run: the environment is the source of truth, so a manual edit to the registry is silently
    // reverted by the next `migrate`. Change APP_TRANSCRIPT_RETENTION_DAYS instead.
    await client.query(
      'update platform_table_policy set retention_days = $1::int where retention_scope = $2::text',
      [retentionDays, TRANSCRIPT_RETENTION_SCOPE],
    );
    log({ kind: 'retention', scope: TRANSCRIPT_RETENTION_SCOPE, days: retentionDays });

    const partitions = await client.query<{ created: string[] }>(
      'select platform_ensure_partitions($1::int) as created',
      [monthsAhead],
    );
    const partitionsCreated = partitions.rows[0]?.created ?? [];
    log({ kind: 'partitions', created: partitionsCreated });

    // Grants last: they cover the tables the migrations added, the partitions just created and
    // the pgboss schema just installed. The function returns false (with a warning on the notice
    // channel) when the role could not be created — a managed PostgreSQL without CREATEROLE —
    // which degrades the least-privilege split rather than failing the deployment.
    let grantsAppliedTo: string | null = null;
    if (appRole !== '') {
      const granted = await client.query<{ applied: boolean }>(
        'select platform_apply_grants($1::text) as applied',
        [appRole],
      );
      if (granted.rows[0]?.applied === true) {
        grantsAppliedTo = appRole;
        log({ kind: 'grants', role: appRole });
      }
    }

    return {
      applied,
      skipped,
      pgBossSchema,
      pgBossSchemaVersion,
      grantsAppliedTo,
      transcriptRetentionDays: retentionDays,
      partitionsCreated,
      durationMs: Date.now() - started,
    };
  } finally {
    // Releasing is belt and braces: ending the session drops the lock anyway.
    await client
      .query('select pg_advisory_unlock($1::int, $2::int)', [
        MIGRATION_LOCK_KEY[0],
        MIGRATION_LOCK_KEY[1],
      ])
      .catch(() => undefined);
    await client.end();
  }
};
