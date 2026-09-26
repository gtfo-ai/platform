/**
 * The superseded-merge-request recovery's SQL against PostgreSQL 18 (WP-59 review round 1, PROGRESS
 * backlog 178, migration 0043).
 *
 * The unit tier drives the whole loop over the in-memory twin
 * (`packages/application/src/pipeline/human-commands.test.ts` › "recovers a close whose wake-up was
 * dropped, once, and settles it"); this tier holds the two halves that are SQL: the rework's insert and the duty's
 * settle through the real `PipelineStore`, and the recovery store's read and two writes — both
 * directions of the predicate (a row inside the grace and a settled row are **not** found) and the
 * `settled_at is null` guard on every write.
 */
import type { Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline, recovery as recoveryAdapters } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;

const recovery = recoveryAdapters.createPostgresSupersededMergeRequestStore();
const store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
const CAUSE = '00000000-0000-4000-9000-0000000000c1' as Id;
const SUPERSEDED_AT = '2026-09-15T09:00:00.000Z' as IsoDateTime;
const query = {
  olderThan: '2026-09-15T10:00:00.000Z' as IsoDateTime,
  endingBefore: '2026-09-15T09:30:00.000Z' as IsoDateTime,
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

const newTask = async (key: string): Promise<Id> => {
  const row = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode)
     values ($1, 'jira', $2, 'https://jira.example.test/browse/' || $2, 'feature', 'normal')
     returning id`,
    [projectId, key],
  );
  return row.rows[0]?.id as Id;
};

const supersede = async (taskId: Id, iid: number, at: IsoDateTime = SUPERSEDED_AT) =>
  withTx((tx) =>
    store.tasks.recordSupersededMergeRequest(tx, {
      taskId,
      projectId,
      mr: {
        provider: 'gitlab',
        project_path: 'acme/api',
        iid,
        url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
        branch: 'agentic/SUP-1',
        head_sha: 'b'.repeat(40),
      },
      newBranch: 'agentic/SUP-1-r2',
      causeEventId: CAUSE,
      supersededAt: at,
    }),
  );

const found = async (taskId: Id) =>
  (await withTx((tx) => recovery.strandedSupersededMergeRequests(tx, query))).filter(
    (row) => row.taskId === taskId,
  );

beforeAll(async () => {
  database = await createMigratedDatabase('superseded');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('superseded') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'sup', 'Superseded', 'https://git.example.test/acme/sup.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('superseded_merge_requests (migration 0043)', () => {
  it('finds an unsettled row past the grace with everything its wake-up needs, and not one inside it', async () => {
    const taskId = await newTask('SUP-1');
    await supersede(taskId, 7);
    expect(await found(taskId)).toEqual([
      {
        taskId,
        projectId,
        iid: 7,
        mrUrl: 'https://git.example.test/acme/api/-/merge_requests/7',
        mrProjectPath: 'acme/api',
        newBranch: 'agentic/SUP-1-r2',
        causeEventId: CAUSE,
        recoveryAttemptedAt: null,
      },
    ]);

    const young = await newTask('SUP-2');
    await supersede(young, 8, '2026-09-15T10:00:30.000Z' as IsoDateTime);
    expect(await found(young)).toEqual([]);
  });

  it('does not find a row its duty settled, and the first ending wins', async () => {
    const taskId = await newTask('SUP-3');
    await supersede(taskId, 9);
    const at = '2026-09-15T09:01:00.000Z' as IsoDateTime;
    await withTx((tx) =>
      store.tasks.settleSupersededMergeRequest(tx, { taskId, iid: 9, outcome: 'closed', at }),
    );
    await withTx((tx) =>
      store.tasks.settleSupersededMergeRequest(tx, { taskId, iid: 9, outcome: 'merged', at }),
    );
    expect(await found(taskId)).toEqual([]);
    const rows = await pool.query<{ outcome: string }>(
      'select outcome from superseded_merge_requests where task_id = $1',
      [taskId],
    );
    expect(rows.rows).toEqual([{ outcome: 'closed' }]);
    // The recovery's writes cannot touch a settled row either.
    await withTx((tx) =>
      recovery.endSupersededMergeRequest(tx, { taskId, iid: 9, reason: 'x', at }),
    );
    expect(
      (
        await pool.query<{ outcome: string }>(
          'select outcome from superseded_merge_requests where task_id = $1',
          [taskId],
        )
      ).rows,
    ).toEqual([{ outcome: 'closed' }]);
  });

  it('marks one attempt, finds it again only after the ending window, and abandons it', async () => {
    const taskId = await newTask('SUP-4');
    await supersede(taskId, 10);
    // Attempted recently: inside the ending window, so not found.
    await withTx((tx) =>
      recovery.markSupersededAttempt(tx, {
        taskId,
        iid: 10,
        at: '2026-09-15T09:45:00.000Z' as IsoDateTime,
      }),
    );
    expect(await found(taskId)).toEqual([]);
    // Attempted long enough ago: found, with its attempt.
    await pool.query(
      "update superseded_merge_requests set recovery_attempted_at = '2026-09-15T09:10:00Z' where task_id = $1",
      [taskId],
    );
    expect((await found(taskId)).map((row) => row.recoveryAttemptedAt)).toEqual([
      '2026-09-15T09:10:00.000Z',
    ]);
    await withTx((tx) =>
      recovery.endSupersededMergeRequest(tx, {
        taskId,
        iid: 10,
        reason: 'close it by hand',
        at: '2026-09-15T10:10:00.000Z' as IsoDateTime,
      }),
    );
    expect(await found(taskId)).toEqual([]);
    const rows = await pool.query<{ outcome: string; detail: string }>(
      'select outcome, detail from superseded_merge_requests where task_id = $1',
      [taskId],
    );
    expect(rows.rows).toEqual([{ outcome: 'abandoned', detail: 'close it by hand' }]);
  });

  it('makes a second supersession of one merge request unsettled again', async () => {
    const taskId = await newTask('SUP-5');
    await supersede(taskId, 11);
    await withTx((tx) =>
      store.tasks.settleSupersededMergeRequest(tx, {
        taskId,
        iid: 11,
        outcome: 'readopted',
        at: SUPERSEDED_AT,
      }),
    );
    expect(await found(taskId)).toEqual([]);
    await supersede(taskId, 11);
    expect((await found(taskId)).map((row) => row.iid)).toEqual([11]);
  });
});
