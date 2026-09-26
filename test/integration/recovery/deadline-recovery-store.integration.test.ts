/**
 * The deadline recovery's reads and its one write against PostgreSQL 18 — WP-56 round 2, PROGRESS
 * backlog **161** and **162**.
 *
 * The rules are asserted as countable effects in `packages/application/src/pipeline/deadlines.test.ts`
 * over the in-memory twin; this is the half that proves the SQL finds the same rows: an overdue
 * question and approval, **not** an answered one, **not** one on a cancelled task, an undated row,
 * a backfill that writes once, and a paused task whose newest take-over boundary is the take-over.
 * Each case runs in one transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { recovery as recoveryAdapters } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: Id;
let client: pg.Client;
let tx: Transaction;
let ticket = 0;

const store = recoveryAdapters.createPostgresDeadlineRecoveryStore();

const seedTask = async (state: string): Promise<Id> => {
  ticket += 1;
  const { rows } = await client.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, template_snapshot)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/ACME', 'feature',
             $3::task_state, 'refinement', $4::jsonb) returning id`,
    [projectId, `ACME-${ticket}`, state, JSON.stringify(FEATURE_TEMPLATE)],
  );
  return rows[0]?.id as Id;
};

const seedQuestion = async (taskId: Id, status: string, deadlineAt: string | null): Promise<Id> => {
  const id = randomUUID() as Id;
  await client.query(
    `insert into questions (id, task_id, stage, text, blocking, status, asked_at, deadline_at)
     values ($1, $2, 'refinement', 'Which currency?', true, $3::question_status,
             '2026-06-05T16:00:00Z', $4)`,
    [id, taskId, status, deadlineAt],
  );
  return id;
};

const seedApproval = async (taskId: Id, deadlineAt: string | null): Promise<Id> => {
  const id = randomUUID() as Id;
  await client.query(
    `insert into approvals (id, task_id, kind, status, requested_at, deadline_at, stage, attempt)
     values ($1, $2, 'plan', 'pending', '2026-06-05T16:00:00Z', $3, 'architecture', 1)`,
    [id, taskId, deadlineAt],
  );
  return id;
};

const appendTaskEvent = async (taskId: Id, seq: number, type: string): Promise<void> => {
  await client.query(
    `insert into events (stream_type, stream_id, stream_seq, type, payload, actor)
     values ('task', $1, $2, $3, $4::jsonb, '{"kind":"system","component":"pipeline"}'::jsonb)`,
    [
      taskId,
      seq,
      type,
      JSON.stringify({
        project_id: projectId,
        task_id: taskId,
        branch: 'agentic/ACME-1',
        session_id: null,
        stage: 'implementation',
      }),
    ],
  );
};

beforeAll(async () => {
  database = await createMigratedDatabase('deadline-recovery');
  const setup = new pg.Client({ connectionString: database.connectionString });
  await setup.connect();
  try {
    const org = await setup.query<{ id: string }>(
      "insert into organizations (name) values ('deadlines') returning id",
    );
    const project = await setup.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'dl', 'Deadlines', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as Id;
  } finally {
    await setup.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  await client.query('begin');
  tx = { adapter: 'postgres', client } as unknown as Transaction;
});

afterEach(async () => {
  await client.query('rollback');
  await client.end();
});

describe('the deadline recovery store (WP-56, backlog 161 and 162)', () => {
  it('finds the overdue open question and pending approval, and nothing answered, current or finished', async () => {
    const waiting = await seedTask('waiting_answers');
    const overdue = await seedQuestion(waiting, 'open', '2026-06-08T16:00:00Z');
    await seedQuestion(waiting, 'open', '2026-06-09T16:00:00Z');
    await seedQuestion(waiting, 'answered', '2026-06-08T16:00:00Z');
    const cancelled = await seedTask('cancelled');
    await seedQuestion(cancelled, 'open', '2026-06-08T16:00:00Z');
    const approving = await seedTask('waiting_approval');
    const approval = await seedApproval(approving, '2026-06-08T16:00:00Z');

    const found = await store.overdue(tx, { dueBefore: '2026-06-08T16:01:00.000Z', limit: 50 });
    expect(found.map((row) => [row.aggregate, row.id]).sort()).toEqual(
      [
        ['approval', approval],
        ['question', overdue],
      ].sort(),
    );
    expect(found.find((row) => row.id === overdue)).toEqual({
      aggregate: 'question',
      id: overdue,
      projectId,
      taskId: waiting,
    });
  });

  it('finds the undated rows, and backfills each exactly once', async () => {
    const waiting = await seedTask('waiting_answers');
    const question = await seedQuestion(waiting, 'open', null);
    const approving = await seedTask('waiting_approval');
    const approval = await seedApproval(approving, null);
    await seedQuestion(waiting, 'answered', null);

    const undated = await store.undated(tx, { limit: 50 });
    expect(undated.map((row) => row.id).sort()).toEqual([approval, question].sort());

    const row = undated.find((entry) => entry.id === question) as (typeof undated)[number];
    const deadlineAt = '2026-06-11T10:00:00.000Z' as const;
    expect(await store.backfillDeadline(tx, { ...row, deadlineAt })).toBe(true);
    expect(
      await store.backfillDeadline(tx, { ...row, deadlineAt: '2030-01-01T00:00:00.000Z' }),
    ).toBe(false);
    const { rows } = await client.query<{ deadline_at: Date }>(
      'select deadline_at from questions where id = $1',
      [question],
    );
    expect(rows[0]?.deadline_at.toISOString()).toBe(deadlineAt);
    expect((await store.undated(tx, { limit: 50 })).map((entry) => entry.id)).toEqual([approval]);
  });

  it('finds a paused task still taken over, and not one handed back or merely paused', async () => {
    const held = await seedTask('paused');
    await appendTaskEvent(held, 1, 'task.stage.entered');
    await appendTaskEvent(held, 2, 'task.taken_over');
    await appendTaskEvent(held, 3, 'task.escalated');
    const returned = await seedTask('paused');
    await appendTaskEvent(returned, 1, 'task.taken_over');
    await appendTaskEvent(returned, 2, 'task.handed_back');
    const paused = await seedTask('paused');
    await appendTaskEvent(paused, 1, 'task.paused');

    const found = await store.heldTasks(tx, { limit: 50 });
    expect(found.map((row) => row.taskId)).toEqual([held]);
    expect(Number.isNaN(Date.parse(found[0]?.takenAt as string))).toBe(false);
  });
});
