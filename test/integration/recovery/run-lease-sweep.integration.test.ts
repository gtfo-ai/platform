/**
 * The run-lease sweep against a real PostgreSQL 18 — WP-47, PROGRESS backlog **109** and **50**.
 *
 * Three things can only be shown here, and each of them is one of the work package's criteria.
 *
 * **(1) The row moving is not the reservation moving.** A stranded run costs money through
 * `pendingSpend`, which is SQL — `coalesce(usd_reported, usd_estimated, 0)` over the runs the
 * ledger has not charged — so a test that read back only `runs.status` would be green on a sweep
 * that ended the row and left the cap exactly as high as it was. Both are read, before and after.
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
 * typed in, and the assertion is `15` before the sweep and `0` after it.
 */
import type { ExpiredRunQuery, Transaction } from '@platform/application';
import { sweepExpiredRunLeases } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  DEFAULT_STAGE_RUN_BUDGET_USD,
  FEATURE_TEMPLATE,
  SHIPPED_TEMPLATES,
} from '@platform/domain';
import {
  cost as costAdapters,
  eventing,
  pipeline as pipelineAdapters,
  recovery as recoveryAdapters,
} from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let orgId: string;
let projectId: string;
let taskId: string;

const store = recoveryAdapters.createPostgresExpiredRunStore();
const pipeline = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
const costStore = costAdapters.createPostgresCostStore();

/** The instant every case computes its bounds from. */
const NOW = '2026-09-15T12:00:00.000Z' as IsoDateTime;
const GRACE_MS = 60_000;
const WALL_CLOCK_MS = 60 * 60_000;
/** `now - grace`: a lease that expired before this is gone. */
const LEASE_CUTOFF = '2026-09-15T11:59:00.000Z' as IsoDateTime;
/** `now - (wallClock + grace)`: the backstop for a run that never held a lease. */
const STARTED_CUTOFF = '2026-09-15T10:59:00.000Z' as IsoDateTime;

const QUERY: ExpiredRunQuery = {
  leaseExpiredBefore: LEASE_CUTOFF,
  startedBefore: STARTED_CUTOFF,
  limit: 10,
};

const withTx = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    return await fn({ adapter: 'postgres', client } as unknown as Transaction);
  } finally {
    await client.end();
  }
};

interface SeededRun {
  readonly leaseExpiresAt?: string | null;
  readonly startedAt?: string;
  readonly status?: string;
}

/** `(task_id, stage, attempt)` is unique, so a case that seeds two runs seeds two attempts. */
let attempt = 0;

const seedRun = async (run: SeededRun = {}): Promise<string> => {
  attempt += 1;
  const stage = await pool.query<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state)
     values ($1, 'implementation', $2, 'entered') returning id`,
    [taskId, attempt],
  );
  const inserted = await pool.query<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                       attempt, status, started_at, lease_owner, lease_expires_at)
     values ($1, $2, $3, 'developer', 'claude-opus-5', 'high', 'feature@1+developer',
             $8, $4::run_status, $5::timestamptz, $6, $7::timestamptz) returning id`,
    [
      taskId,
      stage.rows[0]?.id,
      projectId,
      run.status ?? 'running',
      run.startedAt ?? '2026-09-15T11:30:00.000Z',
      run.leaseExpiresAt === null ? null : 'server-1:0f0f0f0f',
      run.leaseExpiresAt === undefined ? '2026-09-15T11:50:00.000Z' : run.leaseExpiresAt,
      attempt,
    ],
  );
  return inserted.rows[0]?.id as string;
};

/** What this project's runs have committed to a window the ledger has not recorded yet. */
const pendingUsd = (reserveUsd: number): Promise<number> =>
  withTx(async (tx) =>
    costStore.pendingSpend(
      tx,
      { scope: 'project', scopeId: projectId as Id },
      '2026-09-15T00:00:00.000Z' as IsoDateTime,
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
    const gone = await seedRun({ leaseExpiresAt: '2026-09-15T11:58:59.000Z' });
    // One second on the other side of the same cutoff: a heartbeat that landed a moment ago.
    await seedRun({ leaseExpiresAt: '2026-09-15T11:59:01.000Z' });

    const found = await withTx(async (tx) => store.expiredRuns(tx, QUERY));

    expect(found.map((run) => run.runId)).toEqual([gone]);
    expect(found[0]?.leaseOwner).toBe('server-1:0f0f0f0f');
  });

  it('falls back to the wall clock only for a run that never held a lease', async () => {
    // A row from before `lease_expires_at` had a writer, older than a whole wall clock plus grace.
    const old = await seedRun({ leaseExpiresAt: null, startedAt: '2026-09-15T10:58:59.000Z' });
    // The same row one second inside the backstop.
    await seedRun({ leaseExpiresAt: null, startedAt: '2026-09-15T10:59:01.000Z' });
    // A **leased** run started long ago whose lease is fresh: the wall clock must not reach it, or
    // the backstop would end every run that outlives an hour while its process is renewing.
    await seedRun({
      startedAt: '2026-09-15T09:00:00.000Z',
      leaseExpiresAt: '2026-09-15T12:05:00.000Z',
    });

    const found = await withTx(async (tx) => store.expiredRuns(tx, QUERY));

    expect(found.map((run) => run.runId)).toEqual([old]);
  });

  it('leaves a terminal run alone, whatever its lease says', async () => {
    await seedRun({ status: 'completed', leaseExpiresAt: '2026-09-15T11:00:00.000Z' });

    expect(await withTx(async (tx) => store.expiredRuns(tx, QUERY))).toEqual([]);
  });

  it('claims a row whose bound still holds and refuses one whose lease was renewed', async () => {
    const runId = await seedRun({ leaseExpiresAt: '2026-09-15T11:50:00.000Z' });

    expect(
      await withTx(async (tx) => store.claimExpiredRun(tx, { runId: runId as Id, query: QUERY })),
    ).toBe(true);

    // The heartbeat lands between the pass's read and the ending's transaction. This is the case
    // the sweep must not act on, and in production it is prevented by the `for update` this claim
    // takes rather than by the re-read.
    await pool.query(
      "update runs set lease_expires_at = '2026-09-15T12:05:00.000Z' where id = $1",
      [runId],
    );
    expect(
      await withTx(async (tx) => store.claimExpiredRun(tx, { runId: runId as Id, query: QUERY })),
    ).toBe(false);
  });
});

describe('the sweep', () => {
  it('ends the run, escalates the task, and releases the $15 reservation it was holding', async () => {
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
    expect(await pendingUsd(reserve)).toBe(15);

    const first = await sweep();
    expect(first).toEqual({ found: 1, ended: 1, skipped: 0 });

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

    // The half the row alone would not say: the reservation is **released**, not merely re-labelled.
    expect(await pendingUsd(reserve)).toBe(0);

    // A second pass is a no-op: the run is terminal, so the query cannot see it again. That is the
    // bound this site has instead of the attempt mark the other two rows of the table carry.
    expect(await sweep()).toEqual({ found: 0, ended: 0, skipped: 0 });
    expect(await pendingUsd(reserve)).toBe(0);
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
