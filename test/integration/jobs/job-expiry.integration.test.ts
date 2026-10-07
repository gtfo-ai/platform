/**
 * **What pg-boss 12 records for a job that expires while active on its last try** — WP-156 ruling
 * (a), PROGRESS backlog **421**, measured against real pg-boss 12.30.0 on PostgreSQL 18.
 *
 * Backlog 421 read `escalatingOnLastTry` (`packages/application/src/pipeline/job-escalation.ts`)
 * and concluded, without running anything, that a job which expires while active never reaches the
 * wrapper. Reading pg-boss 12.30.0 (`dist/manager.js` `#processJobs`, `dist/plans.js`
 * `failJobsByTimeout`) says an expiry has **two** writers, not one, and this file measures both:
 *
 *  1. **the worker's own timer** — `#processJobs` races the handler against
 *     `resolveWithinSeconds(…, expireInSeconds, 'handler execution exceeded <n>s')`. When the
 *     timer wins, pg-boss fails the job through the same `fail()` a thrown handler takes, with a
 *     serialised `Error` whose message is that sentence. The platform's handler **did not throw and
 *     is still running**, so the wrapper — which sits *inside* the race — never sees it;
 *  2. **the supervisor** — `failJobsByTimeout`, on its monitor cadence, fails any `active` job
 *     whose `started_on + expire_seconds` has passed, with the fixed output
 *     `{"value":{"message":"job timed out"}}`. This is the path of a job whose process died (or
 *     stopped polling): nobody's timer is left to fire.
 *
 * Both end, on the last try, in `state = 'failed'` with `completed_on` set — the same row a thrown
 * last try leaves — and both are **told apart from a throw only by `output`**. That is the
 * measurement the recovery row (ruling (c), `recovery/expired-job.ts`) reads.
 *
 * How the supervisor case stands in for a dead process: a real worker claims the job (state
 * `active`, `started_on` set by pg-boss's own fetch) with an expiry of an hour, so its own timer
 * cannot fire during the case; the claim is then **aged** by two hours in SQL — the one thing a
 * test cannot wait for — and a second pg-boss instance with supervision on fails it. Nothing else
 * of the row is written by the test.
 */
import { JOB_QUEUES } from '@platform/application';
import { db, jobs } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { strictPoolLogger } from '../support/postgres.js';

const WAIT_TIMEOUT_MS = 30_000;

let database: MigratedDatabase;
let handle: ReturnType<typeof db.createDatabasePool>;

interface JobRow {
  readonly state: string;
  readonly retry_count: number;
  readonly retry_limit: number;
  readonly expire_seconds: number;
  readonly completed_on: Date | null;
  readonly output: Record<string, unknown> | null;
}

const readJob = async (id: string): Promise<JobRow | undefined> =>
  (
    await handle.pool.query<JobRow>(
      `select state::text as state, retry_count, retry_limit, expire_seconds, completed_on, output
         from pgboss.job where id = $1`,
      [id],
    )
  ).rows[0];

const waitForState = async (id: string, state: string): Promise<JobRow> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let row = await readJob(id);
  while (row?.state !== state && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    row = await readJob(id);
  }
  expect(row?.state, `job ${id} reached ${state}`).toBe(state);
  return row as JobRow;
};

/** A handler that does not return until released — a provider call that never answers. */
const hangingHandler = () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = { started: false, settled: false, threw: false, aborted: false };
  const handler = async (job: { readonly signal: AbortSignal }): Promise<void> => {
    seen.started = true;
    try {
      await gate;
      seen.aborted = job.signal.aborted;
    } catch {
      seen.threw = true;
    } finally {
      seen.settled = true;
    }
  };
  return { handler, seen, release: () => release() };
};

beforeAll(async () => {
  database = await createMigratedDatabase('job-expiry');
  handle = db.createDatabasePool(
    {
      url: database.connectionString,
      appRole: 'platform_app',
      poolMax: 8,
      connectionTimeoutMs: db.DATABASE_CONFIG_DEFAULTS.connectionTimeoutMs,
      partitionMonthsAhead: 3,
      transcriptRetentionDays: null,
    },
    strictPoolLogger,
  );
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await database?.drop();
});

