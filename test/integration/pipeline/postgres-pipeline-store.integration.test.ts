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
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipelineStoreContract } from '../../contract/support/pipeline-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('pipeline-store');
  const client = new pg.Client({ connectionString: database.connectionString });
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
    const client = new pg.Client({ connectionString: database.connectionString });
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
           values ($1, 'task', $2, $3, $4, $5::jsonb, $7::jsonb, $6)`,
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
    const client = new pg.Client({ connectionString: database.connectionString });
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
