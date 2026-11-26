/**
 * **Queue migrations** — applying `JOB_QUEUE_MIGRATIONS` to a database whose queues already exist
 * (TD-004's 2026-11-26 amendment, BD-034, BACKLOG 1656).
 *
 * pg-boss's `create_queue` is `insert … on conflict do nothing`, so the table of queue definitions
 * (`packages/application/src/ports/job-queues.ts`) shapes a **fresh** database only. A change to a
 * live queue's options is therefore a migration of its own: a named row, applied once, in order,
 * by `migrate` under its advisory lock, through pg-boss's own `updateQueue`, and recorded in
 * `job_queue_migrations` (migration 0123).
 *
 * ## The order, and what a crash costs
 *
 * The update first, then the record — two statements on two connections (pg-boss's pool and the
 * record's), so not one transaction. A crash between them leaves the queue updated and the row
 * unrecorded, and the next `migrate` applies the same options again: `updateQueue` sets values, so
 * a second application is the first one. The opposite order could record a migration whose update
 * never happened.
 *
 * ## Forward-only
 *
 * A recorded name whose options differ from this build's is **refused**, naming both — the SQL
 * migrations' checksum rule (TD-011): a released row is never edited, a later change is a new row.
 * A recorded name this build does not carry is **ignored**: it was written by a newer build, and the
 * options it set are data an older worker reads like any other (TD-032 — no schema changed).
 *
 * ## What it does not do
 *
 * It never touches a job: pg-boss copies the retry options onto each job row at insert, so a job
 * enqueued before the migration keeps the options it was sent with. It never changes a queue's
 * `policy` (pg-boss refuses that after creation) and names none.
 */
import { JOB_QUEUE_MIGRATIONS, type JobQueueMigration } from '@platform/application';

/** The two things the application of a queue migration needs. */
export interface JobQueueMigrationPorts {
  /** A query on the platform's database (the record table), answering its rows. */
  readonly query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<readonly Record<string, unknown>[]>;
  /** pg-boss's `updateQueue`, with pg-boss's option names. */
  readonly updateQueue: (queue: string, options: Record<string, unknown>) => Promise<void>;
}

/** A recorded queue migration whose options are not this build's (forward-only, TD-011). */
export class JobQueueMigrationChangedError extends Error {
  override readonly name = 'JobQueueMigrationChangedError';
  readonly migration: string;

  constructor(migration: string, recorded: string, carried: string) {
    super(
      `queue migration ${migration} was applied with options ${recorded} but this build carries ${carried}; queue migrations are forward-only like the SQL migrations — add a new row to JOB_QUEUE_MIGRATIONS instead of editing an applied one`,
    );
    this.migration = migration;
  }
}

/** A queue migration's options with pg-boss's names — only the keys the row states. */
export const pgBossQueueUpdateOptions = (
  options: JobQueueMigration['options'],
): Record<string, unknown> => {
  const mapped: Record<string, unknown> = {
    retryLimit: options.retryLimit,
    retryDelay: options.retryDelaySeconds,
    retryBackoff: options.retryBackoff,
    retryDelayMax: options.retryDelayMaxSeconds,
    expireInSeconds: options.expireInSeconds,
  };
  return Object.fromEntries(Object.entries(mapped).filter(([, value]) => value !== undefined));
};

/** The options as recorded: keys sorted, so a recorded row and a carried one compare as text. */
export const canonicalQueueMigrationOptions = (options: JobQueueMigration['options']): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(options)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );

/**
 * Applies every queue migration not yet recorded, in order, and answers the names it applied.
 * Throws {@link JobQueueMigrationChangedError} before applying anything when a recorded row's
 * options are not this build's.
 */
export const applyJobQueueMigrations = async (
  ports: JobQueueMigrationPorts,
  migrations: readonly JobQueueMigration[] = JOB_QUEUE_MIGRATIONS,
): Promise<readonly string[]> => {
  const recorded = new Map(
    (await ports.query('select name, options::text as options from job_queue_migrations')).map(
      (row) => [String(row.name), String(row.options)] as const,
    ),
  );
  for (const migration of migrations) {
    const stored = recorded.get(migration.name);
    if (stored === undefined) {
      continue;
    }
    const carried = canonicalQueueMigrationOptions(migration.options);
    // The stored text is jsonb's own rendering; compare the parsed value, canonicalised the same way.
    const storedCanonical = canonicalQueueMigrationOptions(
      JSON.parse(stored) as JobQueueMigration['options'],
    );
    if (storedCanonical !== carried) {
      throw new JobQueueMigrationChangedError(migration.name, storedCanonical, carried);
    }
  }
  const applied: string[] = [];
  for (const migration of migrations) {
    if (recorded.has(migration.name)) {
      continue;
    }
    await ports.updateQueue(migration.queue, pgBossQueueUpdateOptions(migration.options));
    await ports.query(
      `insert into job_queue_migrations (name, queue, options)
       values ($1, $2, $3::jsonb)
       on conflict (name) do nothing`,
      [migration.name, migration.queue, canonicalQueueMigrationOptions(migration.options)],
    );
    applied.push(migration.name);
  }
  return applied;
};
