/**
 * Two writers at once, against a real PostgreSQL 18 — PROGRESS backlog 18, WP-15e.
 *
 * The same suite runs against the in-memory store in the contract tier. This is the half that means
 * something about the *database*: every `begin()` here is a separate connection with its own
 * transaction, so the interleaving goes through two real snapshots and `update … where version = $n`
 * is a predicate PostgreSQL evaluates against whatever the winner left behind, under READ
 * COMMITTED. The in-memory store compares a number, which is the same property and not the same
 * evidence.
 *
 * Unlike `postgres-pipeline-store.integration.test.ts`, nothing here runs inside one rolled-back
 * transaction: a lost update needs a **committed** row between two transactions, which is exactly
 * what that shape cannot express and why this is a second file rather than a case in that one.
 */
import type { Transaction } from '@platform/application';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { runPipelineStoreConcurrencyContract } from '../../contract/support/pipeline-store-concurrency-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let projectId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('pipeline-store-concurrency');
  const client = new pg.Client({ connectionString: database.connectionString });
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('pipeline-concurrency') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as string;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

runPipelineStoreConcurrencyContract({
  name: 'postgres',
  create: async () => {
    const open: pg.Client[] = [];
    return {
      store: pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
      projectId,
      begin: async () => {
        const client = new pg.Client({ connectionString: database.connectionString });
        await client.connect();
        open.push(client);
        await client.query('begin');
        const end = async (verb: 'commit' | 'rollback'): Promise<void> => {
          const index = open.indexOf(client);
          if (index === -1) {
            return;
          }
          open.splice(index, 1);
          await client.query(verb);
          await client.end();
        };
        return {
          tx: { adapter: 'postgres', client } as unknown as Transaction,
          commit: async () => end('commit'),
          rollback: async () => end('rollback'),
        };
      },
      cleanup: async () => {
        // A case that threw before ending its transactions would otherwise leave a connection
        // holding a row lock, and the next case would block on it rather than fail — which is the
        // shape backlog 28 spent a session on (a suite that hangs says less than one that fails).
        for (const client of open.splice(0, open.length)) {
          await client.query('rollback').catch(() => {});
          await client.end().catch(() => {});
        }
      },
    };
  },
});
