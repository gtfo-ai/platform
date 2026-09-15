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
import { cost } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCostStoreContract } from '../../contract/support/cost-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;
let orgId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('cost-store');
  const client = new pg.Client({ connectionString: database.connectionString });
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
    const client = new pg.Client({ connectionString: database.connectionString });
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
            `insert into artifacts (task_id, type, version, data, schema_version)
             values ($1, 'RefinedSpec', 1, $2, 'v1')`,
            [taskId, JSON.stringify(size === null ? { not: 'a refined spec' } : refinedSpec(size))],
          );
        },
        timezone: async (value) => {
          await client.query('update organizations set timezone = $1 where id = $2', [
            value,
            orgId,
          ]);
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
 * **reporting nothing** counts nothing at all — the residual that module states.
 */
describe('what a budget window counts before the ledger has written it', () => {
  const ORG = { scope: 'org' as const, scopeId: null };

  it('values a live run at the reservation and an ended one at what it reported', async () => {
    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    await client.query('begin');
    try {
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = cost.createPostgresCostStore();
      const since = new Date(Date.now() - 60 * 60_000).toISOString() as never;
      const project = { scope: 'project' as const, scopeId: projectId as never };

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
      ): Promise<string> => {
        const created = await client.query<{ id: string }>(
          `insert into runs (task_id, project_id, role, model, prompt_version, status,
                             usd_reported, ended_at)
           values ($1, $2, 'developer', 'claude-sonnet-5', 'v1', $3::run_status, $4, $5)
           returning id`,
          [taskId, projectId, status, usdReported, endedAt],
        );
        return created.rows[0]?.id as string;
      };

      // Nothing at all: a window with no runs has committed nothing, which is the one place a zero
      // is a measurement rather than an invention (standing rule 16's other side).
      expect(await store.pendingSpend(tx, project, since, 3)).toBe(0);

      await insertRun('running', null, null);
      expect(await store.pendingSpend(tx, project, since, 3)).toBe(3);
      // The organisation scope has no `scope_id` (migration 0007: *"exactly one subject"*), so its
      // fragment is every run of the deployment — a different branch, and the same answer here.
      expect(await store.pendingSpend(tx, ORG, since, 3)).toBe(3);

      const ended = await insertRun('completed', '0.400000', new Date().toISOString());
      expect(await store.pendingSpend(tx, project, since, 3)).toBe(3.4);

      await client.query(
        `insert into cost_entries (run_id, task_id, project_id, stage, model, usd)
         values ($1, $2, $3, 'implementation', 'claude-sonnet-5', 0.4)`,
        [ended, taskId, projectId],
      );
      expect(await store.pendingSpend(tx, project, since, 3)).toBe(3);

      // The residual, asserted rather than described: a run that ended reporting nothing (a local
      // run the ledger will price, or a failure that carried no cost) commits nothing here.
      await insertRun('failed', null, new Date().toISOString());
      expect(await store.pendingSpend(tx, project, since, 3)).toBe(3);

      // …and a run that ended **before** the window opened is not this window's business.
      await insertRun(
        'completed',
        '9.000000',
        new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      );
      expect(await store.pendingSpend(tx, project, since, 3)).toBe(3);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
