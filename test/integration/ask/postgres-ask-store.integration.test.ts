/**
 * The `AskStore` contract against a real PostgreSQL 18 (technical/10 integration tier).
 *
 * The same suite runs against the in-memory store in the contract tier; this is the half that
 * proves the interchange — the `(project_id, ticket_comment_id)` unique index, the three `check`
 * constraints migration 0024 states (an answer and its instant move together, a refusal carries a
 * reason), and the two projections, which are a **join** here and seeded arrays in the fake.
 *
 * Each case runs inside one transaction that is rolled back afterwards, so they are isolated
 * without a database per case.
 */
import type { Transaction } from '@platform/application';
import { ask } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { runAskStoreContract } from '../../contract/support/ask-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;
let taskId: string;
let userId: string;
let runId: string;
let auditId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('asks');
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('asks') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as string;
    const user = await client.query<{ id: string }>(
      `insert into users (email, name, role) values ('ada@example.test', 'Ada', 'member')
       returning id`,
    );
    userId = user.rows[0]?.id as string;
    const task = await client.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state)
       values ($1, 'fake-jira', 'ACME-1', 'https://tickets.example.test/browse/ACME-1',
               'feature', 'normal', 'queued') returning id`,
      [projectId],
    );
    taskId = task.rows[0]?.id as string;
    const run = await client.query<{ id: string }>(
      `insert into runs (task_id, project_id, role, mode, model, prompt_version, status,
                         usd_reported, created_at)
       values ($1, $2, 'product_manager', 'normal', 'claude-sonnet-5', 'p1+x', 'completed',
               0.12, now()) returning id`,
      [taskId, projectId],
    );
    runId = run.rows[0]?.id as string;
    const audit = await client.query<{ id: string }>(
      `insert into human_actions (task_id, user_id, action, params)
       values ($1, $2, 'task.pause', '{"reason":"waiting on the API team"}'::jsonb) returning id`,
      [taskId, userId],
    );
    auditId = audit.rows[0]?.id as string;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

runAskStoreContract({
  name: 'postgres',
  create: async () => {
    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    await client.query('begin');
    return {
      store: ask.createPostgresAskStore(),
      tx: { adapter: 'postgres', client } as unknown as Transaction,
      projectId: projectId as never,
      taskId: taskId as never,
      userId: userId as never,
      runId: runId as never,
      auditId: auditId as never,
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});
