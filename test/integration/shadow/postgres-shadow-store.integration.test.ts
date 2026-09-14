/**
 * The `ShadowStore` contract against a real PostgreSQL 18, plus the two things only a database can
 * answer (WP-34).
 *
 * The shared suite (`test/contract/support/shadow-store-suite.ts`) runs against this adapter and
 * against the in-memory double, so the divergence register on `memory-shadow.ts` is checkable
 * rather than asserted.
 *
 * Two cases are **here and not in the suite**, because the double cannot express either:
 *
 *  - **migration 0029's check constraint.** `shadow_batch_tickets_task_or_refusal` refuses a row
 *    that is both a task and a refusal, or neither. Nothing in the platform writes one —
 *    `startShadowBatch` writes exactly one of the two on every path — so the constraint has no
 *    caller to catch, and this is where it is proved to exist at all (standing rule 3: an invariant
 *    asserted in a migration comment is not evidence it holds).
 *  - **`shadowSpendSince` over `cost_entries`.** It is the only query in the platform that groups
 *    spend by `tasks.mode`, and its whole value is that it *excludes* a normal task's rows — which
 *    a double that answers a seeded number cannot show.
 */
import type { Transaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { shadow as shadowAdapters } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runShadowStoreContract } from '../../contract/support/shadow-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: string;
let taskIds: [string, string];
let batches = 0;

beforeAll(async () => {
  database = await createMigratedDatabase('shadow');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('shadow') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'shadow', 'Shadow', 'https://git.example.test/acme/shadow.git')
     returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as string;
  const created: string[] = [];
  for (const key of ['SHA-1', 'SHA-2']) {
    const task = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
       values ($1, 'jira', $2, 'https://jira.example.test/browse/' || $2, 'feature', 'shadow')
       returning id`,
      [projectId, key],
    );
    created.push(task.rows[0]?.id as string);
  }
  taskIds = [created[0] as string, created[1] as string];
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

runShadowStoreContract({
  name: 'postgres',
  create: async () => {
    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    await client.query('begin');
    return {
      store: new shadowAdapters.PostgresShadowStore(),
      tx: { adapter: 'postgres', client } as unknown as Transaction,
      projectId: projectId as Id,
      taskIds: taskIds as unknown as readonly [Id, Id],
      nextBatchId: () => {
        batches += 1;
        return `00000000-0000-4000-8000-${batches.toString(16).padStart(12, '0')}` as Id;
      },
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});

describe('what only the database can answer', () => {
  it('refuses a ticket row that is both a task and a refusal, and one that is neither', async () => {
    const batchId = '00000000-0000-4000-8000-00000000c001';
    await pool.query('insert into shadow_batches (id, project_id) values ($1, $2)', [
      batchId,
      projectId,
    ]);
    const insert = (taskId: string | null, refused: string | null) =>
      pool.query(
        `insert into shadow_batch_tickets (batch_id, ticket_key, task_id, refused_reason)
         values ($1, $2, $3, $4)`,
        [batchId, `K-${taskId ?? 'x'}-${refused ?? 'x'}`, taskId, refused],
      );
    await expect(insert(taskIds[0], 'both')).rejects.toThrow(
      /shadow_batch_tickets_task_or_refusal/,
    );
    await expect(insert(null, null)).rejects.toThrow(/shadow_batch_tickets_task_or_refusal/);
    // …and both legal shapes are accepted, which is the half that makes the refusals mean something.
    await expect(insert(taskIds[0], null)).resolves.toBeDefined();
    await expect(insert(null, 'refused')).resolves.toBeDefined();
    await pool.query('delete from shadow_batches where id = $1', [batchId]);
  });

  it('sums only a shadow task’s ledger rows, and only since the instant asked for', async () => {
    const normal = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
       values ($1, 'jira', 'SHA-NORMAL', 'https://jira.example.test/browse/SHA-NORMAL', 'feature', 'normal')
       returning id`,
      [projectId],
    );
    const normalTask = normal.rows[0]?.id as string;
    const runFor = async (taskId: string): Promise<string> => {
      const run = await pool.query<{ id: string }>(
        `insert into runs (task_id, project_id, role, model, prompt_version)
         values ($1, $2, 'developer', 'claude-opus-5', 'developer@1') returning id`,
        [taskId, projectId],
      );
      return run.rows[0]?.id as string;
    };
    const entry = async (taskId: string, usd: number, at: string): Promise<void> => {
      await pool.query(
        `insert into cost_entries (run_id, task_id, project_id, stage, model, usd, created_at)
         values ($1, $2, $3, 'implementation', 'claude-opus-5', $4, $5)`,
        [await runFor(taskId), taskId, projectId, usd, at],
      );
    };
    /**
     * Every instant is a small offset from **now**, which the database insisted on: `cost_entries`
     * is monthly-partitioned and `assertInPartitionWindow` refuses a row outside the current and
     * previous month, so the forty-days-ago row this case was first written with failed on insert
     * with *"no partition of relation cost_entries found for row"*. Three days is far enough to be
     * outside a one-day window and near enough to land in a partition that exists.
     */
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const older = new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString();

    await entry(taskIds[0] as string, 3, recent);
    // Excluded because the task is `normal`: the cap is a statement about shadow runs.
    await entry(normalTask, 100, recent);
    // Excluded because it is before the window.
    await entry(taskIds[1] as string, 50, older);

    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    try {
      const store = new shadowAdapters.PostgresShadowStore();
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
      expect(await store.shadowSpendSince(tx, projectId as Id, since as never)).toBe(3);
      // The other direction: widen the window and the older shadow entry joins in — which is what
      // makes the figure above a *window* rather than a coincidence.
      const wide = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
      expect(await store.shadowSpendSince(tx, projectId as Id, wide as never)).toBe(53);
    } finally {
      await client.end();
    }
  });
});
