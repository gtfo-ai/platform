/**
 * The `HistoryBootstrapStore` contract against a real PostgreSQL 18, plus the three things only a
 * database can answer (WP-35).
 *
 * The shared suite (`test/contract/support/history-bootstrap-store-suite.ts`) runs against this
 * adapter and against the in-memory double, so the divergence register on `memory-bootstrap.ts` is
 * checkable rather than asserted.
 *
 * Three cases are **here and not in the suite**, because the double cannot express any of them:
 *
 *  - **migration 0030's partial unique index.** `history_bootstrap_batches_one_live` is what decides
 *    a race between two start commands; the command's own `liveBatch` read is what turns the loser
 *    into a named refusal, and this is where the index is proved to exist at all (standing rule 3:
 *    an invariant asserted in a migration comment is not evidence it holds). **The race itself is
 *    here too** (WP-35 review round 2): two `startHistoryBootstrap` calls that both read before
 *    either inserts, which is the only tier where two transactions exist at once.
 *  - **the counters' check constraint.** `history_bootstrap_chunks_counts_need_a_report` refuses a
 *    chunk that claims proposals before it has reported, which is what keeps `proposals = 0`
 *    unambiguous on the batch screen.
 *  - **`spendOfBatch` over `cost_entries`.** Its whole value is that it joins the ledger through
 *    the batch's own chunks and *excludes* another task's rows — which a double that answers a
 *    seeded number cannot show.
 */
import type { HistoryBootstrapStore, Jobs, Transaction } from '@platform/application';
import {
  defaultProjectSettings,
  JOB_QUEUES,
  startHistoryBootstrap,
  staticProjectSettings,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { bootstrap as bootstrapAdapters, eventing } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHistoryBootstrapStoreContract } from '../../contract/support/history-bootstrap-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: string;
let taskIds: [string, string];
let ids = 0;

