/**
 * Migration 0040 — `task_stages.state` gets the contracts' vocabulary, and `returned_to` (WP-55).
 *
 * Two things only a database can show. **The rewrite** of rows written in the old `entered`/`exited`
 * words, which is why this suite migrates to 0039 first, writes those rows the way the old store did,
 * and only then applies 0040. And **the constraint**, held to `taskStageStateSchema` in both
 * directions: every word the schema declares is accepted and a word it does not declare is refused,
 * so the SQL list and the zod list cannot drift apart without this file failing (the parity test
 * compares columns, not check constraints — its docblock says so).
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskStageStateSchema } from '@platform/contracts';
import { db } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, withClient } from '../support/postgres.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/infrastructure/src/db/migrations/', import.meta.url),
);
const VOCABULARY_MIGRATION = '0040_task_stage_vocabulary.sql';

let database: TestDatabase;
let before: string;
let taskId: string;

/** The rows the pre-0040 store wrote, in its own words — one per branch of the rewrite. */
const LEGACY_ROWS = [
  { stage: 'implementation', attempt: 1, state: 'entered', outcome: null, exited: false },
  { stage: 'code_review', attempt: 1, state: 'exited', outcome: 'returned', exited: true },
  { stage: 'implementation', attempt: 2, state: 'exited', outcome: 'failed', exited: true },
  { stage: 'refinement', attempt: 1, state: 'exited', outcome: 'approve', exited: true },
  { stage: 'intake', attempt: 1, state: 'exited', outcome: 'system', exited: true },
  // What `recordStageSignature` could leave: opened `entered`, then closed by the exit.
  { stage: 'ci_gate', attempt: 1, state: 'entered', outcome: 'returned', exited: true },
] as const;

describe('migration 0040: task_stages.state', () => {
  beforeAll(async () => {
    database = await createTestDatabase('stage_vocabulary');
    before = mkdtempSync(join(tmpdir(), 'wp55-migrations-'));
    for (const file of readdirSync(MIGRATIONS)) {
      if (file.endsWith('.sql') && file < VOCABULARY_MIGRATION) {
        cpSync(join(MIGRATIONS, file), join(before, file));
      }
    }
    await db.runMigrations({
      connectionString: database.connectionString,
      migrationsDirectory: before,
    });
    await withClient(database.connectionString, async (client) => {
      const org = await client.query<{ id: string }>(
        "insert into organizations (name) values ('vocabulary') returning id",
      );
      const project = await client.query<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
        [org.rows[0]?.id],
      );
      const task = await client.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
         values ($1, 'fake-jira', 'ACME-1', 'https://jira.example.test/x', 'feature') returning id`,
        [project.rows[0]?.id],
      );
      taskId = task.rows[0]?.id as string;
      for (const row of LEGACY_ROWS) {
        await client.query(
          `insert into task_stages (task_id, stage, attempt, state, outcome, exited_at)
           values ($1, $2, $3, $4, $5, case when $6 then now() end)`,
          [taskId, row.stage, row.attempt, row.state, row.outcome, row.exited],
        );
      }
    });
    await db.runMigrations({ connectionString: database.connectionString });
  }, 180_000);

  afterAll(async () => {
    rmSync(before, { recursive: true, force: true });
    await database?.drop();
  });

  it('rewrites the old words into the vocabulary, claiming no more than the row said', async () => {
    const rows = await withClient(
      database.connectionString,
      async (client) =>
        (
          await client.query<{ stage: string; attempt: number; state: string; returned_to: null }>(
            `select stage, attempt, state, returned_to from task_stages
            where task_id = $1 order by stage, attempt`,
            [taskId],
          )
        ).rows,
    );
    expect(rows).toEqual([
      { stage: 'ci_gate', attempt: 1, state: 'returned', returned_to: null },
      { stage: 'code_review', attempt: 1, state: 'returned', returned_to: null },
      { stage: 'implementation', attempt: 1, state: 'running', returned_to: null },
      { stage: 'implementation', attempt: 2, state: 'failed', returned_to: null },
      { stage: 'intake', attempt: 1, state: 'completed', returned_to: null },
      { stage: 'refinement', attempt: 1, state: 'completed', returned_to: null },
    ]);
  });

  it('accepts every word the contracts declare and refuses one they do not', async () => {
    await withClient(database.connectionString, async (client) => {
      let attempt = 10;
      for (const state of taskStageStateSchema.options) {
        attempt += 1;
        await client.query(
          `insert into task_stages (task_id, stage, attempt, state) values ($1, 'probe', $2, $3)`,
          [taskId, attempt, state],
        );
      }
      for (const word of ['entered', 'exited', 'passed']) {
        attempt += 1;
        await expect(
          client.query(
            `insert into task_stages (task_id, stage, attempt, state) values ($1, 'probe', $2, $3)`,
            [taskId, attempt, word],
          ),
        ).rejects.toThrow(/task_stages_state_known/);
      }
    });
  });

  it('refuses a return target on a row that is not a return', async () => {
    await withClient(database.connectionString, async (client) => {
      await expect(
        client.query(
          `insert into task_stages (task_id, stage, attempt, state, returned_to)
           values ($1, 'probe', 99, 'completed', 'implementation')`,
          [taskId],
        ),
      ).rejects.toThrow(/task_stages_returned_to_is_a_return/);
    });
  });
});
