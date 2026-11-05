/**
 * The run-lease sweep against a real PostgreSQL 18 — WP-47, PROGRESS backlog **109** and **50**.
 *
 * Three things can only be shown here, and each of them is one of the work package's criteria.
 *
 * **(1) The row moving is not the reservation moving.** A stranded run costs money through
 * `pendingSpend`, which is SQL over the runs the ledger has not charged — so a test that read back
 * only `runs.status` would be green on a sweep that ended the row and left the cap exactly as it
 * was. Both are read, before and after: the live reservation becomes a **hold** at the same figure
 * (WP-131, PROGRESS backlog 402), because nobody measured what the swept run spent.
 *
 * **(2) The negative case, which is a lock rather than a re-read.** A heartbeat committing between
 * the pass's read and the ending's transaction must stop the ending, and the mechanism that makes
 * that true is `select … for update` inside the claim. No in-memory store can be wrong about that
 * in the way PostgreSQL can, so it is asserted here, at the boundary and one past it (standing rule
 * 42): a lease one second *inside* the grace is not swept, one second outside it is.
 *
 * **(7) The figure rule 39 asks for.** `DEFAULT_STAGE_RUN_BUDGET_USD.implementation` is **15**, and
 * that is what one stranded implementation run reserved against every future window of its project
 * and its organisation before this change. The number is taken from the shipped default rather than
 * typed in. The assertion was `15` before the sweep and `0` after it until WP-131, which holds the
 * swept run at its reservation instead: `15` pending before, `15` held after, `0` spent throughout.
 */
import type { Commitment, ExpiredRunQuery, Transaction } from '@platform/application';
import {
  declarePipelineQueues,
  runStrandedRecovery,
  sweepExpiredRunLeases,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  addMs,
  DEFAULT_STAGE_RUN_BUDGET_USD,
  FEATURE_TEMPLATE,
  SHIPPED_TEMPLATES,
} from '@platform/domain';
import {
  cost as costAdapters,
  eventing,
  jobs as jobsAdapters,
  pipeline as pipelineAdapters,
  recovery as recoveryAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recentInstant } from '../../support/recent-instant.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let orgId: string;
let projectId: string;
let taskId: string;

const store = recoveryAdapters.createPostgresExpiredRunStore();
const pipeline = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
const costStore = costAdapters.createPostgresCostStore();

/** The instant every case computes its bounds from. */
// Taken from the wall clock, not written as a literal: the sweep appends `run.failed` at this
// instant, and the event log refuses one before the previous UTC month (`recent-instant.ts`). Every
// other instant below is an offset from it, so each case asserts the same boundary it always did.
const NOW = recentInstant();
const MINUTE = 60_000;
/** `NOW` shifted by `minutes`. */
const at = (minutes: number): IsoDateTime => addMs(NOW, minutes * MINUTE);
const GRACE_MS = 60_000;
const WALL_CLOCK_MS = 60 * 60_000;
/** `now - grace`: a lease that expired before this is gone. */
const LEASE_CUTOFF = at(-1);
/** `now - (wallClock + grace)`: the backstop for a run that never held a lease. */
const STARTED_CUTOFF = at(-61);

const QUERY: ExpiredRunQuery = {
  leaseExpiredBefore: LEASE_CUTOFF,
  startedBefore: STARTED_CUTOFF,
  limit: 10,
};

const withTx = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    return await fn({ adapter: 'postgres', client } as unknown as Transaction);
  } finally {
    await client.end();
  }
};

interface SeededRun {
  readonly leaseExpiresAt?: string | null;
  /** `null` is a run that never reached its CLI spawn marker (WP-275b). */
  readonly startedAt?: string | null;
  readonly status?: string;
  /** The row's `created_at`; absent is the column's own default, `now()`. */
  readonly createdAt?: string;
}

/** `(task_id, stage, attempt)` is unique, so a case that seeds two runs seeds two attempts. */
let attempt = 0;

