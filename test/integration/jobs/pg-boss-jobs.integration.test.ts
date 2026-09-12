/**
 * The `Jobs` contract against real pg-boss on PostgreSQL 18 (technical/10 integration tier).
 *
 * The same suite the in-memory fake passes, run through the adapter TD-004 chose, on a migrated
 * database, **as the least-privilege application role** — so the suite is also the proof that
 * `platform_app` can actually operate the queue schema WP-03 installed for it.
 *
 * Uses the shared Testcontainers harness: one PostgreSQL container per project, one database per
 * test file.
 */
import { db, jobs } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type JobsContractContext,
  runJobsContract,
} from '../../contract/support/jobs-contract-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestDatabase, strictPoolLogger, withClient } from '../support/postgres.js';

const APP_ROLE = 'platform_app';
const POLL_SECONDS = 0.5;
/** pg-boss re-reads the schedule table on this cadence; 1 s keeps the cron test quick. */
const CRON_INTERVAL_SECONDS = 1;
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_STEP_MS = 100;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Everything pg-boss reported on its `error` channel while the suite ran. */
const backgroundErrors: unknown[] = [];

const poolConfig = (connectionString: string): db.DatabaseConfig => ({
  url: connectionString,
  appRole: APP_ROLE,
  poolMax: 10,
  // The deployed default, not a number invented here: pg waits for ever without it, so a pool
  // exhausted by a stuck worker would hang this suite instead of failing it.
  connectionTimeoutMs: db.DATABASE_CONFIG_DEFAULTS.connectionTimeoutMs,
  partitionMonthsAhead: 3,
  transcriptRetentionDays: null,
});

runJobsContract({
  name: 'pg-boss on PostgreSQL 18',
  create: async (): Promise<JobsContractContext> => {
    const database = await createMigratedDatabase('jobs');
    const handle = db.createDatabasePool(poolConfig(database.connectionString), strictPoolLogger);
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: POLL_SECONDS,
      cronMonitorIntervalSeconds: CRON_INTERVAL_SECONDS,
      onError: (error) => backgroundErrors.push(error),
    });

    return {
      runtime,
      now: () => new Date(),
      elapse: sleep,
      waitFor: async (predicate, description) => {
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (predicate()) {
            return;
          }
          await sleep(WAIT_STEP_MS);
        }
        throw new Error(`timed out after ${WAIT_TIMEOUT_MS} ms waiting for ${description}`);
      },
      // A poll interval plus room for a container under load. The suite's hard assertion is that
      // a timer never fires *early*; how late is a quality-of-service question.
      timerToleranceMs: 8_000,
      pollingIntervalSeconds: POLL_SECONDS,
      cleanup: async () => {
        await handle.close();
        await database.drop();
      },
    };
  },
});

