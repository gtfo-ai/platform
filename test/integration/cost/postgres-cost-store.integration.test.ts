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
import { afterAll, beforeAll } from 'vitest';
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