const seedRun = async (run: SeededRun = {}): Promise<string> => {
  attempt += 1;
  const stage = await pool.query<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state)
     values ($1, 'implementation', $2, 'running') returning id`,
    [taskId, attempt],
  );
  const inserted = await pool.query<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                       attempt, status, started_at, lease_owner, lease_expires_at, created_at)
     values ($1, $2, $3, 'developer', 'claude-opus-5', 'high', 'feature@1+developer',
             $8, $4::run_status, $5::timestamptz, $6, $7::timestamptz,
             coalesce($9::timestamptz, now())) returning id`,
    [
      taskId,
      stage.rows[0]?.id,
      projectId,
      run.status ?? 'running',
      run.startedAt === undefined ? at(-30) : run.startedAt,
      run.leaseExpiresAt === null ? null : 'server-1:0f0f0f0f',
      run.leaseExpiresAt === undefined ? at(-10) : run.leaseExpiresAt,
      attempt,
      run.createdAt ?? null,
    ],
  );
  return inserted.rows[0]?.id as string;
};

/**
 * What this project's runs have committed to a window the ledger has not recorded yet — the live
 * reservations and the ended figures (`pendingUsd`), and the runs nobody measured, held at their
 * reservations (`heldUsd`, `heldRuns` — WP-131).
 */
const pendingUsd = (reserveUsd: number): Promise<Commitment> =>
  withTx(async (tx) =>
    costStore.pendingSpend(
      tx,
      { scope: 'project', scopeId: projectId as Id },
      at(-12 * 60),
      reserveUsd,
    ),
  );

const sweep = async () =>
  sweepExpiredRunLeases({
    store,
    pipeline,
    unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
    eventStore: new eventing.PostgresEventStore(pool),
    context: (correlationId) => ({
      ids: { next: () => crypto.randomUUID() as Id },
      actor: { kind: 'system', component: 'pipeline.run-lease.sweep' },
      clock: { now: () => NOW },
      correlationId,
      causeEventId: null,
    }),
    clock: { now: () => NOW },
    graceMs: GRACE_MS,
    wallClockMs: WALL_CLOCK_MS,
    limit: 10,
    replan: { jobs: jobsAdapters.createInMemoryJobs().jobs, revokeCredentials: async () => {} },
  });

beforeAll(async () => {
  database = await createMigratedDatabase('run-lease');
  pool = createTestPool(database.connectionString, { max: 6 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('lease') returning id",
  );
  orgId = org.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'lease', 'Lease', 'https://git.example.test/acme/lease.git') returning id`,
    [orgId],
  );
  projectId = project.rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  attempt = 0;
  await pool.query('delete from runs');
  await pool.query('delete from tasks');
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, template_snapshot)
     values ($1, 'fake-jira', 'ACME-1', 'https://jira.example.test/browse/ACME-1', 'feature',
             'active', 'implementation', $2::jsonb) returning id`,
    [projectId, JSON.stringify(FEATURE_TEMPLATE)],
  );
  taskId = task.rows[0]?.id as string;
});

