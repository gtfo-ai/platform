/**
 * The `StatsStore` contract against a real PostgreSQL 18 (technical/10 integration tier, WP-41).
 *
 * The same suite runs against the in-memory store in the contract tier; this is the half that
 * proves the interchange — the two upserts, the `numeric(18,6)`/`bigint` round trip through `pg`'s
 * string encoding (where a forgotten conversion concatenates instead of adding), and migration
 * 0034's tables actually existing with the keys the statements name.
 *
 * Each case runs inside one transaction that is rolled back afterwards, so they are isolated
 * without a database per case.
 */
import type { Transaction } from '@platform/application';
import { stats } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { runStatsStoreContract } from '../../contract/support/stats-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;
let orgId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('stats-store');
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('stats') returning id",
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

runStatsStoreContract({
  name: 'postgres',
  create: async () => {
    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    let ticket = 0;
    return {
      store: stats.createPostgresStatsStore(),
      tx,
      projectId: projectId as never,
      seed: {
        task: async (input) => {
          ticket += 1;
          await client.query(
            `insert into tasks (id, project_id, ticket_provider, ticket_key, ticket_url, template,
                                mr_ref, state)
             values ($1, $2, 'fake-jira', $3, 'https://jira.example.test/x', 'feature', $4, 'queued')`,
            [
              input.id,
              projectId,
              `ACME-${ticket}`,
              input.mrIid === undefined
                ? null
                : JSON.stringify({
                    provider: 'gitlab',
                    project_path: 'acme/api',
                    iid: input.mrIid,
                    url: `https://git.example.test/acme/api/-/merge_requests/${input.mrIid}`,
                  }),
            ],
          );
        },
        timezone: async (value) => {
          await client.query('update organizations set timezone = $1 where id = $2', [
            value ?? 'UTC',
            orgId,
          ]);
        },
      },
      read: {
        deliveries: async () => {
          const { rows } = await client.query<{ task_id: string; merged_at: Date }>(
            'select task_id, merged_at from stats_task_delivery order by merged_at',
          );
          return rows.map((row) => ({
            taskId: row.task_id as never,
            mergedAt: new Date(row.merged_at).toISOString() as never,
          }));
        },
        counters: async () => {
          const { rows } = await client.query<{
            day: Date | string;
            metric: string;
            count: string;
            total: string;
          }>(
            `select to_char(day, 'YYYY-MM-DD') as day, metric, count, total
               from stats_event_daily order by day, metric`,
          );
          return rows.map((row) => ({
            day: String(row.day),
            metric: row.metric,
            // `bigint` and `numeric` both arrive as strings; converting here rather than in the
            // assertion is what makes the suite's `13` a claim about the adapter's arithmetic.
            count: Number(row.count),
            total: Number(row.total),
          }));
        },
      },
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});
