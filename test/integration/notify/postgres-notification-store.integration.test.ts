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
import { notify } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNotificationStoreContract } from '../../contract/support/notification-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;
let taskId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('notifications');
  const client = new pg.Client({ connectionString: database.connectionString });
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
    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    await client.query('begin');
    return {
      store: notify.createPostgresNotificationStore(),
      tx: { adapter: 'postgres', client } as unknown as Transaction,
      projectId: projectId as never,
      taskId: taskId as never,
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
    const client = new pg.Client({ connectionString: database.connectionString });
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
