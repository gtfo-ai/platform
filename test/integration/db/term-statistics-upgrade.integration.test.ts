/**
 * Migration 0042's upgrade window (WP-58): an index built before it has no term statistics and no
 * stored listing, and both are **said** rather than guessed until the next index run rebuilds it.
 *
 * Migrates to 0041, writes the index a pre-0042 indexer left (a state row, one document, one
 * chunk), applies 0042, and asserts through the production `PostgresKnowledgeStore`: the commit is
 * forgotten so the next run rebuilds (the 0041 precedent), `readPathWitnesses` answers `null` rather
 * than an empty repository, and a search reports the floor as `no_statistics` and drops **no** term
 * — the behaviour before the floor existed, rather than a floor computed over a count of zero.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Id } from '@platform/contracts';
import { db, knowledge } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, withClient } from '../support/postgres.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/infrastructure/src/db/migrations/', import.meta.url),
);
const STATISTICS_MIGRATION = '0042_kb_term_statistics_and_path_witnesses.sql';

let database: TestDatabase;
let before: string;
let projectId: Id;

describe('migration 0042: an index built before it has no statistics, and says so', () => {
  beforeAll(async () => {
    database = await createTestDatabase('term_statistics_upgrade');
    before = mkdtempSync(join(tmpdir(), 'wp58-migrations-'));
    for (const file of readdirSync(MIGRATIONS)) {
      if (file.endsWith('.sql') && file < STATISTICS_MIGRATION) {
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
      projectId = project.rows[0]?.id as Id;
      await client.query(
        `insert into kb_index_state (project_id, commit_sha, fts_built_at)
         values ($1, 'f1c7ea4', '2026-09-01T00:00:00Z')`,
        [projectId],
      );
      // Two pages that both say `session`: with statistics, `session` would be in every document
      // and dropped; without them it must be searched.
      for (const [path, text] of [
        ['.agentic/knowledge/a.md', 'API / a.md\n\nthe session service'],
        ['.agentic/knowledge/b.md', 'API / b.md\n\na session cookie'],
      ] as const) {
        const document = await client.query<{ id: string }>(
          `insert into kb_documents (project_id, path, frontmatter, tokens)
           values ($1, $2, '{}'::jsonb, 5) returning id`,
          [projectId, path],
        );
        await client.query(
          `insert into kb_chunks (document_id, heading_path, ordinal, "text", tokens)
           values ($1, '', 0, $2, 5)`,
          [document.rows[0]?.id, text],
        );
      }
    });
    await db.runMigrations({ connectionString: database.connectionString });
  }, 180_000);

  afterAll(async () => {
    rmSync(before, { recursive: true, force: true });
    await database?.drop();
  });

  it('forgets the commit, stores no listing, and searches every term under `no_statistics`', async () => {
    const client = new pg.Client({ connectionString: database.connectionString });
    await client.connect();
    try {
      const state = await client.query<{
        commit_sha: string | null;
        term_documents: number | null;
        path_witnesses: string[] | null;
      }>(
        'select commit_sha, term_documents, path_witnesses from kb_index_state where project_id = $1',
        [projectId],
      );
      expect(state.rows[0]).toEqual({
        commit_sha: null,
        term_documents: null,
        path_witnesses: null,
      });

      const store = new knowledge.PostgresKnowledgeStore(client);
      expect(await store.readPathWitnesses(projectId)).toBeNull();
      const result = await store.search({ projectId, terms: ['session'], limit: 10 });
      if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
      expect(result.terms).toEqual({
        kept: ['session'],
        uninformative: [],
        floor: 'no_statistics',
      });
      expect(result.hits.map((hit) => hit.path).sort()).toEqual([
        '.agentic/knowledge/a.md',
        '.agentic/knowledge/b.md',
      ]);
    } finally {
      await client.end();
    }
  });
});
