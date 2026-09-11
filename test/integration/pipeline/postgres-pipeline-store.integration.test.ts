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
import { afterAll, beforeAll } from 'vitest';
import { runPipelineStoreContract } from '../../contract/support/pipeline-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;
let userId: string;

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
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});
