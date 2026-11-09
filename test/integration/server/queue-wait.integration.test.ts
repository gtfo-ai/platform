/**
 * **Why a queued task waits, against PostgreSQL 18** — `queue_wait` (S-25.16, BD-010).
 *
 * What only the database can show:
 *
 *  1. **The scheduler's counts**: over a set of fixtures, the read's verdict equals
 *     `evaluateTaskAdmission` over the store's own `TaskRepository.counts` (the SQL the scheduler
 *     runs), and its position equals the place in `orderQueue` over the store's `queued`.
 *  2. **Where it is carried**: the board's page answers it for every queued item (`null` for every
 *     other), the task read answers the same object.
 *  3. **The scheduler's limits**: read through the production settings port, so the
 *     organisation's lower bound applies to the wait exactly as it does to admission.
 */
import type { PipelineStore, Transaction } from '@platform/application';
import type { Id, QueueWait, TaskState } from '@platform/contracts';
import { evaluateTaskAdmission, orderQueue, SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectSettingsPort } from '../../../apps/server/src/pipeline.js';
import {
  type Database,
  findTaskDetail,
  listProjectTasks,
} from '../../../apps/server/src/queries/pipeline-queries.js';
import type { WipLimitsReader } from '../../../apps/server/src/queries/queue-wait.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: Database;
let store: PipelineStore;
let wipLimits: WipLimitsReader;
let counter = 0;

const one = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R> => (await pool.query<R>(text, values)).rows[0] as R;

/** One connection, one transaction, rolled back: the store's counts take an advisory xact lock. */
const inTransaction = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  try {
    return await work({ adapter: 'postgres', client } as unknown as Transaction);
  } finally {
    await client.query('rollback');
    await client.end();
  }
};

