/**
 * **An expired last try escalates its task, once** — WP-156 criterion (2), PROGRESS backlog
 * **421**, against real pg-boss 12.30.0 and PostgreSQL 18.
 *
 * The first case is the defect and its fix in one run. A `pipeline.outbound` job of the
 * bound-and-escalate duty `dependency_gate`, on its only try, is worked by a handler wrapped exactly
 * as production wraps the band (`escalatingOnLastTry` with `describeExhaustedOutbound`) and that
 * never answers — a provider call that hangs. pg-boss's own timer fails the job after its one-second
 * expiry (the measurement is `test/integration/jobs/job-expiry.integration.test.ts`), and the task
 * is **not** escalated: the wrapper sits inside pg-boss's race and never sees it. The recovery pass,
 * composed with the real stores, then escalates the task once; a second pass finds nothing.
 *
 * The second case is the store's predicate on both sides (standing rule 42), over rows cloned from
 * the real failed job: a thrown last try, a duty that is not bound-and-escalate, a try with retries
 * left, a failure past the horizon and a supervisor-written expiry.
 *
 * The canary (recorded in PROGRESS under WP-156): with the expiry signatures removed from
 * `postgres-expired-job-store.ts`'s `where`, nothing is read and the first case fails on the task's
 * state.
 */