describe('the expired-run query', () => {
  it('finds a lease past the grace and not one inside it (rule 42)', async () => {
    const gone = await seedRun({ leaseExpiresAt: addMs(LEASE_CUTOFF, -1000) });
    // One second on the other side of the same cutoff: a heartbeat that landed a moment ago.
    await seedRun({ leaseExpiresAt: addMs(LEASE_CUTOFF, 1000) });

    const found = await withTx(async (tx) => store.expiredRuns(tx, QUERY));

    expect(found.map((run) => run.runId)).toEqual([gone]);
    expect(found[0]?.leaseOwner).toBe('server-1:0f0f0f0f');
  });

  it('falls back to the wall clock only for a run that never held a lease', async () => {
    // A row from before `lease_expires_at` had a writer, older than a whole wall clock plus grace.
    const old = await seedRun({ leaseExpiresAt: null, startedAt: addMs(STARTED_CUTOFF, -1000) });
    // The same row one second inside the backstop.
    await seedRun({ leaseExpiresAt: null, startedAt: addMs(STARTED_CUTOFF, 1000) });
    // A **leased** run started long ago whose lease is fresh: the wall clock must not reach it, or
    // the backstop would end every run that outlives an hour while its process is renewing.
    await seedRun({
      startedAt: at(-180),
      leaseExpiresAt: at(5),
    });

    const found = await withTx(async (tx) => store.expiredRuns(tx, QUERY));

    expect(found.map((run) => run.runId)).toEqual([old]);
  });

  /**
   * WP-275b: `started_at` is written only at the CLI spawn marker, so a `starting` run with no lease
   * and no `started_at` would never meet a `started_at` backstop. The backstop reads
   * `coalesce(started_at, created_at)`: a run created longer ago than a wall clock plus grace is
   * found, one created inside it is not (rule 42). Canary: the pre-WP-275b predicate finds neither.
   */
  it('reaches a never-started run through its created_at, and not one created inside the bound', async () => {
    const stuck = await seedRun({
      status: 'starting',
      leaseExpiresAt: null,
      startedAt: null,
      createdAt: addMs(STARTED_CUTOFF, -1000),
    });
    await seedRun({
      status: 'starting',
      leaseExpiresAt: null,
      startedAt: null,
      createdAt: addMs(STARTED_CUTOFF, 1000),
    });

    const found = await withTx(async (tx) => store.expiredRuns(tx, QUERY));

    expect(found.map((run) => run.runId)).toEqual([stuck]);
    expect(found[0]?.startedAt).toBeNull();
  });

  it('leaves a terminal run alone, whatever its lease says', async () => {
    await seedRun({ status: 'completed', leaseExpiresAt: at(-60) });

    expect(await withTx(async (tx) => store.expiredRuns(tx, QUERY))).toEqual([]);
  });

  it('claims a row whose bound still holds and refuses one whose lease was renewed', async () => {
    const runId = await seedRun({ leaseExpiresAt: at(-10) });

    expect(
      await withTx(async (tx) => store.claimExpiredRun(tx, { runId: runId as Id, query: QUERY })),
    ).toBe(true);

    // The heartbeat lands between the pass's read and the ending's transaction. This is the case
    // the sweep must not act on, and in production it is prevented by the `for update` this claim
    // takes rather than by the re-read.
    await pool.query('update runs set lease_expires_at = $2::timestamptz where id = $1', [
      runId,
      at(5),
    ]);
    expect(
      await withTx(async (tx) => store.claimExpiredRun(tx, { runId: runId as Id, query: QUERY })),
    ).toBe(false);
  });
});

