/**
 * The `NotificationStore` contract against a real PostgreSQL 18 (technical/10 integration tier).
 *
 * The same suite runs against the in-memory store in the contract tier; this is the half that
 * proves the interchange — the unique index that makes a duplicated wake-up a no-op, the single
 * `update … returning` that claims a day's rows, and the `date` round trip, which is the one a
 * `timestamptz` would silently get wrong for a third of every day.
 *
 * Each case runs inside one transaction that is rolled back afterwards, so they are isolated
 * without a database per case.
 */
import type { Transaction } from '@platform/application';
import { integrations as integrationAdapters, notify } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNotificationStoreContract } from '../../contract/support/notification-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient } from '../support/postgres.js';

let database: MigratedDatabase;
let projectId: string;
let taskId: string;
let approvalId: string;
let questionId: string;
let userId: string;
let integrationId: string;
let secondQuestionId: string;
const USER_NAME = 'Fake Maintainer';

beforeAll(async () => {
  database = await createMigratedDatabase('notifications');
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('notify') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as string;
    const task = await client.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state)
       values ($1, 'fake-jira', 'ACME-1', 'https://tickets.example.test/browse/ACME-1',
               'feature', 'normal', 'queued') returning id`,
      [projectId],
    );
    taskId = task.rows[0]?.id as string;
    const approval = await client.query<{ id: string }>(
      "insert into approvals (task_id, kind) values ($1, 'plan') returning id",
      [taskId],
    );
    approvalId = approval.rows[0]?.id as string;
    const question = await client.query<{ id: string }>(
      "insert into questions (task_id, text) values ($1, 'Which currency?') returning id",
      [taskId],
    );
    questionId = question.rows[0]?.id as string;
    const second = await client.query<{ id: string }>(
      "insert into questions (task_id, text) values ($1, 'Which rounding?') returning id",
      [taskId],
    );
    secondQuestionId = second.rows[0]?.id as string;
    const user = await client.query<{ id: string }>(
      "insert into users (email, name) values ('maintainer@example.invalid', $1) returning id",
      [USER_NAME],
    );
    userId = user.rows[0]?.id as string;
    // A chat account for the thread cases (WP-88); no secrets, nothing dials it.
    const integration = await client.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name, config)
       values ($1, 'communication'::integration_type, 'slack', 'chat', '{}'::jsonb) returning id`,
      [org.rows[0]?.id],
    );
    integrationId = integration.rows[0]?.id as string;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

