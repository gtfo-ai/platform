/**
 * The stranded-stage recovery's read, mark and re-check against PostgreSQL 18 and real pg-boss —
 * WP-108, PROGRESS backlog 320.
 *
 * The pass's behaviour is asserted over the harness in
 * `packages/application/src/recovery/stranded-stage.test.ts`; this is the half that proves the SQL
 * answers the predicate: a task at an agent stage whose open row is older than the grace is found,
 * and **not** one with a `stage.execute` job queued for it (sent through the real pg-boss sender), a
 * live run, a closed row, a human stage, a young entry or a stop a human owns. A job pg-boss gave up
 * on (state `failed`) is no longer owed, so its task **is** found — the overlap with backlog 325.
 * The mark is written once per entry, and only while the entry is still stranded.
 *
 * Each case runs in one transaction that is rolled back; the jobs a case sends are committed by the
 * sender, so each case keys them by a task id of its own.
 */
import type { StrandedStage, Transaction } from '@platform/application';
import { JOB_QUEUES } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import { db, jobs, pipeline, recovery as recoveryAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, strictPoolLogger } from '../support/postgres.js';

let database: MigratedDatabase;
let handle: ReturnType<typeof db.createDatabasePool>;
let sender: ReturnType<typeof jobs.createPgBossJobs>;
let projectId: Id;
let client: pg.Client;
let tx: Transaction;
let ticket = 0;

const store = recoveryAdapters.createPostgresStrandedStageStore({ jobsSchema: 'pgboss' });

const minutesAgo = (minutes: number): IsoDateTime =>
  new Date(Date.now() - minutes * 60_000).toISOString() as IsoDateTime;