import type { JobContext, OutboundJobData } from '@platform/application';
import {
  describeExhaustedOutbound,
  EXPIRED_JOB_HORIZON_MS,
  escalatingOnLastTry,
  expiredJobTargets,
  JOB_QUEUES,
  runStrandedRecovery,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import {
  db,
  eventing,
  jobs,
  pipeline as pipelineAdapters,
  recovery as recoveryAdapters,
} from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { strictPoolLogger } from '../support/postgres.js';

const WAIT_TIMEOUT_MS = 30_000;

let database: MigratedDatabase;
let handle: ReturnType<typeof db.createDatabasePool>;
let projectId: Id;

const pipeline = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
const expiredStore = recoveryAdapters.createPostgresExpiredJobStore({ jobsSchema: 'pgboss' });
const ids = { next: () => crypto.randomUUID() as Id };
const nowIso = () => new Date().toISOString() as IsoDateTime;

const seedTask = async (key: string): Promise<Id> => {
  const { rows } = await handle.pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, template_snapshot)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/' || $2, 'feature',
             'active', 'implementation', $3::jsonb) returning id`,
    [projectId, key, JSON.stringify(FEATURE_TEMPLATE)],
  );
  return rows[0]?.id as Id;
};

const taskState = async (taskId: Id): Promise<string> =>
  (await handle.pool.query<{ state: string }>('select state from tasks where id = $1', [taskId]))
    .rows[0]?.state ?? 'missing';

const escalations = async (taskId: Id) =>
  (
    await handle.pool.query<{ payload: { reason: string; blocker_brief: string } }>(
      `select payload from events
        where stream_type = 'task' and stream_id = $1 and type = 'task.escalated'`,
      [taskId],
    )
  ).rows.map((row) => row.payload);

const pass = async () =>
  runStrandedRecovery({
    store: recoveryAdapters.createPostgresStrandedWorkStore(),
    unitOfWork: new eventing.PostgresUnitOfWork({ pool: handle.pool }),
    jobs: { enqueue: async () => ({ status: 'enqueued', jobId: null }) } as never,
    clock: { now: nowIso },
    graceMs: 0,
    expiredJobs: {
      store: expiredStore,
      escalation: { store: pipeline, ids, clock: { now: nowIso } },
    },
  });

beforeAll(async () => {
  database = await createMigratedDatabase('expired-job');
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
  const org = await handle.pool.query<{ id: string }>(
    "insert into organizations (name) values ('expiry') returning id",
  );
  const project = await handle.pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'expiry', 'Expiry', 'https://git.example.test/acme/expiry.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await database?.drop();
});

let expiredJobId = '';

describe('an expired last try (WP-156 (c), backlog 421)', () => {
  it('is not escalated by its wrapper, and the recovery pass escalates its task once', async () => {
    const taskId = await seedTask('ACME-421');
    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: 0.5,
      supervise: false,
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await runtime.start();
    try {
      // Production's wrapping of the band (`pipelineOutboundHandler`), over a call that never answers.
      const handler = escalatingOnLastTry<OutboundJobData>(
        {
          unitOfWork: new eventing.PostgresUnitOfWork({ pool: handle.pool }),
          store: pipeline,
          jobs: runtime.jobs,
          ids,
          clock: { now: nowIso },
        },
        async () => {
          await gate;
        },
        (job: JobContext<OutboundJobData>) => describeExhaustedOutbound(job.data),
      );
      await runtime.jobs.work({ queue: JOB_QUEUES.pipelineOutbound, handler });
      const sent = await runtime.jobs.enqueue({
        queue: JOB_QUEUES.pipelineOutbound,
        data: { duty: 'dependency_gate', project_id: projectId, task_id: taskId },
        retryLimit: 0,
        expireInSeconds: 1,
      });
      expiredJobId = (sent as { readonly jobId: string }).jobId;

      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      let state = '';
      while (state !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state =
          (
            await handle.pool.query<{ state: string }>(
              'select state::text as state from pgboss.job where id = $1',
              [expiredJobId],
            )
          ).rows[0]?.state ?? '';
      }
      expect(state).toBe('failed');
      // The defect: the job is listed as failed, and nobody was told.
      expect(await taskState(taskId)).toBe('active');
      expect(await escalations(taskId)).toEqual([]);

      const first = await pass();
      expect(first.find((site) => site.site === 'expired_job')).toEqual({
        site: 'expired_job',
        found: 1,
        reEnqueued: 0,
        ended: 1,
      });
      expect(await taskState(taskId)).toBe('needs_human');
      const [escalated, ...more] = await escalations(taskId);
      expect(more).toEqual([]);
      expect(escalated?.reason).toBe(
        'dependency_gate ran past its 1-second limit on the last of 1 tries',
      );
      expect(escalated?.blocker_brief).toContain('ACME-421');

      // Once per job id: the second pass reads nothing and escalates nothing.
      const second = await pass();
      expect(second.find((site) => site.site === 'expired_job')).toMatchObject({
        found: 0,
        ended: 0,
      });
      expect(await escalations(taskId)).toHaveLength(1);
      const marks = await handle.pool.query<{ job_id: string; queue: string; task_id: string }>(
        'select job_id::text as job_id, queue, task_id::text as task_id from expired_job_escalations',
      );
      expect(marks.rows).toEqual([
        { job_id: expiredJobId, queue: JOB_QUEUES.pipelineOutbound, task_id: taskId },
      ]);
    } finally {
      release();
      await runtime.stop();
    }
  });

  it('reads an expired bound-and-escalate last try and nothing beside it (rule 42)', async () => {
    expect(expiredJobId).not.toBe('');
    const taskId = await seedTask('ACME-422');
    /** A copy of the real failed job, with `changes` merged over its row. */
    const clone = async (changes: Record<string, unknown>): Promise<string> => {
      const { rows } = await handle.pool.query<{ id: string }>(
        `insert into pgboss.job
         select (jsonb_populate_record(null::pgboss.job,
                   to_jsonb(j) || jsonb_build_object('id', gen_random_uuid()) || $2::jsonb)).*
           from pgboss.job j where j.id = $1
         returning id::text as id`,
        [expiredJobId, JSON.stringify(changes)],
      );
      return rows[0]?.id as string;
    };
    const gate = { duty: 'dependency_gate', project_id: projectId, task_id: taskId };
    const supervised = await clone({
      data: gate,
      output: { value: { message: 'job timed out' } },
    });
    await clone({
      data: gate,
      output: { name: 'Error', message: 'the provider answered 502', stack: 'Error: …' },
    });
    await clone({ data: { ...gate, duty: 'workpad' } });
    await clone({ data: gate, state: 'retry', retry_limit: 2 });
    await clone({
      data: gate,
      completed_on: new Date(Date.now() - EXPIRED_JOB_HORIZON_MS - 60_000).toISOString(),
    });

    const read = await new eventing.PostgresUnitOfWork({ pool: handle.pool }).transaction(
      async (scope) =>
        expiredStore.expiredJobs(scope.tx, {
          olderThan: nowIso(),
          notBefore: new Date(Date.now() - EXPIRED_JOB_HORIZON_MS).toISOString() as IsoDateTime,
          targets: expiredJobTargets(),
          limit: 50,
        }),
    );
    expect(read.map((row) => row.jobId)).toEqual([supervised]);
    expect(read[0]).toMatchObject({
      queue: JOB_QUEUES.pipelineOutbound,
      writer: 'supervisor',
      tries: 1,
      expireSeconds: 1,
      data: gate,
    });
  });
});