runNotificationStoreContract({
  name: 'postgres',
  create: async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    return {
      store: notify.createPostgresNotificationStore(),
      tx: { adapter: 'postgres', client } as unknown as Transaction,
      projectId: projectId as never,
      taskId: taskId as never,
      approvalId: approvalId as never,
      questionId: questionId as never,
      user: { id: userId as never, name: USER_NAME },
      integrationId: integrationId as never,
      // On the case's own connection, so it reads the rows the case has not committed.
      threads: integrationAdapters.createPostgresThreadDirectory({ sql: client }),
      secondQuestionId: secondQuestionId as never,
      closeQuestion: async (id) => {
        await client.query("update questions set status = 'answered' where id = $1", [id]);
      },
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});

/**
 * The constraints only a database has, and each one is a way the row could lie.
 *
 * The suite above is about behaviour both stores share; these are the guards migration 0023 adds so
 * that a writer nobody reviewed cannot produce a row the digest would misread.
 */
describe('what the notifications table refuses', () => {
  const withClient = async (fn: (client: pg.Client) => Promise<void>): Promise<void> => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    try {
      await fn(client);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  };

  const insert = (columns: string, values: string): string =>
    `insert into notifications (project_id, class, cause_event_id, title, planned_delivery${
      columns === '' ? '' : `, ${columns}`
    }) values ('${projectId}', 'question', gen_random_uuid(), 't', 'digest'${
      values === '' ? '' : `, ${values}`
    })`;

  it('refuses a class, a delivery and a mode it does not know', async () => {
    await withClient(async (client) => {
      await expect(
        client.query(
          `insert into notifications (project_id, class, cause_event_id, title, planned_delivery)
           values ('${projectId}', 'volcano', gen_random_uuid(), 't', 'digest')`,
        ),
      ).rejects.toThrow(/notifications_class_known/);
    });
    await withClient(async (client) => {
      await expect(
        client.query(
          `insert into notifications (project_id, class, cause_event_id, title, planned_delivery)
           values ('${projectId}', 'question', gen_random_uuid(), 't', 'carrier pigeon')`,
        ),
      ).rejects.toThrow(/notifications_planned_delivery_known/);
    });
    await withClient(async (client) => {
      await expect(client.query(insert('mode', `'loud'`))).rejects.toThrow(
        /notifications_mode_known/,
      );
    });
  });

  it('refuses a delivery that names an instant without a channel, or the reverse', async () => {
    await withClient(async (client) => {
      await expect(client.query(insert('delivered_at', 'now()'))).rejects.toThrow(
        /notifications_delivered_pair/,
      );
    });
    await withClient(async (client) => {
      await expect(client.query(insert('delivered_as', `'digest'`))).rejects.toThrow(
        /notifications_delivered_pair/,
      );
    });
  });

  /**
   * **Criterion 2 of WP-65, at the constraint itself.** The same cause and class, twice, with a
   * **null** project: PostgreSQL's default `NULLS DISTINCT` would accept both, which is what dropping
   * `not null` alone would have done to every organisation-scoped notification. Migration 0051's
   * `nulls not distinct` refuses the second.
   */
  it('refuses a second organisation-scoped row for one cause event and class', async () => {
    await withClient(async (client) => {
      const cause = '00000000-0000-4000-9000-00000000ca51';
      const row = `insert into notifications (project_id, class, cause_event_id, title, planned_delivery)
                   values (null, 'budget_exhausted', '${cause}', 't', 'immediate')`;
      await client.query(row);
      await expect(client.query(row)).rejects.toThrow(/notifications_cause_unique/);
    });
  });

  it('refuses an organisation-scoped row that names a task', async () => {
    await withClient(async (client) => {
      await expect(
        client.query(
          `insert into notifications (project_id, task_id, class, cause_event_id, title, planned_delivery)
           values (null, '${taskId}', 'budget_exhausted', gen_random_uuid(), 't', 'immediate')`,
        ),
      ).rejects.toThrow(/notifications_org_scope_has_no_task/);
    });
  });

  it('refuses a second row for one cause event and class', async () => {
    await withClient(async (client) => {
      const cause = '00000000-0000-4000-9000-00000000ca01';
      const row = `insert into notifications (project_id, class, cause_event_id, title, planned_delivery)
                   values ('${projectId}', 'question', '${cause}', 't', 'digest')`;
      await client.query(row);
      await expect(client.query(row)).rejects.toThrow(/notifications_cause_unique/);
    });
  });
});

/**
 * The undelivered gauge's reading (WP-65, PROGRESS backlog 81), against the rows it counts: an
 * immediate row past its bound, a digest row inside its own, and a delivered row that is not counted
 * at all.
 */
describe('countStaleUndeliveredNotifications', () => {
  it('counts undelivered rows past their plan’s bound, and nothing else', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    try {
      const insert = (planned: string, createdAt: string, delivered: boolean) =>
        client.query(
          `insert into notifications (project_id, class, cause_event_id, title, planned_delivery,
                                      created_at, delivered_at, delivered_as)
           values ($1, 'question', gen_random_uuid(), 't', $2, $3::timestamptz,
                   ${delivered ? '$3::timestamptz' : 'null'}, ${delivered ? '$2' : 'null'})`,
          [projectId, planned, createdAt],
        );
      await insert('immediate', '2026-06-01T08:00:00Z', false); // past the immediate bound
      await insert('immediate', '2026-06-01T11:30:00Z', false); // still being retried
      await insert('immediate', '2026-06-01T08:00:00Z', true); // delivered: never counted
      await insert('digest', '2026-06-01T08:00:00Z', false); // waiting on purpose
      await insert('digest', '2026-05-30T08:00:00Z', false); // past a day and the digest job
      // An organisation-scoped failure, which no digest will ever carry.
      await client.query(
        `insert into notifications (project_id, class, cause_event_id, title, planned_delivery, created_at)
         values (null, 'budget_exhausted', gen_random_uuid(), 't', 'immediate', '2026-06-01T07:00:00Z')`,
      );
      const counts = await notify.countStaleUndeliveredNotifications(client as never, {
        immediateBefore: '2026-06-01T11:00:00.000Z' as never,
        digestBefore: '2026-05-31T12:00:00.000Z' as never,
      });
      expect(counts).toEqual({ immediate: 2, digest: 1 });
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
