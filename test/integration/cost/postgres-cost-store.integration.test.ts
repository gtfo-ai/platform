/**
 * The `CostStore` contract against a real PostgreSQL 18 (technical/10 integration tier).
 *
 * The same suite runs against the in-memory store in the contract tier; this is the half that
 * proves the interchange — the SQL, the `numeric(12,6)` round trip through `pg`'s string encoding,
 * the `distinct on` price window, the `on conflict` rollup arithmetic and the refusal the fake's
 * divergence register promises (an estimate for a task that does not exist).
 *
 * Each case runs inside one transaction that is rolled back afterwards, so they are isolated
 * without a database per case.
 */
import type { Transaction } from '@platform/application';
import { createBudgetGuard } from '@platform/application';
import type { IsoDateTime } from '@platform/contracts';
import { cost } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCostStoreContract } from '../../contract/support/cost-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient } from '../support/postgres.js';

let database: MigratedDatabase;
let projectId: string;
let orgId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('cost-store');
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('cost-store') returning id",
    );
    orgId = org.rows[0]?.id as string;
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [orgId],
    );
    projectId = project.rows[0]?.id as string;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

/** A minimal `RefinedSpec` document; only `size` is read, and the whole thing must still parse. */
const refinedSpec = (size: string) => ({
  goal: 'g',
  user_value: 'v',
  in_scope: [],
  out_of_scope: [],
  acceptance_criteria: [],
  non_functional: [],
  dependencies: [],
  size,
  drift: { flag: false, justification: '' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
});

runCostStoreContract({
  name: 'postgres',
  create: async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    let ticket = 0;
    return {
      store: cost.createPostgresCostStore(),
      tx,
      projectId: projectId as never,
      orgId: orgId as never,
      seed: {
        run: async (input) => {
          let stageId: string | null = null;
          if (input.stage !== null) {
            const stage = await client.query<{ id: string }>(
              `insert into task_stages (task_id, stage, attempt, state)
               values ($1, $2, 1, 'running') returning id`,
              [input.taskId, input.stage],
            );
            stageId = stage.rows[0]?.id as string;
          }
          await client.query(
            `insert into runs (id, task_id, task_stage_id, project_id, role, mode, attempt,
                               run_key, model, effort, permission_mode, provider_mode,
                               prompt_version, status, started_at)
             values ($1, $2, $3, $4, 'developer', 'normal', 1, $5, $6, 'medium', 'default',
                     'api', 'v1', 'completed', $7)`,
            [
              input.runId,
              input.taskId,
              stageId,
              projectId,
              `run-key-${input.runId}`,
              input.model,
              input.startedAt,
            ],
          );
        },
        price: async (input) => {
          await client.query(
            `insert into price_list (id, model_id, effective_from, effective_to, input, output,
                                     cache_write_5m, cache_write_1h, cache_read, source_url,
                                     verified_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'https://example.invalid/prices', now())`,
            [
              input.priceListId,
              input.modelId,
              input.effectiveFrom,
              input.effectiveTo ?? null,
              input.input,
              input.output,
              input.cacheWrite5m,
              input.cacheWrite1h,
              input.cacheRead,
            ],
          );
        },
        budget: async (input) => {
          await client.query(
            `insert into budgets (id, scope, scope_id, "window", limit_usd, notify_pct)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              input.id,
              input.scope,
              input.scopeId,
              input.window,
              input.limitUsd,
              input.notifyPct ?? [50, 80],
            ],
          );
        },
        task: async (input) => {
          ticket += 1;
          await client.query(
            `insert into tasks (id, project_id, ticket_provider, ticket_key, ticket_url, template,
                                size, cost_actual, completed_at, state)
             values ($1, $2, 'fake-jira', $3, 'https://jira.example.test/x', 'feature',
                     $4, $5, $6, 'queued')`,
            [
              input.id,
              projectId,
              `ACME-${ticket}`,
              input.size ?? null,
              input.costUsd ?? 0,
              input.finished === true ? new Date().toISOString() : null,
            ],
          );
        },
        refinedSize: async (taskId, size) => {
          await client.query(
            // `redaction_count` is named because migration 0038 gave the column no default and a
            // `NOT VALID` check: an insert that omits it is refused, which is the point.
            `insert into artifacts (task_id, type, version, data, schema_version, redaction_count)
             values ($1, 'RefinedSpec', 1, $2, 'v1', 0)`,
            [taskId, JSON.stringify(size === null ? { not: 'a refined spec' } : refinedSpec(size))],
          );
        },
        timezone: async (value) => {
          await client.query('update organizations set timezone = $1 where id = $2', [
            value,
            orgId,
          ]);
        },
        unmeasuredRun: async (input) => {
          // Terminal, both cost columns null, the reservation it was admitted at (migration 0072).
          await client.query(
            `insert into runs (task_id, project_id, role, model, prompt_version, status,
                               terminal_reason, started_at, ended_at, reserve_usd)
             values ($1, $2, 'developer', 'claude-opus-5', 'v1', 'failed', 'stalled',
                     $3::timestamptz, $3::timestamptz, $4)`,
            [input.taskId, projectId, input.endedAt, input.reserveUsd],
          );
        },
      },
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});

/**
 * **`pendingSpend`'s derivation**, which the shared suite deliberately does not assert: the
 * in-memory store holds no `runs` with a status or a reported figure, so its answer is seeded
 * (divergence 7) and only a database can produce this one.
 *
 * It is the query the budget guard adds to `budget_windows.spent_usd` because the ledger writes
 * from a handler that commits *after* the run's own transaction — measured on WP-40's tree, where a
 * delayed ledger handler let a batch admit two runs against a cap that allows one
 * (`packages/application/src/cost/pending.ts`). Four states of one window, in order: a **live** run
 * counts the caller's reservation, an **ended** one counts the figure its own transaction wrote, a
 * **charged** one counts nothing here because `cost_entries` has it, and a run that ended
 * **with nobody measuring it** is **held** at its reservation, apart from the pending sum — until
 * WP-131 it counted nothing at all, which was the over-admission PROGRESS backlog 402 names.
 */
describe('what a budget window counts before the ledger has written it', () => {
  const ORG = { scope: 'org' as const, scopeId: null };

  it('values a live run at the reservation and an ended one at what it reported', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    try {
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = cost.createPostgresCostStore();
      const since = new Date(Date.now() - 60 * 60_000).toISOString() as never;
      const project = { scope: 'project' as const, scopeId: projectId as never };
      /** The pending sum alone — the hold is asserted by name where it appears. */
      const pendingOf = async (scope: typeof project | typeof ORG): Promise<number> =>
        (await store.pendingSpend(tx, scope, since, 3)).pendingUsd;

      const task = await client.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
         values ($1, 'fake-jira', 'PENDING-1', 'https://jira.example.test/x', 'feature', 'normal')
         returning id`,
        [projectId],
      );
      const taskId = task.rows[0]?.id as string;
      const insertRun = async (
        status: string,
        usdReported: string | null,
        endedAt: string | null,
        /** The platform's own pricing of the run — `runs.usd_estimated`, WP-47. */
        usdEstimated: string | null = null,
      ): Promise<string> => {
        const created = await client.query<{ id: string }>(
          `insert into runs (task_id, project_id, role, model, prompt_version, status,
                             usd_reported, usd_estimated, ended_at)
           values ($1, $2, 'developer', 'claude-sonnet-5', 'v1', $3::run_status, $4, $6, $5)
           returning id`,
          [taskId, projectId, status, usdReported, endedAt, usdEstimated],
        );
        return created.rows[0]?.id as string;
      };

      // Nothing at all: a window with no runs has committed nothing, which is the one place a zero
      // is a measurement rather than an invention (standing rule 16's other side).
      expect(await pendingOf(project)).toBe(0);

      await insertRun('running', null, null);
      expect(await pendingOf(project)).toBe(3);
      // The organisation scope has no `scope_id` (migration 0007: *"exactly one subject"*), so its
      // fragment is every run of the deployment — a different branch, and the same answer here.
      expect(await pendingOf(ORG)).toBe(3);

      const ended = await insertRun('completed', '0.400000', new Date().toISOString());
      expect(await pendingOf(project)).toBe(3.4);

      await client.query(
        `insert into cost_entries (run_id, task_id, project_id, stage, model, usd)
         values ($1, $2, $3, 'implementation', 'claude-sonnet-5', 0.4)`,
        [ended, taskId, projectId],
      );
      expect(await pendingOf(project)).toBe(3);

      /**
       * **The platform's own figure counts too** — WP-47, PROGRESS backlog **110**.
       *
       * `RunRepository.finish` writes `usd_estimated` when the cost is an estimate, which under
       * BD-004 `local` mode is **every** run, so the valuation is
       * `coalesce(usd_reported, usd_estimated, 0)` rather than `coalesce(usd_reported, 0)`. This
       * case is what holds that: with the older fragment it reads 3 and with this one it reads
       * 3.25, so reverting the `coalesce` fails here rather than passing silently — which is
       * exactly what it did before this case existed. The paragraph that used to sit here called
       * such a run's contribution "nothing" and was true when it was written.
       */
      await insertRun('completed', null, new Date().toISOString(), '0.250000');
      expect(await pendingOf(project)).toBe(3.25);

      // **Neither** column set — what the lease sweep, a cancel ended in place and a stop or a crash
      // that read no `result` leave behind: "nobody measured this run", never "it was free"
      // (standing rule 16). It adds nothing to the pending sum and is **held** apart, at the
      // caller's 3 because this row recorded no reservation (WP-131). The ledger writes no row.
      await insertRun('failed', null, new Date().toISOString());
      expect(await pendingOf(project)).toBe(3.25);
      expect(await store.pendingSpend(tx, project, since, 3)).toEqual({
        pendingUsd: 3.25,
        heldUsd: 3,
        heldRuns: 1,
      });

      // …and a run that ended **before** the window opened is not this window's business.
      await insertRun(
        'completed',
        '9.000000',
        new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      );
      expect(await pendingOf(project)).toBe(3.25);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});

/**
 * **WP-131 criterion (4)** — the hold of PROGRESS backlog 402, on the project cap, against the real
 * SQL: the guard the stage executor asks (`createBudgetGuard`) over the adapter that derives the
 * hold from `runs`, with nothing seeded but rows.
 *
 * A project budget of 20 for the month, 5 already charged, and one run that ended **with nobody
 * measuring it**, admitted at 15. The guard refuses a 10 USD admission: `5 + 15 + 10 > 20` (since
 * the pre-review round the admission's own reservation counts, backlog 406 — the 5 charged is kept
 * so the window is not empty). Restoring the old valuation (`0` for that run) reads `5 + 10 <= 20`
 * and admits it: the canary.
 *
 * Then the two edges the ruling names: a row written before migration 0072 (`reserve_usd` null) is
 * held at the **admitting** reserve, and a hold counts in the window that contains its `ended_at`
 * and ages out with it — the same runs, asked about the next month, hold nothing.
 *
 * And the exclusion the ruling allows, answered: there is none. The one row this build writes for a
 * run no process ran (`recordUnstarted`) already carries a measured `usd_reported = 0`, so it is
 * not in the held set at all — asserted here, because it is the row an exclusion would have been for.
 */
describe('a run nobody measured is held at its reservation (WP-131)', () => {
  it('refuses a 10 USD admission to a project budget of 20 holding one unmeasured 15 USD run, holds a pre-0072 row at the admitting reserve, and drops the hold when its month rolls over', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    try {
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = cost.createPostgresCostStore();
      const guard = createBudgetGuard({ store });
      const JUNE = '2026-06-01T00:00:00.000Z' as IsoDateTime;
      const IN_JUNE = '2026-06-15T12:00:00.000Z' as IsoDateTime;
      const IN_JULY = '2026-07-02T12:00:00.000Z' as IsoDateTime;
      // The organisation's zone decides the window; UTC so the month starts where the case says.
      await client.query('update organizations set timezone = $1 where id = $2', ['UTC', orgId]);

      const task = await client.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
         values ($1, 'fake-jira', 'HELD-1', 'https://jira.example.test/x', 'feature', 'normal')
         returning id`,
        [projectId],
      );
      const taskId = task.rows[0]?.id as string;
      const budget = await client.query<{ id: string }>(
        `insert into budgets (scope, scope_id, "window", limit_usd)
         values ('project', $1, 'month', 20) returning id`,
        [projectId],
      );
      await client.query(
        `insert into budget_windows (budget_id, window_start, spent_usd) values ($1, $2, 5)`,
        [budget.rows[0]?.id, JUNE],
      );
      const endedRun = async (
        reserveUsd: number | null,
        usdReported: number | null = null,
      ): Promise<string> => {
        const created = await client.query<{ id: string }>(
          `insert into runs (task_id, project_id, role, model, prompt_version, status,
                             terminal_reason, started_at, ended_at, reserve_usd, usd_reported)
           values ($1, $2, 'developer', 'claude-opus-5', 'v1', 'timed_out', 'timed_out',
                   '2026-06-10T08:00:00Z', '2026-06-10T09:00:00Z', $3, $4)
           returning id`,
          [taskId, projectId, reserveUsd, usdReported],
        );
        return created.rows[0]?.id as string;
      };

      // Nothing ended unmeasured yet: 5 of 20, and the 10 USD run is admitted.
      expect(await guard.blockingFor(tx, projectId as never, IN_JUNE, 10)).toBeNull();

      const held = await endedRun(15);
      const refused = await guard.blockingFor(tx, projectId as never, IN_JUNE, 10);
      expect(refused).toMatchObject({
        scope: 'project',
        limitUsd: 20,
        spentUsd: 5,
        pendingUsd: 0,
        heldUsd: 15,
        heldRuns: 1,
      });

      // The canary, as data: the same row given the pre-WP-131 valuation — a figure of 0 on the
      // row, which is what "counts 0" meant — and the window reads 5 of 20 again and admits it.
      await client.query('update runs set usd_reported = 0 where id = $1', [held]);
      expect(await guard.blockingFor(tx, projectId as never, IN_JUNE, 10)).toBeNull();
      await client.query('update runs set usd_reported = null where id = $1', [held]);

      // A row written before migration 0072 recorded no reservation: held at the admitting one.
      await endedRun(null);
      expect(
        await store.pendingSpend(tx, { scope: 'project', scopeId: projectId as never }, JUNE, 10),
      ).toEqual({
        pendingUsd: 0,
        heldUsd: 25,
        heldRuns: 2,
      });

      // No exclusion: a run no process ran is written with a measured 0 and is not held.
      await endedRun(15, 0);
      expect(
        (await store.pendingSpend(tx, { scope: 'project', scopeId: projectId as never }, JUNE, 10))
          .heldRuns,
      ).toBe(2);

      // Backlog 407: a `cost_unreported` stop's row carries the floor `usd_reported = 0` with
      // `figure_is_floor` set — held at its reservation, not read as a measured zero.
      const floor = await endedRun(15, 0);
      await client.query('update runs set figure_is_floor = true where id = $1', [floor]);
      expect(
        await store.pendingSpend(tx, { scope: 'project', scopeId: projectId as never }, JUNE, 10),
      ).toEqual({ pendingUsd: 0, heldUsd: 40, heldRuns: 3 });

      // The rollover: in July the June window and the holds in it are gone, and the run is admitted.
      expect(
        await store.pendingSpend(
          tx,
          { scope: 'project', scopeId: projectId as never },
          '2026-07-01T00:00:00.000Z' as IsoDateTime,
          10,
        ),
      ).toEqual({ pendingUsd: 0, heldUsd: 0, heldRuns: 0 });
      expect(await guard.blockingFor(tx, projectId as never, IN_JULY, 10)).toBeNull();
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