const nextId = (): Id => {
  ids += 1;
  return `00000000-0000-4000-8000-${ids.toString(16).padStart(12, '0')}` as Id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('bootstrap');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('bootstrap') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'bootstrap', 'Bootstrap', 'https://git.example.test/acme/bootstrap.git')
     returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as string;
  const created: string[] = [];
  for (const index of [0, 1]) {
    const task = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
       values ($1, 'platform', $2, 'https://app.example.test/projects/x', 'history_bootstrap', 'normal')
       returning id`,
      [projectId, `history-bootstrap-seed-${index}`],
    );
    created.push(task.rows[0]?.id as string);
  }
  taskIds = [created[0] as string, created[1] as string];
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

runHistoryBootstrapStoreContract({
  name: 'postgres',
  create: async () => {
    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    await client.query('begin');
    return {
      store: new bootstrapAdapters.PostgresHistoryBootstrapStore(),
      tx: { adapter: 'postgres', client } as unknown as Transaction,
      projectId: projectId as Id,
      taskIds: taskIds as unknown as readonly [Id, Id],
      nextId,
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});

describe('what only the database can answer', () => {
  it('admits one live batch per project, and a second once the first has finished', async () => {
    const first = nextId();
    const second = nextId();
    const insert = (id: string) =>
      pool.query(
        `insert into history_bootstrap_batches
           (id, project_id, merge_requests, batch_size, days, cap_usd, estimated_usd)
         values ($1, $2, 40, 20, 183, 20, 4)`,
        [id, projectId],
      );
    await expect(insert(first)).resolves.toBeDefined();
    await expect(insert(second)).rejects.toThrow(/history_bootstrap_batches_one_live/);

    // …and the other direction, which is what makes the index a rule rather than a ban: once the
    // first has finished, a second bootstrap may start.
    await pool.query(
      "update history_bootstrap_batches set status = 'completed', completed_at = now() where id = $1",
      [first],
    );
    await expect(insert(second)).resolves.toBeDefined();
    await pool.query('delete from history_bootstrap_batches where id = any($1::uuid[])', [
      [first, second],
    ]);
  });

  it('answers the loser of a genuine race already_running, not a constraint violation', async () => {
    /**
     * The one case `liveBatch` cannot decide: **both** commands read no live batch before either
     * inserts. The read is instrumented with a barrier rather than hoped for — two `Promise.all`
     * calls would usually serialise, and a test that passed because the second read saw the first
     * row would be asserting the read path while claiming the write's (standing rule 10).
     *
     * What it proves is the whole chain: the index raises `23505`, the adapter translates it into
     * `LiveHistoryBootstrapError`, and the command answers the same `already_running` its read
     * gives. Before the translation the loser threw an unmapped driver error, which the route turns
     * into a 500.
     */
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const store = new bootstrapAdapters.PostgresHistoryBootstrapStore();
    let release = (): void => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = 0;
    const raced: HistoryBootstrapStore = Object.assign(
      Object.create(store) as HistoryBootstrapStore,
      {
        liveBatch: async (tx: Transaction, id: Id) => {
          const row = await store.liveBatch(tx, id);
          arrived += 1;
          if (arrived === 2) {
            release();
          }
          await bothRead;
          return row;
        },
      },
    );
    const enqueued: string[] = [];
    const jobs = {
      enqueue: async (request: { queue: string }) => {
        enqueued.push(request.queue);
        return { id: 'job', status: 'created' as const };
      },
    } as unknown as Jobs;
    const settings = defaultProjectSettings(projectId as Id, {
      config: { features: { history_bootstrap: { enabled: true } } },
    });
    const start = () =>
      startHistoryBootstrap(
        {
          unitOfWork,
          store: raced,
          settings: staticProjectSettings(() => settings),
          jobs,
          ids: { next: nextId },
          clock: { now: () => new Date().toISOString() as IsoDateTime },
          hasGitBinding: async () => true,
        },
        { projectId: projectId as Id, mergeRequests: 40, requestedByUserId: null },
      );

    const [first, second] = await Promise.all([start(), start()]);
    const outcomes = [first, second].map((result) =>
      result.status === 'started' ? 'started' : result.blocker,
    );
    expect(outcomes.toSorted()).toEqual(['already_running', 'started']);

    // The countable effects: one row, and one collection woken — the loser's transaction rolled
    // back and it enqueued nothing.
    const rows = await pool.query<{ count: string }>(
      'select count(*)::text as count from history_bootstrap_batches where project_id = $1',
      [projectId],
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
    expect(enqueued).toEqual([JOB_QUEUES.historyBootstrap]);
    await pool.query('delete from history_bootstrap_batches where project_id = $1', [projectId]);
  });

  it('refuses a chunk that claims proposals before it has reported', async () => {
    const batchId = nextId();
    await pool.query(
      `insert into history_bootstrap_batches
         (id, project_id, merge_requests, batch_size, days, cap_usd, estimated_usd)
       values ($1, $2, 40, 20, 183, 20, 4)`,
      [batchId, projectId],
    );
    const insert = (recordedAt: string | null, proposals: number) =>
      pool.query(
        `insert into history_bootstrap_chunks
           (id, batch_id, chunk_index, task_id, merge_requests, tickets, commits,
            recorded_at, proposals)
         values ($1, $2, $3, $4, 20, 5, 20, $5, $6)`,
        [nextId(), batchId, proposals, taskIds[0], recordedAt, proposals],
      );
    await expect(insert(null, 3)).rejects.toThrow(/history_bootstrap_chunks_counts_need_a_report/);
    // Both legal shapes are accepted, which is what makes the refusal mean something.
    await expect(insert(null, 0)).resolves.toBeDefined();
    await expect(insert(new Date().toISOString(), 2)).resolves.toBeDefined();
    await pool.query('delete from history_bootstrap_batches where id = $1', [batchId]);
  });

  /**
   * **The pending term, derived rather than seeded** — the half the in-memory double cannot answer
   * (its divergence 4) and the one the WP-40 measurement is about: the ledger is a handler that
   * commits after the run's own transaction, so a cap read from `cost_entries` alone admits a run
   * per dispatcher lag (`packages/application/src/cost/pending.ts`).
   *
   * Three states of one batch, in order, against a real database: a run that is **live** counts the
   * reservation, a run that has **ended** counts the figure its own transaction wrote, and a run
   * the ledger has **charged** counts its entries and nothing more — which is what makes the term
   * self-clearing rather than a second total to keep true.
   */
  it('values a batch’s runs the ledger has not recorded, and stops once it has', async () => {
    const batchId = nextId();
    await pool.query(
      `insert into history_bootstrap_batches
         (id, project_id, merge_requests, batch_size, days, cap_usd, estimated_usd)
       values ($1, $2, 40, 20, 183, 20, 4)`,
      [batchId, projectId],
    );
    await pool.query(
      `insert into history_bootstrap_chunks
         (id, batch_id, chunk_index, task_id, merge_requests, tickets, commits)
       values ($1, $2, 0, $3, 20, 5, 20)`,
      [nextId(), batchId, taskIds[1]],
    );
    const insertRun = async (
      status: string,
      usdReported: string | null,
      endedAt: string | null,
    ): Promise<string> => {
      const created = await pool.query<{ id: string }>(
        `insert into runs (task_id, project_id, role, model, prompt_version, status,
                           usd_reported, ended_at)
         values ($1, $2, 'developer', 'claude-sonnet-5', 'historian@1', $3::run_status, $4, $5)
         returning id`,
        [taskIds[1], projectId, status, usdReported, endedAt],
      );
      return created.rows[0]?.id as string;
    };

    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    try {
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = new bootstrapAdapters.PostgresHistoryBootstrapStore();

      await insertRun('running', null, null);
      expect(await store.capForTask(tx, taskIds[1] as Id, 2)).toEqual({
        capUsd: 20,
        spentUsd: 0,
        pendingUsd: 2,
      });

      const ended = await insertRun('completed', '0.400000', new Date().toISOString());
      expect(await store.capForTask(tx, taskIds[1] as Id, 2)).toEqual({
        capUsd: 20,
        spentUsd: 0,
        pendingUsd: 2.4,
      });

      await pool.query(
        `insert into cost_entries (run_id, task_id, project_id, stage, model, usd)
         values ($1, $2, $3, 'history_mining', 'claude-sonnet-5', 0.4)`,
        [ended, taskIds[1], projectId],
      );
      expect(await store.capForTask(tx, taskIds[1] as Id, 2)).toEqual({
        capUsd: 20,
        spentUsd: 0.4,
        pendingUsd: 2,
      });
    } finally {
      await client.end();
    }
    // The entries first: `cost_entries.run_id` references `runs`, so the other order is a foreign
    // key violation rather than a cleanup. The second task is used throughout so nothing this test
    // leaves behind can reach the batch the next one builds on the first.
    await pool.query('delete from history_bootstrap_batches where id = $1', [batchId]);
    await pool.query('delete from cost_entries where task_id = $1', [taskIds[1]]);
    await pool.query('delete from runs where task_id = $1', [taskIds[1]]);
  });

  it('sums only this batch’s tasks from the ledger', async () => {
    const other = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
       values ($1, 'jira', 'BOOT-OTHER', 'https://jira.example.test/browse/BOOT-OTHER', 'feature', 'normal')
       returning id`,
      [projectId],
    );
    const otherTask = other.rows[0]?.id as string;
    const runFor = async (taskId: string): Promise<string> => {
      const run = await pool.query<{ id: string }>(
        `insert into runs (task_id, project_id, role, model, prompt_version)
         values ($1, $2, 'developer', 'claude-sonnet-5', 'historian@1') returning id`,
        [taskId, projectId],
      );
      return run.rows[0]?.id as string;
    };
    const entry = async (taskId: string, usd: number): Promise<void> => {
      await pool.query(
        `insert into cost_entries (run_id, task_id, project_id, stage, model, usd)
         values ($1, $2, $3, 'history_mining', 'claude-sonnet-5', $4)`,
        [await runFor(taskId), taskId, projectId, usd],
      );
    };

    const batchId = nextId();
    await pool.query(
      `insert into history_bootstrap_batches
         (id, project_id, merge_requests, batch_size, days, cap_usd, estimated_usd)
       values ($1, $2, 40, 20, 183, 20, 4)`,
      [batchId, projectId],
    );
    await pool.query(
      `insert into history_bootstrap_chunks
         (id, batch_id, chunk_index, task_id, merge_requests, tickets, commits)
       values ($1, $2, 0, $3, 20, 5, 20)`,
      [nextId(), batchId, taskIds[0]],
    );
    await entry(taskIds[0] as string, 1.25);
    // Another task's spend, on the same project, which must not be counted.
    await entry(otherTask, 9);

    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    try {
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const store = new bootstrapAdapters.PostgresHistoryBootstrapStore();
      expect(await store.spendOfBatch(tx, batchId)).toBe(1.25);
      // …and `capForTask` answers the same number beside the cap, which is what admission compares.
      expect(await store.capForTask(tx, taskIds[0] as Id, 2)).toEqual({
        capUsd: 20,
        spentUsd: 1.25,
        pendingUsd: 0,
      });
    } finally {
      await client.end();
    }
    await pool.query('delete from history_bootstrap_batches where id = $1', [batchId]);
  });
});