/** A task at `stage`, attempt 1, whose open row was entered `enteredMinutesAgo` minutes ago. */
const seedTask = async (input: {
  readonly state?: string;
  readonly stage?: string;
  readonly enteredMinutesAgo?: number;
  readonly rowState?: 'running' | 'completed';
  /** The current attempt of the stage (the insert's `stage_attempts` and the open row's). */
  readonly attempt?: number;
}): Promise<Id> => {
  ticket += 1;
  const stage = input.stage ?? 'implementation';
  const { rows } = await client.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, template_snapshot, stage_attempts)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/ACME', 'feature',
             $3::task_state, $4, $5::jsonb, $6::jsonb) returning id`,
    [
      projectId,
      `ACME-${ticket}`,
      input.state ?? 'active',
      stage,
      JSON.stringify(FEATURE_TEMPLATE),
      JSON.stringify({ [stage]: input.attempt ?? 1 }),
    ],
  );
  const taskId = rows[0]?.id as Id;
  await client.query(
    `insert into task_stages (task_id, stage, attempt, state, entered_at, exited_at, outcome)
     values ($1, $2, $5, $3, now() - ($4::int * interval '1 minute'),
             case when $3 = 'running' then null else now() end,
             case when $3 = 'running' then null else 'pass' end)`,
    [taskId, stage, input.rowState ?? 'running', input.enteredMinutesAgo ?? 10, input.attempt ?? 1],
  );
  return taskId;
};

const seedRun = async (
  taskId: Id,
  status: string,
  ended: { readonly reason: string | null; readonly minutesAgo: number } | null = null,
): Promise<void> => {
  const stage = await client.query<{ id: string }>(
    'select id from task_stages where task_id = $1',
    [taskId],
  );
  await client.query(
    `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                       attempt, status, started_at, terminal_reason, ended_at)
     values ($1, $2, $3, 'developer', 'claude-opus-5', 'high', 'feature@1+developer', 1,
             $4::run_status, now() - interval '5 minutes', $5::run_terminal_reason,
             case when $6::int is null then null else now() - ($6::int * interval '1 minute') end)`,
    [
      taskId,
      stage.rows[0]?.id,
      projectId,
      status,
      ended?.reason ?? null,
      ended?.minutesAgo ?? null,
    ],
  );
};

const sendStageJob = async (taskId: Id): Promise<string> => {
  const sent = await sender.jobs.enqueue({
    queue: JOB_QUEUES.stageExecute,
    data: { task_id: taskId },
    singletonKey: `task:${taskId}`,
  });
  expect(sent.status).toBe('enqueued');
  return (sent as { readonly jobId: string }).jobId;
};

const query = (overrides: Partial<{ olderThan: string; endingBefore: string }> = {}) => ({
  olderThan: (overrides.olderThan ?? minutesAgo(1)) as IsoDateTime,
  endingBefore: (overrides.endingBefore ?? minutesAgo(60)) as IsoDateTime,
  limit: 50,
});

const foundIds = async (q = query()): Promise<readonly Id[]> =>
  (await store.strandedStages(tx, q)).map((row) => row.taskId);

beforeAll(async () => {
  database = await createMigratedDatabase('stranded-stage');
  handle = db.createDatabasePool(
    {
      url: database.connectionString,
      appRole: 'platform_app',
      poolMax: 4,
      connectionTimeoutMs: db.DATABASE_CONFIG_DEFAULTS.connectionTimeoutMs,
      partitionMonthsAhead: 3,
      transcriptRetentionDays: null,
    },
    strictPoolLogger,
  );
  sender = jobs.createPgBossJobs({
    database: jobs.asJobsDatabase(handle.pool),
    supervise: false,
    schedule: false,
  });
  await sender.start();
  const setup = createTestClient(database.connectionString);
  await setup.connect();
  try {
    const org = await setup.query<{ id: string }>(
      "insert into organizations (name) values ('stranded stages') returning id",
    );
    const project = await setup.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'ss', 'Stranded', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as Id;
  } finally {
    await setup.end();
  }
}, 120_000);

afterAll(async () => {
  await sender?.stop();
  await handle?.close();
  await database?.drop();
});

beforeEach(async () => {
  client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  tx = { adapter: 'postgres', client } as unknown as Transaction;
});

afterEach(async () => {
  await client.query('rollback');
  await client.end();
});

describe('the stranded-stage store (WP-108, backlog 320)', () => {
  it('finds a task at an agent or gate stage with no job and no run, and none of the others', async () => {
    const stranded = await seedTask({});
    const gate = await seedTask({ stage: 'ci_gate' });
    const queued = await seedTask({});
    await sendStageJob(queued);
    const running = await seedTask({});
    await seedRun(running, 'running');
    const ranAndFailed = await seedTask({});
    await seedRun(ranAndFailed, 'failed', { reason: 'lease_expired', minutesAgo: 3 });
    // Cancelled by a person inside the grace: not yet — the grace counts from the run's end.
    const justCancelled = await seedTask({ state: 'retro', stage: 'retrospective' });
    await seedRun(justCancelled, 'cancelled', { reason: 'cancelled', minutesAgo: 0 });
    await seedTask({ rowState: 'completed' });
    await seedTask({ stage: 'ready_for_merge' });
    await seedTask({ enteredMinutesAgo: 0 });
    await seedTask({ state: 'paused' });
    await seedTask({ state: 'needs_human' });

    const found = await store.strandedStages(tx, query());
    // A run that already ended is not a live run: its task is found — **with** the ending, which
    // is what keeps the pass from running the stage again (WP-108 review round 1).
    expect([...found.map((row) => row.taskId)].sort()).toEqual(
      [stranded, gate, ranAndFailed].sort(),
    );
    expect(found.find((entry) => entry.taskId === ranAndFailed)?.endedRun).toEqual({
      status: 'failed',
      terminalReason: 'lease_expired',
    });
    expect(found.find((entry) => entry.taskId === stranded)?.endedRun).toBeNull();
    expect(await foundIds(query({ olderThan: minutesAgo(-1) }))).toContain(justCancelled);
    const row = found.find((entry) => entry.taskId === stranded) as StrandedStage;
    expect(row).toMatchObject({
      projectId,
      stage: 'implementation',
      attempt: 1,
      recoveryAttemptedAt: null,
    });
    // The database's own microsecond rendering, so the entry can be named back exactly.
    expect(row.enteredAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  });

  it('finds a task again once pg-boss has given up on its stage job (backlog 325)', async () => {
    const task = await seedTask({});
    const jobId = await sendStageJob(task);
    expect(await foundIds()).not.toContain(task);
    await handle.pool.query(
      "update pgboss.job set state = 'failed', completed_on = now() where id = $1",
      [jobId],
    );
    expect(await foundIds()).toContain(task);
  });

  /**
   * Backlog 490: the entry's failed job, read for the ending's brief — the error's class and code
   * and its cause's, as pg-boss stores them through serialize-error (the `output` below is that
   * library's answer for AUT-6820's error, measured with serialize-error 13.0.1), never its message.
   * A failed job of another attempt of the stage, or one older than the entry, is not this entry's.
   */
  it('reads the entry’s failed job by class and code, and no other entry’s (backlog 490)', async () => {
    const failJob = async (
      taskId: Id,
      data: { readonly stage: string; readonly attempt: number },
      completedMinutesAgo: number,
    ): Promise<void> => {
      const sent = await sender.jobs.enqueue({
        queue: JOB_QUEUES.stageExecute,
        data: { task_id: taskId, project_id: projectId, ...data },
        singletonKey: `task:${taskId}`,
      });
      expect(sent.status).toBe('enqueued');
      await handle.pool.query(
        `update pgboss.job set state = 'failed', retry_count = 2,
                completed_on = now() - ($3::int * interval '1 minute'), output = $2::jsonb
          where id = $1`,
        [
          (sent as { readonly jobId: string }).jobId,
          JSON.stringify({
            code: 'unavailable',
            provider: 'gitlab',
            action: 'get_merge_request',
            retryable: true,
            name: 'IntegrationError',
            message: 'gitlab: GET /projects/1 could not be reached FAKE-token-in-a-message',
            cause: {
              name: 'TimeoutError',
              message: 'The operation was aborted due to timeout',
              code: 23,
            },
          }),
          completedMinutesAgo,
        ],
      );
    };
    const failed = await seedTask({ stage: 'ci_gate', enteredMinutesAgo: 30 });
    await failJob(failed, { stage: 'ci_gate', attempt: 1 }, 5);
    const otherAttempt = await seedTask({ stage: 'ci_gate', attempt: 2, enteredMinutesAgo: 30 });
    await failJob(otherAttempt, { stage: 'ci_gate', attempt: 1 }, 5);
    const beforeEntry = await seedTask({ stage: 'ci_gate', enteredMinutesAgo: 30 });
    await failJob(beforeEntry, { stage: 'ci_gate', attempt: 1 }, 45);

    const found = await store.strandedStages(tx, query());
    const row = found.find((entry) => entry.taskId === failed);
    expect(row?.failedJob).toEqual({
      failedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      tries: 3,
      errorName: 'IntegrationError',
      errorCode: 'unavailable',
      causeName: 'TimeoutError',
      causeCode: '23',
    });
    expect(JSON.stringify(row)).not.toContain('FAKE-token');
    expect(found.find((entry) => entry.taskId === otherAttempt)?.failedJob).toBeNull();
    expect(found.find((entry) => entry.taskId === beforeEntry)?.failedJob).toBeNull();
  });

  it('marks an entry once, only while it is stranded, and reads the mark back as that entry’s', async () => {
    const task = await seedTask({});
    const [row] = await store.strandedStages(tx, query());
    expect(row?.taskId).toBe(task);
    const entry = row as StrandedStage;
    const at = minutesAgo(0);
    expect(await store.markStageAttempt(tx, { row: entry, at })).toBe(true);
    // Marked: inside the ending window it is not found; past it, it is found with its mark.
    expect(await foundIds()).not.toContain(task);
    const ending = await store.strandedStages(tx, query({ endingBefore: minutesAgo(-1) }));
    expect(ending.find((r) => r.taskId === task)?.recoveryAttemptedAt).toBe(at);
    // A second mark for the same entry writes nothing.
    expect(await store.markStageAttempt(tx, { row: entry, at: minutesAgo(-2) })).toBe(false);
    expect(await store.isStillStranded(tx, entry)).toBe(true);
  });

  it('writes no mark and answers not stranded once a job is owed or the entry moved', async () => {
    const queued = await seedTask({});
    const [row] = await store.strandedStages(tx, query());
    const entry = row as StrandedStage;
    expect(entry.taskId).toBe(queued);
    await sendStageJob(queued);
    expect(await store.markStageAttempt(tx, { row: entry, at: minutesAgo(0) })).toBe(false);
    expect(await store.isStillStranded(tx, entry)).toBe(false);

    const moved = await seedTask({});
    const [other] = (await store.strandedStages(tx, query())).filter((r) => r.taskId === moved);
    await client.query(
      `update task_stages set entered_at = now() - interval '2 minutes' where task_id = $1`,
      [moved],
    );
    // Re-entered at another instant: the pass's entry is no longer the task's.
    expect(await store.isStillStranded(tx, other as StrandedStage)).toBe(false);
    expect(
      await store.markStageAttempt(tx, { row: other as StrandedStage, at: minutesAgo(0) }),
    ).toBe(false);
  });

  it('reads a mark older than the current entry as no mark: one attempt per stage entry', async () => {
    const task = await seedTask({ enteredMinutesAgo: 5 });
    const [row] = (await store.strandedStages(tx, query())).filter((r) => r.taskId === task);
    // A mark from before this entry — the store's own writer, so the column census holds (an
    // earlier entry's attempt is what leaves one).
    expect(
      await store.markStageAttempt(tx, { row: row as StrandedStage, at: minutesAgo(30) }),
    ).toBe(true);
    const found = await store.strandedStages(tx, query());
    expect(found.find((r) => r.taskId === task)?.recoveryAttemptedAt).toBeNull();
  });

  it('reads the ended run of the current attempt only: an earlier attempt’s cancelled run does not stop a re-enqueue (WP-108 review round 2)', async () => {
    // Attempt 2 of the stage is open, entered ten minutes ago, with no run at all …
    const task = await seedTask({ attempt: 2 });
    // … and attempt 1 was returned, with a run a person cancelled.
    const earlier = await client.query<{ id: string }>(
      `insert into task_stages (task_id, stage, attempt, state, entered_at, exited_at, outcome)
       values ($1, 'implementation', 1, 'returned', now() - interval '30 minutes',
               now() - interval '15 minutes', 'returned') returning id`,
      [task],
    );
    await client.query(
      `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                         attempt, status, started_at, terminal_reason, ended_at)
       values ($1, $2, $3, 'developer', 'claude-opus-5', 'high', 'feature@1+developer', 1,
               'cancelled', now() - interval '25 minutes', 'cancelled', now() - interval '20 minutes')`,
      [task, earlier.rows[0]?.id, projectId],
    );
    const [row] = (await store.strandedStages(tx, query())).filter((r) => r.taskId === task);
    expect(row?.attempt).toBe(2);
    expect(row?.endedRun).toBeNull();
  });

  it('finds a retrospective whose run a person cancelled, with the ending, and never marks it (WP-108 review round 1)', async () => {
    // `retro` has no edge to `paused`, so a cancel with no live lease leaves the task at its stage.
    const task = await seedTask({ state: 'retro', stage: 'retrospective' });
    await seedRun(task, 'cancelled', { reason: 'cancelled', minutesAgo: 5 });
    const [row] = (await store.strandedStages(tx, query())).filter((r) => r.taskId === task);
    expect(row?.endedRun).toEqual({ status: 'cancelled', terminalReason: 'cancelled' });
    expect(await store.markStageAttempt(tx, { row: row as StrandedStage, at: minutesAgo(0) })).toBe(
      false,
    );
    expect(await store.isStillStranded(tx, row as StrandedStage)).toBe(true);
  });

  it('answers an attempt’s row as open, closed or absent — what stage.execute’s revalidation reads (backlog 365)', async () => {
    const pipelineStore = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
    const open = await seedTask({});
    const closed = await seedTask({ rowState: 'completed' });
    const at = (taskId: Id, attempt = 1) =>
      pipelineStore.tasks.stageAttemptState(tx, taskId, 'implementation' as never, attempt);
    expect(await at(open)).toBe('open');
    expect(await at(closed)).toBe('closed');
    expect(await at(open, 2)).toBe('absent');
  });
});
