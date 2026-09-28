/**
 * The two reads behind the job-queue gauge and `/readyz`'s `agent_runs` line, against real pg-boss
 * on PostgreSQL 18 (WP-86, PROGRESS backlog 135) — with the runner **absent** and then **present**.
 *
 * "Absent" is what a stock `app` sees when no process subscribes `stage.execute`: the job is
 * enqueued by a sender (as `ROLE=api` enqueues) and nothing claims it. "Present" is a worker that
 * subscribes the queue and takes the job. The job's eligibility is moved back past the bound with
 * one `update` rather than by waiting five minutes; everything else is pg-boss's own behaviour.
 *
 * The database is migrated by `db.runMigrations`, so the queue exists because `migrate` declared it
 * (WP-86, backlog 262) — the sender never declares anything.
 */
import { JOB_QUEUES } from '@platform/application';
import { db, jobs } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { strictPoolLogger } from '../support/postgres.js';

const WAIT_TIMEOUT_MS = 30_000;

let database: MigratedDatabase;
let handle: ReturnType<typeof db.createDatabasePool>;

beforeAll(async () => {
  database = await createMigratedDatabase('queue-backlog');
  handle = db.createDatabasePool(
    {
      url: database.connectionString,
      appRole: 'platform_app',
      poolMax: 6,
      connectionTimeoutMs: db.DATABASE_CONFIG_DEFAULTS.connectionTimeoutMs,
      partitionMonthsAhead: 3,
      transcriptRetentionDays: null,
    },
    strictPoolLogger,
  );
});

afterAll(async () => {
  await handle?.close();
  await database?.drop();
});

const backlogOf = async (queue: string) =>
  (await jobs.readQueueBacklog(handle.pool, 'pgboss')).find((row) => row.queue === queue);

describe('the job backlog and agent_runs, runner absent then present (WP-86)', () => {
  it('reads every declared queue at zero, and a deferred timer as no backlog', async () => {
    const sender = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      supervise: false,
      schedule: false,
    });
    await sender.start();
    try {
      await sender.jobs.enqueue({
        queue: JOB_QUEUES.deadlineSweep,
        data: { probe: 'deferred' },
        startAfter: new Date(Date.now() + 3_600_000),
      });
      const rows = await jobs.readQueueBacklog(handle.pool, 'pgboss');
      // Every declared queue has a row — zero is a measurement.
      expect(rows.length).toBeGreaterThanOrEqual(16);
      expect(rows.find((row) => row.queue === JOB_QUEUES.deadlineSweep)).toEqual({
        queue: JOB_QUEUES.deadlineSweep,
        queued: 0,
        oldestAgeSeconds: null,
      });
      await expect(jobs.readAgentRunService(handle.pool, 'pgboss')).resolves.toBe('served');
    } finally {
      await sender.stop();
    }
  });

  it('is unserved while nothing claims an old stage.execute job, and served once a worker takes it', async () => {
    const sender = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      supervise: false,
      schedule: false,
    });
    await sender.start();
    const worker = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: 0.5,
    });
    try {
      const enqueued = await sender.jobs.enqueue({
        queue: JOB_QUEUES.stageExecute,
        data: { task_id: 'probe' },
        singletonKey: 'task:probe',
      });
      expect(enqueued.status).toBe('enqueued');

      // Freshly enqueued: backlog of one, but inside the bound — not yet unserved.
      expect((await backlogOf(JOB_QUEUES.stageExecute))?.queued).toBe(1);
      await expect(jobs.readAgentRunService(handle.pool, 'pgboss')).resolves.toBe('served');

      // Runner absent: eligible for ten minutes and nothing has claimed it.
      await handle.pool.query(
        "update pgboss.job set start_after = now() - interval '10 minutes', created_on = now() - interval '10 minutes' where name = $1",
        [JOB_QUEUES.stageExecute],
      );
      const waiting = await backlogOf(JOB_QUEUES.stageExecute);
      expect(waiting?.queued).toBe(1);
      expect(waiting?.oldestAgeSeconds).toBeGreaterThan(jobs.AGENT_RUNS_UNSERVED_AFTER_SECONDS);
      await expect(jobs.readAgentRunService(handle.pool, 'pgboss')).resolves.toBe('unserved');

      // Runner present: a worker subscribes the queue and takes the job.
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let claimed = false;
      await worker.start();
      await worker.jobs.work({
        queue: JOB_QUEUES.stageExecute,
        handler: async () => {
          claimed = true;
          await held;
        },
      });
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (!claimed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(claimed).toBe(true);
      await expect(jobs.readAgentRunService(handle.pool, 'pgboss')).resolves.toBe('served');
      expect(await backlogOf(JOB_QUEUES.stageExecute)).toEqual({
        queue: JOB_QUEUES.stageExecute,
        queued: 0,
        oldestAgeSeconds: null,
      });
      release();
    } finally {
      await worker.stop();
      await sender.stop();
    }
  });
});