beforeAll(async () => {
  database = await createMigratedDatabase('queue-wait');
  pool = createTestPool(database.connectionString, { max: 4 });
  drizzled = drizzle(pool) as unknown as Database;
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  // The composition's reader (`app.ts`): the scheduler's settings port, its `wip`.
  const settings = createProjectSettingsPort(pool);
  wipLimits = async (projectId) => {
    const read = await settings.forProject(projectId as Id);
    return { limits: read.wip, bounded: (read.wipBounded ?? []).map((bound) => bound.key) };
  };
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/** A project in an organisation of its own, whose settings document is `orgSettings`. */
const project = async (orgSettings: unknown = {}): Promise<Id> => {
  counter += 1;
  const org = await one<{ id: string }>(
    'insert into organizations (name, settings) values ($1, $2::jsonb) returning id',
    [`queue-${counter}`, JSON.stringify(orgSettings)],
  );
  return (
    await one<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, 'Queue', 'https://git.example.test/acme/queue.git') returning id`,
      [org.id, `queue${counter}`],
    )
  ).id as Id;
};

/** A task in `state`, created `minute` minutes into the fixture day, with `priority`. */
const task = async (
  projectId: Id,
  key: string,
  state: TaskState,
  options: { readonly minute?: number; readonly priority?: string } = {},
): Promise<Id> =>
  (
    await one<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                          priority, created_at, current_stage, stage_attempts)
       values ($1, 'jira-cloud', $2, 'https://jira.example.test/browse/' || $2, 'feature', $3, $4,
               timestamptz '2026-11-06T09:00:00Z' + make_interval(mins => $5::int),
               $6::text, case when $6::text is null then '{}'::jsonb
                              else jsonb_build_object($6::text, 1) end)
       returning id`,
      [
        projectId,
        key,
        state,
        options.priority ?? null,
        options.minute ?? 0,
        // A queued task has entered no stage; every other is at the first one.
        state === 'queued' ? null : 'refinement',
      ],
    )
  ).id as Id;

const queueWaitOf = async (projectId: Id, taskId: Id): Promise<QueueWait | null | undefined> => {
  const page = await listProjectTasks(drizzled, projectId, { limit: 100 }, { wipLimits });
  return page?.items.find((item) => item.id === taskId)?.queue_wait;
};

describe('queue_wait (S-25.16)', () => {
  it('says the stopped tasks hold the pipeline, and the board and the task read agree', async () => {
    const projectId = await project();
    const stopped: Id[] = [];
    for (let n = 1; n <= 5; n += 1) {
      stopped.push(await task(projectId, `AUT-66${n}0`, 'needs_human', { minute: n }));
    }
    const first = await task(projectId, 'AUT-6861', 'queued', { minute: 10 });
    const second = await task(projectId, 'AUT-6862', 'queued', { minute: 20 });
    const done = await task(projectId, 'AUT-6000', 'done');

    const page = await listProjectTasks(drizzled, projectId, { limit: 100 }, { wipLimits });
    const byId = new Map(page?.items.map((item) => [item.id, item.queue_wait]));
    expect(byId.get(second)).toEqual({
      status: 'waiting',
      reason: 'max_tasks_in_pipeline',
      count: 5,
      limit: 5,
      organisation_bound: false,
      position: 2,
      queued: 2,
      running: { count: 0, limit: 2 },
      pipeline: { count: 5, limit: 5 },
      holders: {
        total: 5,
        needs_human: 5,
        items: stopped.map((id, index) => ({
          task_id: id,
          ticket_key: `AUT-66${index + 1}0`,
          state: 'needs_human',
        })),
      },
    });
    expect(byId.get(first)).toMatchObject({ status: 'waiting', position: 1 });
    // Every other state is `null`, never absent.
    for (const id of [...stopped, done]) {
      expect(byId.get(id), id).toBeNull();
    }
    // The task read answers the same object; with no reader asking, nothing is read.
    expect((await findTaskDetail(drizzled, second, { wipLimits }))?.queue_wait).toEqual(
      byId.get(second),
    );
    expect(
      (await findTaskDetail(drizzled, stopped[0] as Id, { wipLimits }))?.queue_wait,
    ).toBeNull();
    expect((await findTaskDetail(drizzled, second))?.queue_wait).toBeNull();
  });

  it.each<readonly [string, readonly TaskState[]]>([
    [
      'the Autix shape',
      ['needs_human', 'needs_human', 'needs_human', 'needs_human', 'needs_human'],
    ],
    ['two running', ['active', 'returned', 'waiting_answers']],
    ['room left', ['active', 'needs_human', 'paused']],
    [
      'finished tasks hold nothing',
      ['done', 'cancelled', 'done', 'cancelled', 'done', 'cancelled'],
    ],
    [
      'paused and waiting fill the pipeline',
      ['paused', 'waiting_answers', 'paused', 'needs_human', 'active'],
    ],
  ])('gives the scheduler’s verdict over the store’s own counts: %s', async (_name, states) => {
    const projectId = await project();
    for (const [index, state] of states.entries()) {
      await task(projectId, `PAR-${index}`, state, { minute: index });
    }
    // Two queued, the later one more urgent, so the order is the priority's and not the age's.
    const later = await task(projectId, 'PAR-Q1', 'queued', { minute: 50 });
    const urgent = await task(projectId, 'PAR-Q2', 'queued', { minute: 60, priority: 'Highest' });

    const [counts, queued] = await inTransaction(
      async (tx) =>
        [
          await store.tasks.counts(tx, projectId),
          orderQueue(await store.tasks.queued(tx, projectId)),
        ] as const,
    );
    const scheduler = evaluateTaskAdmission(counts, (await wipLimits(projectId)).limits);
    for (const id of [later, urgent]) {
      const wait = await queueWaitOf(projectId, id);
      expect(wait?.status === 'admitted', id).toBe(scheduler.admitted);
      if (wait?.status === 'waiting' && !scheduler.admitted) {
        expect(wait.reason).toBe(scheduler.reason);
        expect(wait.limit).toBe(scheduler.limit);
        expect(wait.count).toBe(
          scheduler.reason === 'max_parallel_tasks' ? counts.activeTasks : counts.tasksInPipeline,
        );
      }
      // Both limits, as the store counts them, whichever refused.
      expect(wait?.running.count).toBe(counts.activeTasks);
      expect(wait?.pipeline.count).toBe(counts.tasksInPipeline);
      expect(wait?.position).toBe(queued.findIndex((entry) => entry.id === id) + 1);
    }
    expect(queued.map((entry) => entry.id)).toEqual([urgent, later]);
  });

  it('applies the organisation’s lower bound, as admission does', async () => {
    const projectId = await project({ pipeline: { wip: { max_tasks_in_pipeline: 3 } } });
    for (let n = 0; n < 3; n += 1) {
      await task(projectId, `ORG-${n}`, 'needs_human', { minute: n });
    }
    const queued = await task(projectId, 'ORG-Q', 'queued', { minute: 9 });
    expect((await wipLimits(projectId)).limits.maxTasksInPipeline).toBe(3);
    expect(await queueWaitOf(projectId, queued)).toMatchObject({
      status: 'waiting',
      reason: 'max_tasks_in_pipeline',
      count: 3,
      limit: 3,
      // S-25.21: the organisation's 3 lowered BD-010's 5, so raising the project's changes nothing.
      organisation_bound: true,
      holders: { total: 3, needs_human: 3 },
    });
  });

  it('says the limit is the project’s own when the organisation’s maximum is not what binds', async () => {
    // The organisation allows 3 in the pipeline; the project states 2 itself, below it.
    const projectId = await project({ pipeline: { wip: { max_tasks_in_pipeline: 3 } } });
    await pool.query(`update projects set config = $2::jsonb where id = $1`, [
      projectId,
      JSON.stringify({ version: 1, pipeline: { wip: { max_tasks_in_pipeline: 2 } } }),
    ]);
    for (let n = 0; n < 2; n += 1) {
      await task(projectId, `OWN-${n}`, 'needs_human', { minute: n });
    }
    const queued = await task(projectId, 'OWN-Q', 'queued', { minute: 9 });
    expect(await queueWaitOf(projectId, queued)).toMatchObject({
      status: 'waiting',
      reason: 'max_tasks_in_pipeline',
      limit: 2,
      organisation_bound: false,
    });
  });
});
