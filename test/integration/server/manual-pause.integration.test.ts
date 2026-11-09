/**
 * **Who paused a task by hand, when and why, against PostgreSQL 18** — `manual_pause` (S-25.20).
 *
 * The rows are written the way the platform writes them: the `task.paused` event in the command's
 * transaction, then the command's `human_actions` row (`routes/commands.ts` records it after the
 * command performed). What only the database can show:
 *
 *  1. the pause is the newest `task.pause` / `run.cancel` row **at or after** the newest
 *     `task.paused` event — an older row is an earlier pause the task has left;
 *  2. who did it is the row's user, with their name; a *Cancel run* is said as one; a reason is the
 *     row's own (already redacted) words, cut at the bound;
 *  3. the read answers `null`, and reads nothing, for a task not paused by hand;
 *  4. (S-25.23) a run cancel's row carries the platform's own reason, which the read serves, and a
 *     refused command's ticket key is the task row's own (`findTaskTicketKey`).
 */
import { MAX_TASK_PAUSE_REASON_CHARS, RUN_CANCEL_PAUSE_REASON } from '@platform/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Database,
  findTaskDetail,
  findTaskTicketKey,
  manualPauseFor,
} from '../../../apps/server/src/queries/pipeline-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: Database;
let projectId = '';
let userId = '';
let otherId = '';
let counter = 0;

const one = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R> => (await pool.query<R>(text, values)).rows[0] as R;

const pausedTask = async (): Promise<string> => {
  counter += 1;
  const row = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state)
     values ($1, 'fake-jira', $2, 'https://tickets.example.test/browse/' || $2, 'feature',
             'normal', 'paused') returning id`,
    [projectId, `MP-${counter}`],
  );
  return row.id;
};

const pausedEvent = async (taskId: string, seq: number, minutesAgo: number): Promise<void> => {
  await pool.query(
    `insert into events (stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
     values ('task', $1, $2, 'task.paused', '{"reason":"manual"}'::jsonb, $3::jsonb,
             now() - make_interval(mins => $4))`,
    [taskId, seq, JSON.stringify({ kind: 'user', user_id: userId }), minutesAgo],
  );
};

const action = async (
  taskId: string,
  name: string,
  params: Record<string, unknown>,
  minutesAgo: number,
  by: string = userId,
): Promise<void> => {
  await pool.query(
    `insert into human_actions (task_id, user_id, action, params, created_at)
     values ($1, $2, $3, $4::jsonb, now() - make_interval(mins => $5))`,
    [taskId, by, name, JSON.stringify(params), minutesAgo],
  );
};

beforeAll(async () => {
  database = await createMigratedDatabase('manual-pause');
  pool = createTestPool(database.connectionString, { max: 4 });
  drizzled = drizzle(pool) as unknown as Database;
  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('manual-pause') returning id",
  );
  projectId = (
    await one<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'mp', 'Manual pause', 'https://git.example.test/acme/mp.git') returning id`,
      [org.id],
    )
  ).id;
  userId = (
    await one<{ id: string }>(
      "insert into users (email, name) values ('pauser@example.test', 'Pat Pauser') returning id",
    )
  ).id;
  otherId = (
    await one<{ id: string }>(
      "insert into users (email, name) values ('canceller@example.test', 'Bob Canceller') returning id",
    )
  ).id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('manual_pause (S-25.20)', () => {
  it('names who paused the task, when, and why — the one row beside the event', async () => {
    const taskId = await pausedTask();
    // An earlier pause the task has since left: before the newest event, so never the answer.
    await action(taskId, 'task.pause', { reason: 'an old pause' }, 120);
    await pausedEvent(taskId, 1, 10);
    await action(taskId, 'task.pause', { reason: 'waiting for the API freeze' }, 10);
    const pause = await manualPauseFor(drizzled, { id: taskId, state: 'paused' }, 'manual');
    expect(pause).toMatchObject({
      by: { user_id: userId, name: 'Pat Pauser' },
      via: 'pause',
      reason: 'waiting for the API freeze',
      reason_cut: false,
    });
    expect(Math.round((Date.now() - Date.parse(pause?.at ?? '')) / 60_000)).toBe(10);
    // The task read carries the same answer.
    const detail = await findTaskDetail(drizzled, taskId, { waiting: false });
    expect(detail?.manual_pause).toEqual(pause);
  });

  // Review of #126: pause, then *Cancel run* hours later on the paused task — which writes a
  // `run.cancel` row and no new `task.paused` (`pauseForCancel`). The pause is still Pat's.
  it('never names a later Cancel run on a task already paused as its pause', async () => {
    const taskId = await pausedTask();
    await pausedEvent(taskId, 1, 180);
    await action(taskId, 'task.pause', { reason: 'waiting for the API freeze' }, 180);
    await action(
      taskId,
      'run.cancel',
      { run_id: '00000000-0000-4000-8000-00000000c0d1' },
      2,
      otherId,
    );
    const pause = await manualPauseFor(drizzled, { id: taskId, state: 'paused' }, 'manual');
    expect(pause).toMatchObject({
      by: { user_id: userId, name: 'Pat Pauser' },
      via: 'pause',
      reason: 'waiting for the API freeze',
    });
    expect(pause?.by?.user_id).not.toBe(otherId);
  });

  it('answers null when two rows sit beside the event, rather than guess which', async () => {
    const taskId = await pausedTask();
    await pausedEvent(taskId, 1, 10);
    await action(taskId, 'task.pause', { reason: 'mine' }, 10);
    await action(
      taskId,
      'run.cancel',
      { run_id: '00000000-0000-4000-8000-00000000c0d2' },
      10,
      otherId,
    );
    expect(await manualPauseFor(drizzled, { id: taskId, state: 'paused' }, 'manual')).toBeNull();
  });

  it('says a run cancel paused it, with no reason, and cuts a long reason', async () => {
    const cancelled = await pausedTask();
    await pausedEvent(cancelled, 1, 5);
    await action(cancelled, 'run.cancel', { run_id: '00000000-0000-4000-8000-00000000c0de' }, 5);
    expect(
      await manualPauseFor(drizzled, { id: cancelled, state: 'paused' }, 'manual'),
    ).toMatchObject({ via: 'run_cancel', reason: null, reason_cut: false });

    const long = await pausedTask();
    await pausedEvent(long, 1, 5);
    await action(long, 'task.pause', { reason: 'z'.repeat(MAX_TASK_PAUSE_REASON_CHARS + 7) }, 5);
    const cut = await manualPauseFor(drizzled, { id: long, state: 'paused' }, 'manual');
    expect(cut?.reason).toHaveLength(MAX_TASK_PAUSE_REASON_CHARS);
    expect(cut?.reason_cut).toBe(true);
  });

  it('answers null for a pause no row records, and for a task not paused by hand', async () => {
    const unrecorded = await pausedTask();
    await action(unrecorded, 'task.pause', { reason: 'long ago' }, 300);
    await pausedEvent(unrecorded, 1, 10);
    expect(
      await manualPauseFor(drizzled, { id: unrecorded, state: 'paused' }, 'manual'),
    ).toBeNull();
    expect(
      await manualPauseFor(drizzled, { id: unrecorded, state: 'paused' }, 'budget'),
    ).toBeNull();
    expect(
      await manualPauseFor(drizzled, { id: unrecorded, state: 'active' }, 'manual'),
    ).toBeNull();
  });
});

