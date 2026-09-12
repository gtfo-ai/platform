/**
 * **WP-19's backfill criterion, on a real PostgreSQL**: *"a run that finished before the ledger's
 * handler was registered appears in the rollups after a backfill"*.
 *
 * The sequence is the one the criterion words, against the real dispatcher and the real store:
 *
 *  1. append `run.finished` and let a bus with **no ledger handler** dispatch it — which is exactly
 *     what every `apps/server` between WP-15a and this work package did, and what deletes the
 *     `event_dispatch` row and writes the `$dispatch` marker;
 *  2. observe that the ledger is empty, and that the queue is too (so a re-dispatch is a no-op by
 *     design — PROGRESS backlog 20);
 *  3. register the ledger and run `replayEvents` over the log;
 *  4. the rollups now carry the run, and a second pass changes nothing.
 *
 * The unit tier asserts the same sequence against the in-memory doubles. What only a database shows
 * is the part the mechanism rests on: `handler_executions` is a real table with a real primary key,
 * and the claim the replay makes is the same one the dispatcher makes.
 */
import { costHandlers, EventBus, replayEvents } from '@platform/application';
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { cost, eventing } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const APP_ROLE = 'platform_app';

describe('the cost ledger backfill (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;
  let unitOfWork: eventing.PostgresUnitOfWork;
  let store: eventing.PostgresEventStore;
  let projectId: string;
  let taskId: string;
  let runId: string;
  let stream = 0;

  beforeAll(async () => {
    database = await createMigratedDatabase('cost-backfill');
    pool = createTestPool(database.connectionString, {
      options: `-c role=${APP_ROLE}`,
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    store = new eventing.PostgresEventStore(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    stream = 0;
    const org = await pool.query<{ id: string }>(
      "insert into organizations (name) values ('backfill') returning id",
    );
    const project = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id, `api-${Date.now()}-${Math.random().toString(16).slice(2)}`],
    );
    projectId = project.rows[0]?.id as string;
    const task = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
       values ($1, 'fake-jira', $2, 'https://jira.example.test/x', 'feature') returning id`,
      [projectId, `ACME-${Date.now()}`],
    );
    taskId = task.rows[0]?.id as string;
    const stage = await pool.query<{ id: string }>(
      `insert into task_stages (task_id, stage, attempt, state)
       values ($1, 'implementation', 1, 'running') returning id`,
      [taskId],
    );
    const run = await pool.query<{ id: string }>(
      `insert into runs (task_id, task_stage_id, project_id, role, mode, attempt, run_key, model,
                         effort, permission_mode, provider_mode, prompt_version, status, started_at)
       values ($1, $2, $3, 'developer', 'normal', 1, $4, 'claude-opus-5', 'medium', 'default',
               'api', 'v1', 'completed', now()) returning id`,
      [taskId, stage.rows[0]?.id, projectId, `run-${Date.now()}-${Math.random()}`],
    );
    runId = run.rows[0]?.id as string;
  });

  const runFinished = (usd: number): DomainEvent => {
    stream += 1;
    return domainEventSchemasByType['run.finished'].parse({
      id: crypto.randomUUID(),
      stream_type: 'run',
      stream_id: runId,
      stream_seq: stream,
      correlation_id: taskId,
      cause_event_id: null,
      actor: { kind: 'system', component: 'runner' },
      occurred_at: new Date().toISOString(),
      type: 'run.finished',
      payload: {
        project_id: projectId as Id,
        task_id: taskId as Id,
        run_id: runId as Id,
        status: 'completed',
        terminal_reason: 'success',
        usage: {
          input_tokens: 1200,
          output_tokens: 400,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        model_usage: [],
        cost: { usd, is_estimate: false, price_list_id: null },
        num_turns: 3,
        wall_ms: 9_000,
      },
    }) as DomainEvent;
  };

  const ledger = () =>
    costHandlers({
      store: cost.createPostgresCostStore(),
      context: (correlationId, causeEventId) => ({
        ids: { next: () => crypto.randomUUID() as Id },
        actor: { kind: 'system', component: 'cost-ledger' },
        clock: { now: () => new Date().toISOString() },
        correlationId,
        causeEventId,
      }),
    });

  /**
   * The ledger's totals **for this test's own run and project**.
   *
   * Scoped rather than global, and not by choice: `cost_entries` is append-only (migration 0007
   * registers it in `platform_table_policy`, and the application role has no DELETE), so a
   * `beforeEach` cannot clear it and a global sum would carry the previous case's rows.
   */
  const totals = async () => {
    const entries = await pool.query<{ total: string | null; rows: string }>(
      'select sum(usd) as total, count(*) as rows from cost_entries where run_id = $1',
      [runId],
    );
    const rollups = await pool.query<{ total: string | null; runs: string | null }>(
      'select sum(usd) as total, sum(runs) as runs from cost_rollup_daily where project_id = $1',
      [projectId],
    );
    return {
      entryTotal: Number(entries.rows[0]?.total ?? 0),
      entryRows: Number(entries.rows[0]?.rows ?? 0),
      rollupTotal: Number(rollups.rows[0]?.total ?? 0),
      rollupRuns: Number(rollups.rows[0]?.runs ?? 0),
    };
  };

  it('charges a run whose event was dispatched before the ledger existed', async () => {
    // ── (1) the world before this work package ──
    const sweeper = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    const [appended] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([runFinished(2.5)]),
    );
    const position = (appended as NonNullable<typeof appended>).position;
    const dispatched = await sweeper.dispatch(appended as NonNullable<typeof appended>);
    expect(dispatched.status).toBe('dispatched');

    // ── (2) nothing charged, and the queue row is gone: a re-dispatch is a no-op by design ──
    expect(await totals()).toMatchObject({ entryRows: 0 });
    expect(await store.countPendingDispatch()).toBe(0);
    const again = await sweeper.dispatch(appended as NonNullable<typeof appended>);
    expect(again.status).toBe('completed');

    // ── (3) the handler is registered afterwards and the log is replayed ──
    //
    // From this event's own position, because the database outlives the case: a pass over the
    // whole log would also scan the other case's event and report counts that depend on which
    // test ran first.
    const range = { handlers: ledger(), fromPosition: position - 1, toPosition: position };
    const report = await replayEvents({ store, unitOfWork }, range);
    expect(report).toMatchObject({ scanned: 1, applied: 1, skipped: 0, failures: [] });

    // ── (4) it is in the ledger and in the rollups, and they reconcile ──
    const after = await totals();
    expect(after.entryRows).toBe(1);
    expect(after.entryTotal).toBeCloseTo(2.5, 6);
    expect(after.rollupTotal).toBeCloseTo(after.entryTotal, 6);
    expect(after.rollupRuns).toBe(1);

    const usage = await pool.query<{ model: string; usd_reported: string | null }>(
      'select model, usd_reported from run_model_usage where run_id = $1',
      [runId],
    );
    expect(usage.rows).toEqual([{ model: 'claude-opus-5', usd_reported: '2.500000' }]);

    // A second pass changes nothing: `handler_executions` is a real row with a real primary key.
    const second = await replayEvents({ store, unitOfWork }, range);
    expect(second).toMatchObject({ scanned: 1, applied: 0, skipped: 1 });
    expect(await totals()).toEqual(after);
  });

  it('does not re-charge a run the dispatcher already gave the ledger', async () => {
    const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    for (const handler of ledger()) {
      bus.register(handler);
    }
    const [appended] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([runFinished(1.25)]),
    );
    const position = (appended as NonNullable<typeof appended>).position;
    await bus.dispatch(appended as NonNullable<typeof appended>);
    const charged = await totals();
    expect(charged.entryRows).toBe(1);

    const report = await replayEvents(
      { store, unitOfWork },
      { handlers: ledger(), fromPosition: position - 1, toPosition: position },
    );
    expect(report).toMatchObject({ scanned: 1, applied: 0, skipped: 1 });
    expect(await totals()).toEqual(charged);
  });
});
