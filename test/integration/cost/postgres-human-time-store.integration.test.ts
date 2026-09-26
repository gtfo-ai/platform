/**
 * The `HumanTimeStore` contract against a real PostgreSQL 18 (technical/10 integration tier).
 *
 * The same suite runs against the in-memory store in the contract tier; this is the half that
 * proves the interchange — the SQL, the `numeric(10,2)` round trip through `pg`'s string encoding,
 * the `(mr_ref ->> 'iid')::int` predicate, migration 0025's fourth enum label actually existing in
 * the type, and the refusal the fake's divergence register promises (extending a row that is not
 * there).
 *
 * Each case runs inside one transaction that is rolled back afterwards, so they are isolated
 * without a database per case.
 */
import type { Transaction } from '@platform/application';
import { humanTime } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { runHumanTimeStoreContract } from '../../contract/support/human-time-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;
let orgId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('human-time-store');
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('human-time') returning id",
    );
    orgId = org.rows[0]?.id as string;
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [orgId],
    );
    projectId = project.rows[0]?.id as string;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

runHumanTimeStoreContract({
  name: 'postgres',
  create: async () => {
    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    let ticket = 0;
    return {
      store: humanTime.createPostgresHumanTimeStore(),
      tx,
      projectId: projectId as never,
      seed: {
        task: async (input) => {
          ticket += 1;
          await client.query(
            `insert into tasks (id, project_id, ticket_provider, ticket_key, ticket_url, template,
                                mr_ref, state)
             values ($1, $2, 'fake-jira', $3, 'https://jira.example.test/x', 'feature', $4, 'queued')`,
            [
              input.id,
              projectId,
              `ACME-${ticket}`,
              input.mrIid === undefined
                ? null
                : JSON.stringify({
                    provider: 'gitlab',
                    project_path: 'acme/api',
                    iid: input.mrIid,
                    url: `https://git.example.test/acme/api/-/merge_requests/${input.mrIid}`,
                  }),
            ],
          );
        },
        identity: async (input) => {
          // A `null` user is a declared machine (WP-61, migration 0045): the `kind` column follows
          // from it, and the table's check refuses the two written apart.
          await client.query(
            'insert into user_identities (provider, external_id, user_id, kind) values ($1, $2, $3, $4)',
            [
              input.provider,
              input.externalId,
              input.userId,
              input.userId === null ? 'machine' : 'person',
            ],
          );
        },
        question: async (input) => {
          await client.query(
            `insert into questions (id, task_id, text, asked_at) values ($1, $2, 'why?', $3)`,
            [input.id, input.taskId, input.askedAt],
          );
        },
        timezone: async (value) => {
          await client.query('update organizations set timezone = $1 where id = $2', [
            value ?? 'UTC',
            orgId,
          ]);
        },
        user: async (id) => {
          await client.query(`insert into users (id, email, name) values ($1, $2, 'Ada')`, [
            id,
            `${id}@example.invalid`,
          ]);
        },
      },
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});