describe('pg-boss adapter on the platform schema', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('jobs_wiring');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('reported no background errors while the contract suite ran', () => {
    // pg-boss surfaces maintenance and supervision failures — including a privilege it lacks —
    // on its `error` channel rather than by rejecting a call, so a silent grant problem would
    // otherwise pass every functional assertion above.
    expect(backgroundErrors.map(String)).toEqual([]);
  });

  it('is installed by migrate, so the runtime never has to migrate the schema itself', async () => {
    expect(database.report.pgBossSchemaVersion).toBeGreaterThan(0);
    expect(database.report.pgBossSchema).toBe(jobs.DEFAULT_JOBS_SCHEMA);
  });

  it('refuses to start against a database where migrate has not run', async () => {
    // TD-019: migrations are forward-only and applied by one service under an advisory lock. The
    // runtime is built with migrate/createSchema off, so an application container that reaches a
    // database ahead of the migrate service must fail loudly instead of installing the schema.
    const empty = await createTestDatabase('jobs_unmigrated');
    const handle = db.createDatabasePool(
      { ...poolConfig(empty.connectionString), appRole: '' },
      strictPoolLogger,
    );
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      onError: () => {},
    });

    try {
      await expect(runtime.start()).rejects.toThrow();
    } finally {
      await handle.close();
      await empty.drop();
    }
  });

  it('runs the partition maintenance job WP-03 left for the scheduler', async () => {
    const handle = db.createDatabasePool(poolConfig(database.connectionString), strictPoolLogger);
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: POLL_SECONDS,
      // The daily cron is not waited for; the job is enqueued directly. Registering the schedule
      // is what proves the queue, the schedule and the handler agree on the name.
      cronMonitorIntervalSeconds: CRON_INTERVAL_SECONDS,
      onError: (error) => backgroundErrors.push(error),
    });
    await runtime.start();

    const results: { created: readonly string[]; dropped: readonly string[] }[] = [];
    try {
      await jobs.registerPartitionMaintenance(runtime.jobs, {
        db: handle.pool,
        partitionMonthsAhead: 6,
        timezone: 'Europe/Prague',
        onResult: (result) => results.push(result),
      });

      const schedules = await runtime.jobs.listCronSchedules(jobs.PARTITION_MAINTENANCE_JOB);
      expect(schedules).toEqual([
        {
          queue: jobs.PARTITION_MAINTENANCE_JOB,
          key: '',
          cron: jobs.PARTITION_MAINTENANCE_CRON,
          timezone: 'Europe/Prague',
        },
      ]);

      await runtime.jobs.enqueue({ queue: jobs.PARTITION_MAINTENANCE_JOB });

      const deadline = Date.now() + 30_000;
      while (results.length === 0 && Date.now() < deadline) {
        await sleep(WAIT_STEP_MS);
      }

      expect(results).toHaveLength(1);
      // migrate created three months ahead; the job was asked for six, so it extends the window
      // rather than doing nothing — proving the SECURITY DEFINER function is callable as the
      // least-privilege role.
      expect(results[0]?.created.length).toBeGreaterThan(0);
      expect(results[0]?.dropped).toEqual([]);
    } finally {
      await runtime.stop();
      await handle.close();
    }
  });

  it('holds exactly the privileges the runtime needs in the pgboss schema, and no more', async () => {
    // WP-03 grants the application role USAGE plus full DML on everything pg-boss installed. It
    // does *not* grant CREATE on the schema, and the role owns nothing there — so any pg-boss
    // feature that creates or drops a table at runtime is unavailable to it. Two exist:
    // `persistQueueStats` (daily `queue_stats` partitions — pinned off in the adapter) and
    // per-queue partition tables (`partition: true`, which the port does not expose). This test
    // is the tripwire: if either becomes reachable, or if the grants change, it says so.
    await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{
        usage: boolean;
        create_on_schema: boolean;
        job_dml: boolean;
        queue_write: boolean;
        schedule_write: boolean;
        owns_anything: boolean;
      }>(`
        select
          has_schema_privilege('platform_app', 'pgboss', 'USAGE') as usage,
          has_schema_privilege('platform_app', 'pgboss', 'CREATE') as create_on_schema,
          has_table_privilege('platform_app', 'pgboss.job', 'SELECT,INSERT,UPDATE,DELETE') as job_dml,
          has_table_privilege('platform_app', 'pgboss.queue', 'INSERT') as queue_write,
          has_table_privilege('platform_app', 'pgboss.schedule', 'INSERT,DELETE') as schedule_write,
          exists (
            select 1 from pg_class c
            where c.relnamespace = 'pgboss'::regnamespace
              and c.relowner = 'platform_app'::regrole
          ) as owns_anything
      `);

      expect(rows[0]).toEqual({
        usage: true,
        job_dml: true,
        queue_write: true,
        schedule_write: true,
        create_on_schema: false,
        owns_anything: false,
      });
    });
  });

  it('runs its background maintenance as the least-privilege role', async () => {
    // pg-boss's maintenance creates the daily `queue_stats` partitions and archives finished jobs.
    // Both are DDL and DML inside `pgboss`, so this is where a missing grant shows up — and it
    // shows up on the `error` channel, not as a rejected promise. The intervals are pushed down to
    // a second so the passes actually run inside the test rather than a minute after it.
    const errors: unknown[] = [];
    const handle = db.createDatabasePool(poolConfig(database.connectionString), strictPoolLogger);
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: POLL_SECONDS,
      maintenanceIntervalSeconds: 1,
      schedule: false,
      onError: (error) => errors.push(error),
    });
    await runtime.start();

    try {
      const queue = 'test.maintenance';
      await runtime.jobs.defineQueue({ name: queue });
      await runtime.jobs.enqueue({ queue, data: { note: 'churn' } });
      await sleep(3_000);

      expect(errors.map(String)).toEqual([]);
    } finally {
      await runtime.stop();
      await handle.close();
    }
  });

  it('stores a timer as a future start_after rather than sleeping in the process', async () => {
    const handle = db.createDatabasePool(poolConfig(database.connectionString), strictPoolLogger);
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      schedule: false,
      onError: (error) => backgroundErrors.push(error),
    });
    await runtime.start();

    try {
      const queue = 'test.durable.timer';
      await runtime.jobs.defineQueue({ name: queue });
      const startAfter = new Date(Date.now() + 3_600_000);
      const result = await runtime.jobs.enqueue({ queue, data: { note: 'x' }, startAfter });
      expect(result.status).toBe('enqueued');

      // Read it back through a plain client: the timer is a row, so it survives a restart.
      await withClient(database.connectionString, async (client) => {
        const { rows } = await client.query<{ start_after: Date; name: string }>(
          'select name, start_after from pgboss.job where name = $1',
          [queue],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.start_after.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
      });
    } finally {
      await runtime.stop();
      await handle.close();
    }
  });

  it('does not delay the leading coalesced job — it is a throttle, not a debounce', async () => {
    const handle = db.createDatabasePool(poolConfig(database.connectionString), strictPoolLogger);
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      schedule: false,
      onError: (error) => backgroundErrors.push(error),
    });
    await runtime.start();

    try {
      const queue = 'test.leading.edge';
      const windowSeconds = 120;
      await runtime.jobs.defineQueue({ name: queue });
      await runtime.jobs.enqueue({
        queue,
        coalesce: { key: 'mr:1', windowSeconds, mode: 'throttle_with_trailing' },
      });
      await runtime.jobs.enqueue({
        queue,
        coalesce: { key: 'mr:1', windowSeconds, mode: 'throttle_with_trailing' },
      });

      await withClient(database.connectionString, async (client) => {
        // Every timestamp compared here is written by the database, so nothing depends on the host
        // clock agreeing with the container's — `created_on` defaults to the same `now()` that
        // `start_after` does. Ordered by `created_on` because "leading" means the job that was
        // enqueued first, and which row that is must not be decided by the column under test.
        const { rows } = await client.query<{ delay_seconds: string; lead_seconds: string }>(
          `select
             extract(epoch from (start_after - created_on))::text as delay_seconds,
             extract(epoch from (start_after - min(start_after) over ()))::text as lead_seconds
           from pgboss.job where name = $1 order by created_on, start_after`,
          [queue],
        );
        expect(rows).toHaveLength(2);

        // Structural, not timing-based, and exact: both columns come from the same `now()` in a
        // single INSERT, so a throttle writes 0 here and a debounce writes the window. The row
        // itself says the leading job was runnable the moment it was created. technical/02 needs a
        // batch that waits two minutes and then emits ONE event — this cannot be it, which is why
        // `JOB_QUEUES.mrCommentDebounce` documents the policy-plus-timer pattern instead.
        expect(Number(rows[0]?.delay_seconds)).toBe(0);

        // The trailing job is deferred, by pg-boss's `getDebounceStartAfter` margin: whatever is
        // left of the slot plus one second, so never more than a window and a second. Also exact —
        // the margin is a whole number of seconds pg-boss computes and the database adds to the
        // same `now()` that stamps `created_on`.
        const trailingDelay = Number(rows[1]?.delay_seconds);
        expect(trailingDelay).toBeGreaterThan(0);
        expect(trailingDelay).toBeLessThanOrEqual(windowSeconds + 1);

        // And it really is behind the leading job, not merely deferred relative to its own row.
        // Measured against the margin rather than against a constant: the leading job is runnable
        // at its own creation instant, so the lead is that margin plus however long the second
        // enqueue's round-trip took, and it can therefore only ever be *at least* the margin — on
        // any hardware. Turn the throttle into a debounce and the leading job moves out with the
        // trailing one, collapsing the lead to at most the difference between the two margins —
        // and to exactly 0 once the trailing row is the earlier of the two, which is what the
        // mutation measured (`expected 0 to be greater than or equal to 84`).
        //
        // What this replaces was `lead <= windowSeconds + 1`, and that was a hardware assertion in
        // the sense of standing rule 2: a burst landing in the first second of a slot gets a margin
        // of exactly 121 s, so the bound demanded that the second round-trip take no time at all.
        // That is ~0.8% of runs on any machine, loaded or idle — CI run 34448377983 hit it with
        // `121.003307 <= 121`. An upper bound on the lead was never part of the invariant anyway: a
        // debounce makes the lead *smaller*, never larger. The one real upper bound, on how far the
        // follower may be pushed out, is the assertion on `trailingDelay` above.
        const lead = Number(rows[1]?.lead_seconds);
        expect(lead).toBeGreaterThanOrEqual(trailingDelay);
      });
    } finally {
      await runtime.stop();
      await handle.close();
    }
  });

  it('coalesces on the slot grid the port documents', async () => {
    const handle = db.createDatabasePool(poolConfig(database.connectionString), strictPoolLogger);
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      schedule: false,
      onError: (error) => backgroundErrors.push(error),
    });
    await runtime.start();

    try {
      const queue = 'test.slot.grid';
      await runtime.jobs.defineQueue({ name: queue });
      const coalesce = { key: 'mr:7', windowSeconds: 600 } as const;

      await Promise.all(
        Array.from({ length: 25 }, () => runtime.jobs.enqueue({ queue, coalesce })),
      );

      await withClient(database.connectionString, async (client) => {
        const { rows } = await client.query<{ count: string; singleton_key: string }>(
          'select count(*)::text as count, singleton_key from pgboss.job where name = $1 group by singleton_key',
          [queue],
        );
        expect(rows).toEqual([{ count: '1', singleton_key: 'mr:7' }]);
      });
    } finally {
      await runtime.stop();
      await handle.close();
    }
  });
});