describe('S-25.23: a pause says why, and a refusal names the ticket', () => {
  it('serves the run cancel’s recorded reason, and no reason for a pause given none', async () => {
    const cancelled = await pausedTask();
    await pausedEvent(cancelled, 1, 3);
    await action(
      cancelled,
      'run.cancel',
      { run_id: '00000000-0000-4000-8000-00000000c0df', reason: RUN_CANCEL_PAUSE_REASON },
      3,
    );
    expect(
      await manualPauseFor(drizzled, { id: cancelled, state: 'paused' }, 'manual'),
    ).toMatchObject({ via: 'run_cancel', reason: 'the run was cancelled', reason_cut: false });

    // The dialog's blank why sends no reason, so the row has none and the read answers `null`.
    const blank = await pausedTask();
    await pausedEvent(blank, 1, 3);
    await action(blank, 'task.pause', {}, 3);
    expect(await manualPauseFor(drizzled, { id: blank, state: 'paused' }, 'manual')).toMatchObject({
      via: 'pause',
      reason: null,
    });
  });

  it('reads a task’s ticket key, and null for a task that does not exist', async () => {
    const taskId = await pausedTask();
    const { ticket_key: key } = await one<{ ticket_key: string }>(
      'select ticket_key from tasks where id = $1',
      [taskId],
    );
    expect(key).toMatch(/^MP-\d+$/);
    expect(await findTaskTicketKey(drizzled, taskId)).toBe(key);
    expect(await findTaskTicketKey(drizzled, '00000000-0000-4000-8000-00000000dead')).toBeNull();
  });
});