describe('the sweep', () => {
  it('ends the run, escalates the task, and holds the run at its $15 reservation rather than at 0', async () => {
    const runId = await seedRun();
    const reserve = DEFAULT_STAGE_RUN_BUDGET_USD.implementation ?? 0;

    /**
     * **Criterion 7's figure, taken from the shipped default rather than typed in.**
     *
     * A live run is valued at the admitting stage's per-run cap, which for `implementation` is 15,
     * and it is charged to *every* future daily and monthly window because a live run is always in
     * the window — there is no rollover that could retire it.
     */
    expect(reserve).toBe(15);
    expect(await pendingUsd(reserve)).toEqual({ pendingUsd: 15, heldUsd: 0, heldRuns: 0 });

    const first = await sweep();
    expect(first).toEqual({ found: 1, ended: 1, skipped: 0, replanned: 0 });

    const row = await pool.query<{
      status: string;
      terminal_reason: string;
      usd_reported: string | null;
      usd_estimated: string | null;
    }>('select status, terminal_reason, usd_reported, usd_estimated from runs where id = $1', [
      runId,
    ]);
    expect(row.rows[0]?.status).toBe('failed');
    // Never `cancelled` and never `crash`: a missing heartbeat is a fact about the platform.
    expect(row.rows[0]?.terminal_reason).toBe('lease_expired');
    // And no figure, because nobody measured one — a `0` here would be read as a free run.
    expect(row.rows[0]?.usd_reported).toBeNull();
    expect(row.rows[0]?.usd_estimated).toBeNull();

    const task = await pool.query<{ state: string }>('select state from tasks where id = $1', [
      taskId,
    ]);
    expect(task.rows[0]?.state).toBe('needs_human');

    // The half the row alone would not say. Until WP-131 the reservation was **released** here —
    // the swept run counted 0 to every cap from its ending on, though nobody knew what it had
    // spent (PROGRESS backlog 402). It is now **held**: no longer a live reservation, a run nobody
    // measured, at the cap it was admitted at — this row recorded none (`reserve_usd` null), so the
    // admitting reserve stands in. Held, never spent: the ledger still has no row for it.
    expect(await pendingUsd(reserve)).toEqual({ pendingUsd: 0, heldUsd: 15, heldRuns: 1 });
    const entries = await pool.query('select 1 from cost_entries where run_id = $1', [runId]);
    expect(entries.rowCount).toBe(0);

    // A second pass is a no-op: the run is terminal, so the query cannot see it again. That is the
    // bound this site has instead of the attempt mark the other two rows of the table carry.
    expect(await sweep()).toEqual({ found: 0, ended: 0, skipped: 0, replanned: 0 });
    expect(await pendingUsd(reserve)).toEqual({ pendingUsd: 0, heldUsd: 15, heldRuns: 1 });
  });

  /**
   * WP-101 (TD-028 decision 11, criterion 3): a cancel recorded for a live lease whose holder then
   * died. Nobody is left to apply the stop, so the row waits — and the sweep's ending is what closes
   * it, like every command still pending when a run ends. The run reads `lease_expired`, not
   * `cancelled`, because no process confirmed the stop.
   */
  it('closes a cancel the dead holder never applied run_ended, and the run reads lease_expired (WP-101)', async () => {
    const runId = await seedRun();
    const command = crypto.randomUUID();
    await pool.query(
      `insert into run_commands (id, run_id, task_id, kind, payload)
       values ($1, $2, $3, 'cancel', '{}'::jsonb)`,
      [command, runId, taskId],
    );

    expect(await sweep()).toEqual({ found: 1, ended: 1, skipped: 0, replanned: 0 });

    const run = await pool.query<{ status: string; terminal_reason: string }>(
      'select status, terminal_reason from runs where id = $1',
      [runId],
    );
    expect(run.rows[0]).toEqual({ status: 'failed', terminal_reason: 'lease_expired' });
    const row = await pool.query<{ applied: boolean; refused_reason: string | null }>(
      'select applied_at is not null as applied, refused_reason from run_commands where id = $1',
      [command],
    );
    expect(row.rows[0]).toEqual({ applied: false, refused_reason: 'run_ended' });
  });

  it('appends one `run.failed` carrying no usage and no cost, so the ledger writes nothing', async () => {
    const runId = await seedRun();
    await sweep();

    const events = await pool.query<{ type: string; payload: Record<string, unknown> }>(
      "select type, payload from events where stream_type = 'run' and stream_id = $1 order by position",
      [runId],
    );
    expect(events.rows.map((row) => row.type)).toEqual(['run.failed']);
    // The ledger's `no_usage_and_no_cost` branch: no `cost_entries` row, no rollup delta and no
    // budget movement, rather than a zero that reads as a free run (standing rule 16).
    expect(events.rows[0]?.payload.usage).toBeNull();
    expect(events.rows[0]?.payload.cost).toBeNull();
    expect(events.rows[0]?.payload.terminal_reason).toBe('lease_expired');
  });
});

