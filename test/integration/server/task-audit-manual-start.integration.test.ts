/**
 * **Who did what lists the person who started a task by hand** (WP-134, PROGRESS backlog 416,
 * criterion 1), against a real PostgreSQL 18 and as the application role.
 *
 * The manual start's `task.start` row is written with the `ticket.matched` it records, before intake
 * creates the task, so its `task_id` is null and stays null (`human_actions` is append-only: the
 * application role holds no `update` on it). Every task audit reader therefore also returns the one
 * `task.start` row naming the task's originating match (`packages/infrastructure/src/ask/task-audit.ts`).
 * Both readers are driven here: the ask store's `auditForTask` (*Who did what* and the task export)
 * and `get_task_context`'s `audit` (the server's Drizzle projection).
 *
 * Four tasks, each a direction (standing rule 42):
 * - `MANUAL` — started by hand: lists its `task.start` with the person;
 * - `RULE` — matched by a rule: lists none, even though another project's `task.start` row names
 *   the very match that caused it (the project must agree);
 * - `RECONCILED` — started by hand, whose intake wake-up was lost and re-emitted by the reconciler:
 *   lists the start one step back;
 * - `OTHER` — a second manual start in the same project: lists its own start, never `MANUAL`'s.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { ask, db } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTaskContext } from '../../../apps/server/src/queries/task-context-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;

let projectId: string;
let otherProjectId: string;
let userId: string;
let otherUserId: string;
const tasks: Record<'MANUAL' | 'RULE' | 'RECONCILED' | 'OTHER', string> = {
  MANUAL: '',
  RULE: '',
  RECONCILED: '',
  OTHER: '',
};
const starts: Record<'MANUAL' | 'RECONCILED' | 'OTHER' | 'FOREIGN', string> = {
  MANUAL: '',
  RECONCILED: '',
  OTHER: '',
  FOREIGN: '',
};

const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await pool.query<T>(text, values)).rows[0] as T;

const sequences = new Map<string, number>();
const appendEvent = async (event: {
  readonly streamType: 'project' | 'task';
  readonly streamId: string;
  readonly type: string;
  readonly causeEventId?: string;
  readonly actor: Record<string, unknown>;
}): Promise<string> => {
  const seq = (sequences.get(event.streamId) ?? 0) + 1;
  sequences.set(event.streamId, seq);
  const id = randomUUID();
  await pool.query(
    `insert into events (id, stream_type, stream_id, stream_seq, type, payload, actor, cause_event_id)
     values ($1, $2, $3, $4, $5, '{}'::jsonb, $6::jsonb, $7)`,
    [
      id,
      event.streamType,
      event.streamId,
      seq,
      event.type,
      JSON.stringify(event.actor),
      event.causeEventId ?? null,
    ],
  );
  return id;
};

const matched = (project: string, actor: Record<string, unknown>, causeEventId?: string) =>
  appendEvent({
    streamType: 'project',
    streamId: project,
    type: 'ticket.matched',
    actor,
    ...(causeEventId === undefined ? {} : { causeEventId }),
  });

/** The row `apps/server/src/task-start.ts` writes, with `task_id` null as it is written. */
const startRow = async (user: string, project: string, eventId: string, key: string) =>
  (
    await one<{ id: string }>(
      `insert into human_actions (task_id, user_id, action, params)
       values (null, $1, 'task.start', $2::jsonb) returning id`,
      [
        user,
        JSON.stringify({
          project_id: project,
          event_id: eventId,
          ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
          idempotency_key: `start-${key}`,
          body_digest: null,
        }),
      ],
    )
  ).id;