describe('a last try that expires while active (WP-156 (a), backlog 421)', () => {
  it('in a live worker: pg-boss’s own timer fails it as an Error, while the handler is still running and never threw', async () => {
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: 0.5,
      supervise: false,
    });
    await runtime.start();
    const hanging = hangingHandler();
    try {
      await runtime.jobs.work({ queue: JOB_QUEUES.pipelineOutbound, handler: hanging.handler });
      const sent = await runtime.jobs.enqueue({
        queue: JOB_QUEUES.pipelineOutbound,
        data: { duty: 'workpad', note: 'expiry-live' },
        retryLimit: 0,
        expireInSeconds: 1,
      });
      const id = (sent as { readonly jobId: string }).jobId;

      const row = await waitForState(id, 'failed');
      expect(row.retry_count).toBe(0);
      expect(row.retry_limit).toBe(0);
      expect(row.expire_seconds).toBe(1);
      expect(row.completed_on).not.toBeNull();
      // The worker's timer, through the same `fail()` a throw takes: a serialised Error.
      expect(row.output).toMatchObject({ name: 'Error', message: 'handler execution exceeded 1s' });
      // …and the handler neither threw nor returned: a wrapper inside the race saw nothing.
      expect(hanging.seen).toMatchObject({ started: true, settled: false, threw: false });

      // A handler that finally returns does not revive the row: `complete` matches only
      // `state < 'completed'`, so the failed job stays failed with the effect already done.
      hanging.release();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(hanging.seen.settled).toBe(true);
      expect(hanging.seen.aborted).toBe(true);
      expect((await readJob(id))?.state).toBe('failed');
    } finally {
      hanging.release();
      await runtime.stop();
    }
  });

  it('in a process that stopped: the supervisor fails it with a fixed `job timed out` output', async () => {
    const claimer = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: 0.5,
      supervise: false,
    });
    const supervisor = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: 0.5,
      supervise: true,
      maintenanceIntervalSeconds: 1,
    });
    await claimer.start();
    const hanging = hangingHandler();
    try {
      await claimer.jobs.work({ queue: JOB_QUEUES.mrCommentDebounce, handler: hanging.handler });
      const sent = await claimer.jobs.enqueue({
        queue: JOB_QUEUES.mrCommentDebounce,
        data: { task_id: 'expiry-supervised', note: 'expiry-supervisor' },
        retryLimit: 0,
        // An hour, so the claimer's own timer cannot fire during the case.
        expireInSeconds: 60 * 60,
      });
      const id = (sent as { readonly jobId: string }).jobId;
      await waitForState(id, 'active');
      expect(hanging.seen.started).toBe(true);

      // The hour passes: only the claim's age is written, nothing else of the row.
      await handle.pool.query(
        `update pgboss.job set started_on = started_on - interval '2 hours' where id = $1`,
        [id],
      );
      await supervisor.start();
      const row = await waitForState(id, 'failed');
      expect(row.retry_count).toBe(0);
      expect(row.completed_on).not.toBeNull();
      expect(row.output).toEqual({ value: { message: 'job timed out' } });
      expect(hanging.seen).toMatchObject({ settled: false, threw: false });
    } finally {
      hanging.release();
      await claimer.stop();
      await supervisor.stop();
    }
  });

  it('for comparison, a thrown last try: the same state, an Error carrying the handler’s own message', async () => {
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: 0.5,
      supervise: false,
    });
    await runtime.start();
    try {
      await runtime.jobs.work({
        queue: JOB_QUEUES.pipelineOutbound,
        handler: async (job) => {
          if (job.data.note === 'expiry-thrown') {
            throw new Error('the provider answered 502');
          }
        },
      });
      const sent = await runtime.jobs.enqueue({
        queue: JOB_QUEUES.pipelineOutbound,
        data: { duty: 'workpad', note: 'expiry-thrown' },
        retryLimit: 0,
        expireInSeconds: 60,
      });
      const row = await waitForState((sent as { readonly jobId: string }).jobId, 'failed');
      expect(row.retry_count).toBe(0);
      expect(row.output).toMatchObject({ name: 'Error', message: 'the provider answered 502' });
      expect(typeof row.output?.stack).toBe('string');
    } finally {
      await runtime.stop();
    }
  });
});
