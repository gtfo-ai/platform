/**
 * The `PipelineStore` contract against a real PostgreSQL 18 (technical/10 integration tier).
 *
 * The same suite runs against the in-memory store in the contract tier. This is the half that
 * proves the interchange: the SQL, the `numeric(12,6)` round trip, the `jsonb` columns migration
 * 0012 added, and the two refusals the in-memory store spells out in its divergence register — a
 * save that matches no row, and a finish for a run that does not exist.
 *
 * Each test runs inside one transaction that is rolled back afterwards, so the cases are isolated
 * without a database per case.
 */
import type { Transaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipelineStoreContract } from '../../contract/support/pipeline-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient } from '../support/postgres.js';

let database: MigratedDatabase;
let projectId: string;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('pipeline-store');
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('pipeline-store') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as string;
    const user = await client.query<{ id: string }>(
      `insert into users (email, name) values ('operator@example.test', 'Operator') returning id`,
    );
    userId = user.rows[0]?.id as string;
    const other = await client.query<{ id: string }>(
      `insert into users (email, name) values ('bystander@example.test', 'Bystander') returning id`,
    );
    otherUserId = other.rows[0]?.id as string;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

runPipelineStoreContract({
  name: 'postgres',
  create: async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    return {
      store: pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
      tx,
      projectId,
      userId,
      // WP-56: `takenOver` reads `events`, so the case writes the stream it reads — inside the
      // case's own transaction, which the rollback below removes with everything else.
      appendTaskEvent: async (event) => {
        // `events` is range-partitioned by month and migrations create the current month onwards;
        // the suite's instants are fixed (rule 86), so the month they fall in is created here, in
        // the case's transaction, and rolled back with it.
        const month = `${event.occurredAt.slice(0, 7)}-01`;
        const { rows } = await client.query<{ name: string }>(
          `select platform_partition_name('events', $1::date) as name`,
          [month],
        );
        await client.query(
          `create table if not exists public.${client.escapeIdentifier(rows[0]?.name as string)}
             partition of events for values from ('${month}') to (('${month}'::date + interval '1 month')::date)`,
        );
        await client.query(
          `insert into events (id, stream_type, stream_id, stream_seq, type, payload, actor,
                               occurred_at)
           values ($1, $8, $2, $3, $4, $5::jsonb, $7::jsonb, $6)`,
          [
            event.id,
            event.taskId,
            event.seq,
            event.type,
            JSON.stringify(event.payload),
            event.occurredAt,
            JSON.stringify(
              event.actorUserId === undefined
                ? { kind: 'system', component: 'pipeline' }
                : { kind: 'user', user_id: event.actorUserId },
            ),
            event.streamType ?? 'task',
          ],
        );
      },
      otherUserId,
      recordHumanAction: async (input) => {
        await client.query(
          `insert into human_actions (task_id, user_id, action, created_at)
           values ($1, $2, 'task.pause', $3)`,
          [input.taskId, input.userId, input.at],
        );
      },
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});

/**
 * An unreadable `tasks.pipeline_dial` refuses **that task** and nothing else (WP-62 review round 1).
 *
 * The single-task read throws, because compiling the task with no dial would be the permissive
 * direction; a list read that serves other tasks skips the row and names it, so one bad document
 * does not take down the conflict warnings or the rebase re-check for the whole project.
 */
describe('a malformed pipeline_dial', () => {
  it('refuses the one task on load and is left out of a list read', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    try {
      const insert = async (key: string, dial: string | null): Promise<string> => {
        const { rows } = await client.query<{ id: string }>(
          `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                              current_stage, pipeline_dial)
           values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/' || $2, 'feature',
                   'active', 'implementation', $3::jsonb) returning id`,
          [projectId, key, dial],
        );
        return rows[0]?.id as string;
      };
      const good = await insert('DIAL-1', null);
      const bad = await insert('DIAL-2', JSON.stringify({ level: 'assist' }));
      const errors: unknown[] = [];
      const store = pipeline.createPostgresPipelineStore({
        templates: SHIPPED_TEMPLATES,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: (fields: unknown) => {
            errors.push(fields);
          },
        },
      });
      const tx = { adapter: 'postgres', client } as unknown as Transaction;

      await expect(store.tasks.load(tx, bad as never)).rejects.toThrow(
        /tasks\.pipeline_dial that does not match the current schema/,
      );
      const listed = await store.tasks.listAtStage(tx, projectId as never, 'implementation');
      expect(listed.map((stored) => stored.task.id)).toEqual([good]);
      expect(errors).toEqual([expect.objectContaining({ task_id: bad })]);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});

/**
 * **One task per ticket, enforced by the database on the stable id too** (WP-134, PROGRESS backlog
 * 418; migration 0077). `findByTicket` is the check; the partial unique index is the backstop for
 * two intakes of one moved issue — `OLD-1` and `NEW-5`, one id — that both passed it. A row with no
 * id is outside the index, and an id the shape check does not admit is refused rather than stored.
 */
describe('tasks.ticket_id (migration 0077)', () => {
  it('refuses a second task for the same issue id under another key, and only that', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    const insert = (key: string, id: string | null, mode = 'normal') =>
      client.query(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, ticket_id, template,
                            mode, state)
         values ($1, 'jira-cloud', $2, 'https://acme-example.atlassian.net/browse/' || $2, $3,
                 'feature', $4, 'queued')`,
        [projectId, key, id, mode],
      );
    // A thunk, so the statement is sent after the savepoint rather than before it.
    const refusedWith = async (
      attempt: () => Promise<unknown>,
      code: string,
      constraint: string,
    ) => {
      await client.query('savepoint attempt');
      const error = (await attempt().then(
        () => null,
        (caught: unknown) => caught,
      )) as { code?: string; constraint?: string } | null;
      await client.query('rollback to savepoint attempt');
      expect(error?.code).toBe(code);
      expect(error?.constraint).toBe(constraint);
    };
    try {
      await insert('OLD-1', '10001');
      await refusedWith(() => insert('NEW-5', '10001'), '23505', 'tasks_project_ticket_id_mode');
      // Another issue, a row with no id, and the same issue in another mode are all admitted.
      await insert('NEW-6', '10002');
      await insert('NEW-7', null);
      await insert('NEW-8', null);
      await insert('OLD-1', '10001', 'shadow');
      // Provider text that is not an id is refused, not stored.
      await refusedWith(() => insert('BAD-1', "1' or '1"), '23514', 'tasks_ticket_id_shape');
      await refusedWith(() => insert('BAD-2', 'x'.repeat(65)), '23514', 'tasks_ticket_id_shape');
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});

/**
 * **The gate's failure is kept on the row whatever the person chose** (WP-152 round 1, migration
 * 0086). The contract suite reads what the port serves; this reads the row, which the port does not
 * expose: an unticked return keeps the excerpt in `attached_feedback` with
 * `attached_feedback_sent = false`, and the database refuses a `sent` with no text beside it.
 */
describe('task_stages.attached_feedback (migration 0086)', () => {
  it('keeps an unticked excerpt on the row, unsent, and refuses a sent flag with no text', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                            current_stage)
         values ($1, 'fake-jira', 'GATE-1', 'https://jira.example.test/browse/GATE-1', 'feature',
                 'needs_human', 'ci_gate') returning id`,
        [projectId],
      );
      const taskId = rows[0]?.id as Id;
      const store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const EXCERPT = 'pipeline p-1 failed: phpstan';
      await store.tasks.recordStageEntered(tx, {
        taskId,
        stage: 'ci_gate',
        attempt: 1,
        causedByEventId: null,
      });
      const exit = (reason: string) =>
        store.tasks.recordStageExited(tx, {
          taskId,
          stage: 'ci_gate',
          attempt: 1,
          state: 'returned',
          outcome: 'returned',
          returnReason: reason,
          returnedTo: 'implementation',
        });
      await exit(EXCERPT);
      expect(
        await store.tasks.attachReturnReason(tx, {
          taskId,
          stage: 'ci_gate',
          attempt: 1,
          send: false,
        }),
      ).toBe(true);
      await exit('the person’s note');
      const row = await client.query<{
        return_reason: string;
        attached_feedback: string | null;
        attached_feedback_sent: boolean;
      }>(
        `select return_reason, attached_feedback, attached_feedback_sent from task_stages
          where task_id = $1 and stage = 'ci_gate' and attempt = 1`,
        [taskId],
      );
      expect(row.rows[0]).toEqual({
        return_reason: 'the person’s note',
        attached_feedback: EXCERPT,
        attached_feedback_sent: false,
      });

      await client.query('savepoint attempt');
      const refused = (await client
        .query(
          `update task_stages set attached_feedback = null, attached_feedback_sent = true
            where task_id = $1`,
          [taskId],
        )
        .then(
          () => null,
          (caught: unknown) => caught,
        )) as { code?: string; constraint?: string } | null;
      await client.query('rollback to savepoint attempt');
      expect(refused?.code).toBe('23514');
      expect(refused?.constraint).toBe('task_stages_attached_feedback_sent_has_text');
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