/** A task intake created from `causeEventId`, as `saga.ts` records it. */
const intaken = async (key: string, causeEventId: string): Promise<string> => {
  const task = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/X', 'feature', 'active')
     returning id`,
    [projectId, key],
  );
  await appendEvent({
    streamType: 'task',
    streamId: task.id,
    type: 'task.created',
    causeEventId,
    actor: { kind: 'system', component: 'pipeline.intake' },
  });
  // A command on the task after it exists: its row carries `task_id` as every other one does.
  await pool.query(
    `insert into human_actions (task_id, action, params) values ($1, 'task.pause', '{}'::jsonb)`,
    [task.id],
  );
  return task.id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('task-audit-start');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  drizzled = drizzle(pool, { schema: db.schema });
  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('audit') returning id",
  );
  const project = async (key: string) =>
    (
      await one<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, $2, $2, 'https://git.example.test/acme/api.git') returning id`,
        [org.id, key],
      )
    ).id;
  projectId = await project('ours');
  otherProjectId = await project('theirs');
  const user = async (email: string) =>
    (
      await one<{ id: string }>(
        "insert into users (email, name, role) values ($1, 'Member', 'member') returning id",
        [email],
      )
    ).id;
  userId = await user('ada@example.test');
  otherUserId = await user('grace@example.test');
  const person = (id: string) => ({ kind: 'user', user_id: id });
  const integration = { kind: 'integration', integration_id: randomUUID(), provider: 'fake-jira' };

  const manual = await matched(projectId, person(userId));
  starts.MANUAL = await startRow(userId, projectId, manual, 'ACME-1');
  tasks.MANUAL = await intaken('ACME-1', manual);

  const rule = await matched(projectId, integration);
  // Another project's start naming this project's match: the project must agree, so not ours.
  starts.FOREIGN = await startRow(otherUserId, otherProjectId, rule, 'ACME-2');
  tasks.RULE = await intaken('ACME-2', rule);

  const lost = await matched(projectId, person(userId));
  starts.RECONCILED = await startRow(userId, projectId, lost, 'ACME-3');
  const reemitted = await matched(
    projectId,
    { kind: 'system', component: 'pipeline.intake.reconcile' },
    lost,
  );
  tasks.RECONCILED = await intaken('ACME-3', reemitted);

  const other = await matched(projectId, person(otherUserId));
  starts.OTHER = await startRow(otherUserId, projectId, other, 'ACME-4');
  tasks.OTHER = await intaken('ACME-4', other);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/** The ask store's read — *Who did what* and the task export — inside a transaction of its own. */
const whoDidWhat = async (taskId: string) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    return await ask.createPostgresAskStore().auditForTask(tx, taskId as Id, 50);
  } finally {
    await client.query('rollback');
    client.release();
  }
};

/** `get_task_context`'s `audit` — the server's Drizzle projection. */
const contextAudit = async (taskId: string) => {
  const answer = await readTaskContext(drizzled, ['audit'], {
    projectId: projectId as Id,
    taskId: taskId as Id,
  });
  const section = answer.sections.audit as unknown as {
    readonly actions: readonly { id: string; action: string; by_user_id: string | null }[];
  };
  return section.actions;
};

describe('the task audit lists the manual start that caused the task (WP-134, backlog 416)', () => {
  it('Who did what lists the person who started the task, and a rule-matched task lists no start', async () => {
    const manual = await whoDidWhat(tasks.MANUAL);
    expect(manual.map((row) => row.action).sort()).toEqual(['task.pause', 'task.start']);
    const start = manual.find((row) => row.action === 'task.start');
    expect(start?.id).toBe(starts.MANUAL);
    expect(start?.userId).toBe(userId);

    const rule = await whoDidWhat(tasks.RULE);
    expect(rule.map((row) => row.action)).toEqual(['task.pause']);
    expect(rule.map((row) => row.id)).not.toContain(starts.FOREIGN);

    const reconciled = await whoDidWhat(tasks.RECONCILED);
    expect(reconciled.find((row) => row.action === 'task.start')?.id).toBe(starts.RECONCILED);

    const other = await whoDidWhat(tasks.OTHER);
    const otherStarts = other.filter((row) => row.action === 'task.start');
    expect(otherStarts.map((row) => [row.id, row.userId])).toEqual([[starts.OTHER, otherUserId]]);
  });

  it('get_task_context’s audit reads the same rows', async () => {
    for (const [name, expected] of [
      ['MANUAL', starts.MANUAL],
      ['RECONCILED', starts.RECONCILED],
      ['OTHER', starts.OTHER],
    ] as const) {
      const rows = await contextAudit(tasks[name]);
      expect(
        rows.filter((row) => row.action === 'task.start').map((row) => row.id),
        name,
      ).toEqual([expected]);
    }
    expect((await contextAudit(tasks.RULE)).map((row) => row.action)).toEqual(['task.pause']);
  });

  it('leaves the start row as it was written: the audit is read, never updated', async () => {
    const { rows } = await pool.query<{ task_id: string | null }>(
      "select task_id from human_actions where action = 'task.start'",
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.task_id === null)).toBe(true);
    // And the application role could not have done otherwise.
    await expect(
      pool.query('update human_actions set task_id = $1 where id = $2', [
        tasks.MANUAL,
        starts.MANUAL,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});
