/**
 * **The task read's merge rows, against PostgreSQL 18** (S-28.13's review leftover, S-28.15):
 *
 *  1. a `task_merge_checks` row that read "not mergeable" **before** the open `ready_for_merge`
 *     stage row was entered says nothing — it belongs to an earlier entry (review of #155) — and
 *     one read after the entry is served as `merge_request_blocked`;
 *  2. `merge` names who merges and what the platform waits for at Ready, and the last attempt with
 *     the plan decision and the name of the person who approved the plan (TD-038 decision 7).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Database,
  mergeStatusFor,
  providerSyncFor,
} from '../../../apps/server/src/queries/pipeline-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: Database;
let projectId = '';
let userId = '';
let counter = 0;

const one = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R> => (await pool.query<R>(text, values)).rows[0] as R;

const readyTask = async (enteredMinutesAgo: number): Promise<string> => {
  counter += 1;
  const row = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state,
                        current_stage)
     values ($1, 'fake-jira', $2, 'https://tickets.example.test/browse/' || $2, 'feature',
             'normal', 'ready_for_merge', 'ready_for_merge') returning id`,
    [projectId, `MS-${counter}`],
  );
  await pool.query(
    `insert into task_stages (task_id, stage, attempt, state, entered_at)
     values ($1, 'ready_for_merge', 1, 'running', now() - make_interval(mins => $2))`,
    [row.id, enteredMinutesAgo],
  );
  return row.id;
};

const blockedCheck = async (taskId: string, checkedMinutesAgo: number): Promise<void> => {
  await pool.query(
    `insert into task_merge_checks
       (task_id, claimed_at, checked_at, mergeable, reason, provider_status, unresolved_threads)
     values ($1, now() - make_interval(mins => $2), now() - make_interval(mins => $2), false,
             'unresolved_threads', 'discussions_not_resolved', 2)`,
    [taskId, checkedMinutesAgo],
  );
};

beforeAll(async () => {
  database = await createMigratedDatabase('merge-status');
  pool = createTestPool(database.connectionString, { max: 4 });
  drizzled = drizzle(pool) as unknown as Database;
  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('merge-status') returning id",
  );
  projectId = (
    await one<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'ms', 'Merge status', 'https://git.example.test/acme/ms.git') returning id`,
      [org.id],
    )
  ).id;
  userId = (
    await one<{ id: string }>(
      "insert into users (email, name) values ('jana@example.test', 'Jana Nováková') returning id",
    )
  ).id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('merge_request_blocked speaks only for the current entry into Ready (review of #155)', () => {
  it('serves nothing for a check read before the open stage row was entered', async () => {
    const taskId = await readyTask(5);
    await blockedCheck(taskId, 30);
    const rows = await providerSyncFor(drizzled, taskId, 'ready_for_merge');
    expect(rows.filter((row) => row.subject === 'merge_request_blocked')).toEqual([]);
  });

  it('serves a check read after the entry, with its reason and thread count', async () => {
    const taskId = await readyTask(30);
    await blockedCheck(taskId, 5);
    const rows = await providerSyncFor(drizzled, taskId, 'ready_for_merge');
    const blocked = rows.filter((row) => row.subject === 'merge_request_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      reason_code: 'unresolved_threads',
      unresolved_threads: 2,
    });
  });
});

describe('the merge block (S-28.15, TD-038 decision 7)', () => {
  it('is null when nothing was decided and the platform never tried', async () => {
    const taskId = await readyTask(5);
    expect(await mergeStatusFor(drizzled, taskId, 'ready_for_merge')).toBeNull();
  });

  it('names who merges and what the platform waits for at Ready', async () => {
    const taskId = await readyTask(5);
    await pool.query(
      `insert into task_merge_checks (task_id, claimed_at, merge_by, merge_wait)
       values ($1, now(), 'person', 'setting_person')`,
      [taskId],
    );
    expect(await mergeStatusFor(drizzled, taskId, 'ready_for_merge')).toEqual({
      by: 'person',
      waiting_for: 'setting_person',
      last_attempt: null,
    });
  });

  it('serves the last attempt with the plan decision and the name of the person who approved the plan', async () => {
    const taskId = await readyTask(5);
    const approval = await one<{ id: string }>(
      `insert into approvals (task_id, kind, status, decided_by_user_id, decided_at)
       values ($1, 'plan', 'approved', $2, now()) returning id`,
      [taskId, userId],
    );
    await pool.query(
      `insert into task_merges (task_id, head_sha, kind, outcome, merge_commit_sha, plan_decision,
                                plan_approval_id, attempted_at)
       values ($1, $2, 'merge', 'merged', $3, 'approved_by_person', $4, now())`,
      [taskId, 'b'.repeat(40), 'd'.repeat(40), approval.id],
    );
    // Past Ready (the merge moved it on): the attempt is still served, the wait is not.
    const merge = await mergeStatusFor(drizzled, taskId, 'merged');
    expect(merge?.waiting_for).toBeNull();
    expect(merge?.last_attempt).toMatchObject({
      outcome: 'merged',
      merge_commit_sha: 'd'.repeat(40),
      plan_decision: 'approved_by_person',
      plan_approved_by: 'Jana Nováková',
    });
  });

  it('refuses a second row for the same task and head (one decisive attempt per head)', async () => {
    const taskId = await readyTask(5);
    const insert = () =>
      pool.query(
        `insert into task_merges (task_id, head_sha, kind, outcome, plan_decision, attempted_at)
         values ($1, $2, 'merge', 'refused', 'not_required', now())`,
        [taskId, 'c'.repeat(40)],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });
});