/**
 * **The ask half of the same ending — PROGRESS backlog 121, WP-48.**
 *
 * The sweep ends the *run* and escalates the *task*; nothing turned that into an ending for the
 * **question** the run was answering, so the thread said `pending` for ever. The row that does is
 * `task_ask_run`, and the only tier that can show the two together is this one: the whole pass is
 * driven over real rows, the run is ended **through the sweep**, and the ask's own status is read
 * back from the table rather than from a return value (rule 79).
 *
 * It takes **two** passes, and that is a property rather than an accident: one pass reads all five
 * queries in a single transaction before any site acts, so the ask's run is still live when
 * `asksWithEndedRun` runs. The next pass sees it. The grace is the same one knob — an ask whose run
 * ended a moment ago is a row in flight, because the executor writes the answer and the run's
 * ending in one transaction.
 */
describe('a question whose run the sweep ended', () => {
  const strandedStore = recoveryAdapters.createPostgresStrandedWorkStore();
  let userId: string;

  const iso = (offsetMs: number): IsoDateTime =>
    new Date(Date.now() + offsetMs).toISOString() as IsoDateTime;

  /** The whole pass — every site — at a caller-chosen instant, with a queue nothing reads. */
  const pass = async (now: IsoDateTime) =>
    runStrandedRecovery({
      store: strandedStore,
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      jobs: jobsAdapters.createInMemoryJobs().jobs,
      clock: { now: () => now },
      graceMs: GRACE_MS,
      runs: {
        store,
        pipeline,
        unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
        eventStore: new eventing.PostgresEventStore(pool),
        context: (correlationId) => ({
          ids: { next: () => crypto.randomUUID() as Id },
          actor: { kind: 'system', component: 'pipeline.run-lease.sweep' },
          clock: { now: () => now },
          correlationId,
          causeEventId: null,
        }),
        wallClockMs: WALL_CLOCK_MS,
        replan: { jobs: jobsAdapters.createInMemoryJobs().jobs, revokeCredentials: async () => {} },
      },
    });

  const seedAsk = async (runId: string, question: string): Promise<string> => {
    const row = await pool.query<{ id: string }>(
      `insert into task_asks (task_id, project_id, source, asked_by_user_id, question, status,
                              created_at, run_id)
       values ($1, $2, 'ui', $3, $4, 'pending', now() - interval '10 minutes', $5)
       returning id`,
      [taskId, projectId, userId, question, runId],
    );
    return row.rows[0]?.id as string;
  };

  const statusOf = async (askId: string) =>
    (
      await pool.query<{ status: string; refusal_reason: string | null }>(
        'select status, refusal_reason from task_asks where id = $1',
        [askId],
      )
    ).rows[0];

  beforeAll(async () => {
    const user = await pool.query<{ id: string }>(
      "insert into users (email, name) values ('asker@example.test', 'Asker') returning id",
    );
    userId = user.rows[0]?.id as string;
  });

  beforeEach(async () => {
    await pool.query('delete from task_asks');
  });

  it('ends the question the pass after it ends the run, and leaves a live one alone', async () => {
    // The run nothing is renewing, and the question it was answering.
    const deadRunId = await seedRun({
      leaseExpiresAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const stranded = await seedAsk(deadRunId, 'why is the total wrong?');
    // The negative case (rule 42): a question whose run is still being renewed. Ending it would
    // throw away a run the project is paying for, at the moment it is about to answer.
    const liveRunId = await seedRun({
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const live = await seedAsk(liveRunId, 'and what about the footer?');

    // Pass 1 ends the **run** — its five reads happened before any site acted, so the ask's run was
    // still live when `asksWithEndedRun` ran.
    const first = await pass(iso(0));
    expect(first.find((site) => site.site === 'run_lease')).toMatchObject({ found: 1, ended: 1 });
    expect(first.find((site) => site.site === 'task_ask_run')).toMatchObject({
      found: 0,
      ended: 0,
    });
    expect((await statusOf(stranded))?.status).toBe('pending');

    // Pass 2, a grace later, ends the **question**.
    const second = await pass(iso(5 * 60_000));
    expect(second.find((site) => site.site === 'task_ask_run')).toMatchObject({
      found: 1,
      ended: 1,
    });
    const ended = await statusOf(stranded);
    // `failed` rather than `refused`: the platform did try, and the reason quotes the run's own
    // ending — both strings are platform enum values, so the thread carries nothing untrusted.
    expect(ended?.status).toBe('failed');
    expect(ended?.refusal_reason).toContain('lease_expired');

    // …and the live one is untouched by either pass.
    expect((await statusOf(live))?.status).toBe('pending');

    // A third pass is a no-op: `recordRefusal` moved the ask off `pending`, which is the bound this
    // row has instead of the attempt mark the re-enqueuing rows carry.
    const third = await pass(iso(10 * 60_000));
    expect(third.find((site) => site.site === 'task_ask_run')).toMatchObject({
      found: 0,
      ended: 0,
    });
    expect((await statusOf(stranded))?.status).toBe('failed');
  });
});

/**
 * **WP-286 (TD-031 §12): a lost worker re-plans its stage entry once.** Only this tier can show the
 * three facts together over real rows: the sweep's transaction closes the run's offer (so the per-task
 * index admits **exactly one** re-planned offer), counts the entry's `lost_runs`, and leaves the task
 * at its stage; the re-planned offer carries the lost worker in its exclusions; and a sweep that dies
 * between its commit and its enqueue leaves an entry the stranded-stage row re-plans — once — rather
 * than escalates.
 */
describe('a lost worker re-plans its stage entry once (WP-286)', () => {
  let boss: ReturnType<typeof jobsAdapters.createPgBossJobs>;
  let workerId: string;

  beforeAll(async () => {
    boss = jobsAdapters.createPgBossJobs({
      database: jobsAdapters.asJobsDatabase(pool),
      supervise: false,
      schedule: false,
    });
    await boss.start();
    const user = await pool.query<{ id: string }>(
      "insert into users (email, name) values ('laptop-owner@example.test', 'Owner') returning id",
    );
    const worker = await pool.query<{ id: string }>(
      `insert into workers (id, user_id, name, credential_hash)
       values (gen_random_uuid(), $1, 'closed-laptop', $2) returning id`,
      [user.rows[0]?.id, 'c'.repeat(64)],
    );
    workerId = worker.rows[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await boss?.stop();
  });

  /** The task at `implementation` attempt 1, its run held by the worker under a claimed offer. */
  const seedLostEntry = async (): Promise<string> => {
    // The task again, at `implementation` attempt 1 — what makes its run the entry's.
    await pool.query('delete from tasks where id = $1', [taskId]);
    const task = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                          current_stage, template_snapshot, stage_attempts)
       values ($1, 'fake-jira', 'ACME-1', 'https://jira.example.test/browse/ACME-1', 'feature',
               'active', 'implementation', $2::jsonb, '{"implementation": 1}'::jsonb) returning id`,
      [projectId, JSON.stringify(FEATURE_TEMPLATE)],
    );
    taskId = task.rows[0]?.id as string;
    const runId = await seedRun();
    await pool.query(
      'update runs set lease_owner = $2, worker_id = $3, lease_epoch = 1 where id = $1',
      [runId, `worker:${workerId}`, workerId],
    );
    await pool.query(
      `insert into run_offers (id, run_id, task_id, project_id, stage, attempt, kind, state,
                               lease_epoch, claimant_kind, worker_id, offered_at, claimed_at)
       values (gen_random_uuid(), $1, $2, $3, 'implementation', 1, 'stage', 'claimed', 1,
               'worker', $4, now() - interval '40 minutes', now() - interval '35 minutes')`,
      [runId, taskId, projectId, workerId],
    );
    return runId;
  };

  const sweepWith = async (replan: {
    readonly enqueue?: () => Promise<never>;
    readonly order: string[];
  }) => {
    const memory = jobsAdapters.createInMemoryJobs().jobs;
    await declarePipelineQueues(memory);
    return sweepExpiredRunLeases({
      store,
      pipeline,
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      eventStore: new eventing.PostgresEventStore(pool),
      context: (correlationId) => ({
        ids: { next: () => crypto.randomUUID() as Id },
        actor: { kind: 'system', component: 'pipeline.run-lease.sweep' },
        clock: { now: () => NOW },
        correlationId,
        causeEventId: null,
      }),
      clock: { now: () => NOW },
      graceMs: GRACE_MS,
      wallClockMs: WALL_CLOCK_MS,
      limit: 10,
      replan: {
        jobs: {
          ...memory,
          enqueue: async (request) => {
            replan.order.push(`enqueue:${request.queue}`);
            if (replan.enqueue !== undefined) return replan.enqueue();
            return memory.enqueue(request);
          },
        },
        revokeCredentials: async (runId) => {
          replan.order.push(`revoke:${runId}`);
        },
      },
    });
  };

  /** A new run of the same entry and its offer, as `stage.execute` writes them; answers the offer insert. */
  const offerAgain = async (): Promise<{ readonly excluded: readonly string[] }> => {
    const stage = await pool.query<{ id: string }>(
      `select id from task_stages where task_id = $1 and stage = 'implementation' and attempt = 1`,
      [taskId],
    );
    const run = await pool.query<{ id: string }>(
      `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                         attempt, status)
       values ($1, $2, $3, 'developer', 'claude-opus-5', 'high', 'feature@1+developer', 1, 'created')
       returning id`,
      [taskId, stage.rows[0]?.id, projectId],
    );
    const entry = { taskId: taskId as Id, stage: 'implementation' as never, attempt: 1 };
    const excluded = await withTx(async (tx) => pipeline.offers.carriedExclusions(tx, entry));
    await withTx(async (tx) =>
      pipeline.offers.insert(tx, {
        id: crypto.randomUUID() as Id,
        runId: run.rows[0]?.id as Id,
        taskId: taskId as Id,
        projectId: projectId as Id,
        stage: 'implementation' as never,
        attempt: 1,
        kind: 'stage',
        offeredAt: NOW,
        routing: {
          assigneeUserId: null,
          assigneeUntil: null,
          serverFrom: NOW,
          workersFrom: NOW,
          expiresAt: at(24 * 60),
        },
        excludedWorkerIds: excluded as Id[],
      }),
    );
    return { excluded };
  };

  it('closes the offer, counts the loss, revokes then re-plans; one re-planned offer, carrying the lost worker', async () => {
    const runId = await seedLostEntry();
    const order: string[] = [];
    expect(await sweepWith({ order })).toEqual({ found: 1, ended: 1, skipped: 0, replanned: 1 });
    expect(order).toEqual([`revoke:${runId}`, 'enqueue:stage.execute']);

    const offer = await pool.query<{ state: string }>(
      'select state from run_offers where run_id = $1',
      [runId],
    );
    expect(offer.rows[0]?.state).toBe('settled');
    const entry = await pool.query<{ lost_runs: number; exited_at: Date | null }>(
      `select lost_runs, exited_at from task_stages where task_id = $1 and attempt = 1`,
      [taskId],
    );
    expect(entry.rows[0]).toEqual({ lost_runs: 1, exited_at: null });
    const task = await pool.query<{ state: string }>('select state from tasks where id = $1', [
      taskId,
    ]);
    expect(task.rows[0]?.state).toBe('active');

    // The per-task index admits the re-planned offer — exactly once.
    const { excluded } = await offerAgain();
    expect(excluded).toEqual([workerId]);
    await expect(offerAgain()).rejects.toThrow(/run_offers_one_live_stage_per_task/);
    const live = await pool.query<{ excluded_worker_ids: string[] }>(
      `select excluded_worker_ids from run_offers where task_id = $1 and state = 'open'`,
      [taskId],
    );
    expect(live.rows).toEqual([{ excluded_worker_ids: [workerId] }]);
  });

  it('a sweep killed between its commit and its enqueue is re-planned by the stranded-stage row, once — never escalated', async () => {
    const runId = await seedLostEntry();
    const order: string[] = [];
    await expect(
      sweepWith({
        order,
        enqueue: async () => {
          throw new Error('the process died here');
        },
      }),
    ).rejects.toThrow('the process died here');
    // The ending committed: the run ended, its offer closed, the loss counted; nothing enqueued.
    const run = await pool.query<{ terminal_reason: string }>(
      'select terminal_reason from runs where id = $1',
      [runId],
    );
    expect(run.rows[0]?.terminal_reason).toBe('lease_expired');

    const queued = jobsAdapters.createInMemoryJobs();
    await declarePipelineQueues(queued.jobs);
    const recovered = await runStrandedRecovery({
      store: recoveryAdapters.createPostgresStrandedWorkStore(),
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      jobs: queued.jobs,
      clock: { now: () => new Date(Date.now() + 2 * GRACE_MS).toISOString() as IsoDateTime },
      graceMs: GRACE_MS,
      stages: {
        store: recoveryAdapters.createPostgresStrandedStageStore({ jobsSchema: 'pgboss' }),
        pipeline,
        context: (correlationId) => ({
          ids: { next: () => crypto.randomUUID() as Id },
          actor: { kind: 'system', component: 'stranded-stage-recovery' },
          clock: { now: () => NOW },
          correlationId,
          causeEventId: null,
        }),
      },
    });
    expect(recovered.find((site) => site.site === 'stranded_stage')).toEqual({
      site: 'stranded_stage',
      found: 1,
      reEnqueued: 1,
      ended: 0,
    });
    const task = await pool.query<{ state: string }>('select state from tasks where id = $1', [
      taskId,
    ]);
    expect(task.rows[0]?.state).toBe('active');
    // The re-planned offer, once.
    const { excluded } = await offerAgain();
    expect(excluded).toEqual([workerId]);
    await expect(offerAgain()).rejects.toThrow(/run_offers_one_live_stage_per_task/);
  });

  it('escalates the entry’s second loss, naming both runs and both machines', async () => {
    const first = await seedLostEntry();
    await sweepWith({ order: [] });
    // The re-planned run is lost too, under the server's claimant this time.
    const stage = await pool.query<{ id: string }>(
      `select id from task_stages where task_id = $1 and attempt = 1`,
      [taskId],
    );
    const second = await pool.query<{ id: string }>(
      `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                         attempt, status, started_at, lease_owner, lease_expires_at)
       values ($1, $2, $3, 'developer', 'claude-opus-5', 'high', 'feature@1+developer', 1,
               'running', $4::timestamptz, 'server:core-1', $5::timestamptz) returning id`,
      [taskId, stage.rows[0]?.id, projectId, at(-20), at(-10)],
    );
    const order: string[] = [];
    expect(await sweepWith({ order })).toMatchObject({ ended: 1, replanned: 0 });
    expect(order).toEqual([]);
    const task = await pool.query<{ state: string }>('select state from tasks where id = $1', [
      taskId,
    ]);
    expect(task.rows[0]?.state).toBe('needs_human');
    const brief = await pool.query<{ brief: string }>(
      `select payload ->> 'blocker_brief' as brief from events
        where stream_type = 'task' and stream_id = $1 and type = 'task.escalated'`,
      [taskId],
    );
    expect(brief.rows[0]?.brief).toContain(`run ${first} (held by worker ${workerId})`);
    expect(brief.rows[0]?.brief).toContain(
      `run ${second.rows[0]?.id} (held by the server's runner (core-1))`,
    );
  });
});
