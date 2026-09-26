/**
 * Migration 0041's upgrade half (WP-57 review round 1): an index built before the migration is
 * re-read once, so a project whose default branch never moves still gets its parser refusals
 * recorded rather than an empty `kb_index_refusals` that reads as "nothing refused" (rule 18).
 *
 * Migrates to 0040 first, writes the index state the old indexer left, applies 0041, and asserts
 * the commit is forgotten while the index stays built (`fts_built_at` untouched, so context packs
 * keep reading it). That the indexer then rebuilds rather than answering `unchanged` is
 * `packages/application/src/knowledge/indexer.test.ts` › "rebuilds an index whose commit is unknown, which is how 0041 hands an upgraded project its refusals".
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, withClient } from '../support/postgres.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/infrastructure/src/db/migrations/', import.meta.url),
);
const REFUSALS_MIGRATION = '0041_context_pack_record_and_index_refusals.sql';

let database: TestDatabase;
let before: string;
let projectId: string;

describe('migration 0041: an index built before it is re-read once', () => {
  beforeAll(async () => {
    database = await createTestDatabase('index_refusal_upgrade');
    before = mkdtempSync(join(tmpdir(), 'wp57-migrations-'));
    for (const file of readdirSync(MIGRATIONS)) {
      if (file.endsWith('.sql') && file < REFUSALS_MIGRATION) {
        cpSync(join(MIGRATIONS, file), join(before, file));
      }
    }
    await db.runMigrations({
      connectionString: database.connectionString,
      migrationsDirectory: before,
    });
    await withClient(database.connectionString, async (client) => {
      const org = await client.query<{ id: string }>(
        "insert into organizations (name) values ('upgrade') returning id",
      );
      const project = await client.query<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
        [org.rows[0]?.id],
      );
      projectId = project.rows[0]?.id as string;
      await client.query(
        `insert into kb_index_state (project_id, commit_sha, fts_built_at)
         values ($1, 'f1c7ea4', '2026-09-01T00:00:00Z')`,
        [projectId],
      );
    });
    await db.runMigrations({ connectionString: database.connectionString });
  }, 180_000);

  afterAll(async () => {
    rmSync(before, { recursive: true, force: true });
    await database?.drop();
  });

  it('forgets the indexed commit and keeps the index built', async () => {
    const state = await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ commit_sha: string | null; built: string }>(
        `select commit_sha, to_char(fts_built_at at time zone 'UTC', 'YYYY-MM-DD') as built
           from kb_index_state where project_id = $1`,
        [projectId],
      );
      return rows[0];
    });
    expect(state).toEqual({ commit_sha: null, built: '2026-09-01' });
  });
});
